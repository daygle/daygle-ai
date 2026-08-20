export type AgentEvent =
  | { type: "status"; message: string }
  | { type: "model"; content: string }
  | { type: "model_delta"; content: string }
  | { type: "diff"; stat: string; diff: string }
  | { type: "review"; verdict: "approved" | "changes_requested"; text: string }
  | { type: "qa"; command: string; output: string; passed: boolean; skipped?: boolean }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: string }
  | { type: "approval_requested"; requestId: string; command: string }
  | { type: "error"; message: string }
  | { type: "cancelled"; message: string }
  | { type: "done"; summary: string; prUrl?: string; branch?: string; changedFiles?: string[]; pending?: boolean };

export const DEFAULT_AGENT_URL = "http://localhost:8787";

export type RunStatus = "running" | "done" | "error" | "cancelled";

export interface AgentConfig {
  temperature?: number;
  numCtx?: number;
  maxSteps?: number;
  systemPrompt?: string;
  reviewModel?: string;
  maxReviewRounds?: number;
  qaCommand?: string;
  maxQaRounds?: number;
  workspace?: boolean;
}

export interface AgentJobRequest {
  repoUrl: string;
  task: string;
  model: string;
  baseBranch: string;
  ollamaUrl: string;
  config?: AgentConfig;
}

export interface AgentRunSummary {
  id: string;
  repoUrl: string;
  task: string;
  model: string;
  status: RunStatus;
  prUrl?: string;
  createdAt: number;
  finishedAt?: number;
}

export interface AgentRunDetail {
  id: string;
  repoUrl: string;
  task: string;
  model: string;
  baseBranch: string;
  ollamaUrl: string;
  status: RunStatus;
  events: AgentEvent[];
  prUrl?: string;
  summary?: string;
  createdAt: number;
  finishedAt?: number;
}

function strip(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export async function agentHealth(
  serverUrl: string,
): Promise<{ ok: boolean; gh: boolean; app: boolean; token: boolean; sandbox: string | null }> {
  const res = await fetch(`${strip(serverUrl)}/api/health`);
  if (!res.ok) throw new Error("Agent server not reachable");
  return (await res.json()) as { ok: boolean; gh: boolean; app: boolean; token: boolean; sandbox: string | null };
}

export async function getGithubToken(serverUrl: string): Promise<string> {
  const res = await fetch(`${strip(serverUrl)}/api/github-token`);
  if (!res.ok) throw new Error("Failed to load token");
  const data = (await res.json()) as { token: string };
  return data.token;
}

export async function saveGithubToken(serverUrl: string, token: string): Promise<void> {
  const res = await fetch(`${strip(serverUrl)}/api/github-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error("Failed to save token");
}

export async function startAgentJob(
  serverUrl: string,
  payload: AgentJobRequest,
): Promise<{ id: string }> {
  const res = await fetch(`${strip(serverUrl)}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to start job (${res.status}) ${text}`);
  }
  return (await res.json()) as { id: string };
}

export async function cancelAgentJob(serverUrl: string, id: string): Promise<void> {
  const res = await fetch(`${strip(serverUrl)}/api/jobs/${id}/cancel`, { method: "POST" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to cancel job (${res.status}) ${text}`);
  }
}

export interface ModelUpdateInfo {
  name: string;
  updateAvailable: boolean;
  localDigest?: string;
  remoteDigest?: string;
  error?: string;
}

/** Asks the local agent server to compare installed vs registry digests for each model. */
export async function checkModelUpdates(
  serverUrl: string,
  ollamaUrl: string,
  names: string[],
): Promise<ModelUpdateInfo[]> {
  const params = new URLSearchParams({ ollamaUrl: strip(ollamaUrl), names: names.join(",") });
  const res = await fetch(`${strip(serverUrl)}/api/model-updates?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to check model updates (${res.status})`);
  const data = (await res.json()) as { results: ModelUpdateInfo[] };
  return data.results ?? [];
}

export interface WorkspaceStatus {
  connected: boolean;
  repoUrl?: string;
  owner?: string;
  repo?: string;
  branch?: string;
  changedFiles?: string[];
  diffStat?: string;
  diff?: string;
  lastCommit?: { hash: string; message: string; date: string } | null;
}

export async function workspaceStatus(serverUrl: string): Promise<WorkspaceStatus> {
  const res = await fetch(`${strip(serverUrl)}/api/workspace`);
  if (!res.ok) throw new Error(`Failed to read workspace (${res.status})`);
  return (await res.json()) as WorkspaceStatus;
}

export async function connectWorkspace(serverUrl: string, repoUrl: string): Promise<WorkspaceStatus> {
  const res = await fetch(`${strip(serverUrl)}/api/workspace/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to connect workspace (${res.status}) ${text}`);
  }
  return (await res.json()) as WorkspaceStatus;
}

export async function pullWorkspace(serverUrl: string): Promise<WorkspaceStatus> {
  const res = await fetch(`${strip(serverUrl)}/api/workspace/pull`, { method: "POST" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Pull failed (${res.status}) ${text}`);
  }
  return (await res.json()) as WorkspaceStatus;
}

export async function commitWorkspace(serverUrl: string, message: string): Promise<WorkspaceStatus> {
  const res = await fetch(`${strip(serverUrl)}/api/workspace/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Commit failed (${res.status}) ${text}`);
  }
  return (await res.json()) as WorkspaceStatus;
}

export async function pushWorkspace(serverUrl: string): Promise<WorkspaceStatus> {
  const res = await fetch(`${strip(serverUrl)}/api/workspace/push`, { method: "POST" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Push failed (${res.status}) ${text}`);
  }
  return (await res.json()) as WorkspaceStatus;
}

export async function openWorkspacePr(
  serverUrl: string,
  title: string,
  body?: string,
): Promise<{ prUrl: string }> {
  const res = await fetch(`${strip(serverUrl)}/api/workspace/pr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, body }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PR failed (${res.status}) ${text}`);
  }
  return (await res.json()) as { prUrl: string };
}

export async function listAgentHistory(serverUrl: string): Promise<AgentRunSummary[]> {
  const res = await fetch(`${strip(serverUrl)}/api/jobs`);
  if (!res.ok) throw new Error(`Failed to list history (${res.status})`);
  const data = (await res.json()) as { jobs: AgentRunSummary[] };
  return data.jobs ?? [];
}

export async function getAgentJob(serverUrl: string, id: string): Promise<AgentRunDetail> {
  const res = await fetch(`${strip(serverUrl)}/api/jobs/${id}`);
  if (!res.ok) throw new Error(`Failed to load run (${res.status})`);
  const data = (await res.json()) as { job: AgentRunDetail };
  return data.job;
}

export function openAgentEvents(
  serverUrl: string,
  id: string,
  onEvent: (event: AgentEvent) => void,
): () => void {
  const source = new EventSource(`${strip(serverUrl)}/api/jobs/${id}/events`);
  source.onmessage = (event) => {
    try {
      const parsed = JSON.parse(event.data) as AgentEvent;
      onEvent(parsed);
      if (parsed.type === "done" || parsed.type === "error" || parsed.type === "cancelled") {
        source.close();
      }
    } catch {
      // ignore malformed events
    }
  };
  source.onerror = () => source.close();
  return () => source.close();
}

export async function resolveApproval(
  serverUrl: string,
  requestId: string,
  decision: "approve" | "deny",
): Promise<void> {
  const res = await fetch(`${strip(serverUrl)}/api/approvals/${requestId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  if (!res.ok) throw new Error(`Failed to resolve approval (${res.status})`);
}
