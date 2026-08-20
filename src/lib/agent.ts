import type { GenOptions } from "./genOptions";

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

export interface ChatSessionInfo {
  id: string;
  repoUrl: string;
}

export interface ChatSummary {
  id: string;
  repoUrl: string;
  model: string;
  title: string;
  messageCount: number;
  createdAt: number;
  lastActivity: number;
}

export interface StoredChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
}

export interface StoredChat {
  id: string;
  repoUrl: string;
  model: string;
  ollamaUrl: string;
  title: string;
  messages: StoredChatMessage[];
  createdAt: number;
  lastActivity: number;
}

/** Lists past chat conversations (persisted transcripts), newest first. */
export async function listChatSessions(serverUrl: string): Promise<ChatSummary[]> {
  const res = await fetch(`${strip(serverUrl)}/api/chat/sessions`);
  if (!res.ok) throw new Error(`Failed to list chats (${res.status})`);
  const data = (await res.json()) as { sessions: ChatSummary[] };
  return data.sessions ?? [];
}

/** Loads a single conversation's full transcript for display / resuming. */
export async function getChatSession(serverUrl: string, id: string): Promise<StoredChat> {
  const res = await fetch(`${strip(serverUrl)}/api/chat/sessions/${id}`);
  if (!res.ok) throw new Error(`Failed to load chat (${res.status})`);
  const data = (await res.json()) as { chat: StoredChat };
  return data.chat;
}

export async function deleteChatSession(serverUrl: string, id: string): Promise<void> {
  const res = await fetch(`${strip(serverUrl)}/api/chat/sessions/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete chat (${res.status})`);
}

export async function createChatSession(
  serverUrl: string,
  repoUrl: string,
  model: string,
  ollamaUrl: string,
  options?: GenOptions,
): Promise<ChatSessionInfo> {
  const res = await fetch(`${strip(serverUrl)}/api/chat/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl, model, ollamaUrl, options }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to create chat session (${res.status}) ${text}`);
  }
  return (await res.json()) as ChatSessionInfo;
}

export function sendChatMessage(
  serverUrl: string,
  sessionId: string,
  message: string,
  onEvent: (event: ChatEvent) => void,
): () => void {
  const controller = new AbortController();
  fetch(`${strip(serverUrl)}/api/chat/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        onEvent({ type: "error", message: `Failed (${res.status}) ${text}` });
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(trimmed.slice(6)) as ChatEvent;
            onEvent(event);
          } catch {
            // skip
          }
        }
      }
    })
    .catch((err) => {
      if (err.name !== "AbortError") {
        onEvent({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    });
  return () => controller.abort();
}

export type ChatEvent =
  | { type: "status"; message: string }
  | { type: "model_delta"; content: string }
  | { type: "model_done"; content: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: string; diff?: string }
  | { type: "approval_requested"; requestId: string; command: string }
  | { type: "approval_resolved"; requestId: string; decision: "approve" | "deny" }
  | { type: "clarification_requested"; requestId: string; question: string; options: Array<{ label: string; description?: string }> }
  | { type: "error"; message: string };

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
