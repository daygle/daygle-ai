import type { GenOptions } from "./genOptions";
import { sameHostUrl } from "./utils";

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

export const DEFAULT_AGENT_URL = sameHostUrl(8787, "/api/agent");

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
  /** When true, the reviewer reads code and runs checks before deciding. */
  agenticReview?: boolean;
  maxReviewSteps?: number;
  /** Defaults to true; set false to skip the test-generation pass. */
  generateTests?: boolean;
  maxTestGenSteps?: number;
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

/**
 * Asks the agent server to run a trivial command through the active sandbox
 * backend, proving it works end-to-end (not just that one was detected).
 */
export async function checkSandbox(
  serverUrl: string,
): Promise<{ ok: boolean; name: string | null; output: string }> {
  const res = await fetch(`${strip(serverUrl)}/api/sandbox/check`);
  if (!res.ok) throw new Error(`Sandbox check failed (${res.status})`);
  return (await res.json()) as { ok: boolean; name: string | null; output: string };
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

export interface AuditEntry {
  timestamp?: string;
  scope?: string;
  type?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: string;
  diff?: string;
}

export async function getAuditLog(serverUrl: string, limit = 200): Promise<AuditEntry[]> {
  const res = await fetch(`${strip(serverUrl)}/api/audit?limit=${Math.min(500, Math.max(1, limit))}`);
  if (!res.ok) throw new Error(`Failed to load audit log (${res.status})`);
  const data = (await res.json()) as { entries: AuditEntry[] };
  return data.entries ?? [];
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
  images?: string[];
  imageMimeTypes?: string[];
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
}

export interface ChatImage {
  data: string;
  mimeType: string;
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
  /** True when a generation is still streaming server-side (reconnect to it). */
  busy?: boolean;
}

export interface ChatCheckpoint {
  id: string;
  createdAt: number;
}

export interface ChatWorkspace {
  files: string[];
  changedFiles: string[];
  stat: string;
  diff: string;
  checkpoints: ChatCheckpoint[];
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

export async function getChatWorkspace(serverUrl: string, sessionId: string): Promise<ChatWorkspace> {
  const res = await fetch(`${strip(serverUrl)}/api/chat/sessions/${sessionId}/workspace`);
  if (!res.ok) throw new Error(`Failed to load workspace (${res.status})`);
  return (await res.json()) as ChatWorkspace;
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
  image?: ChatImage,
): () => void {
  const controller = new AbortController();
  fetch(`${strip(serverUrl)}/api/chat/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, image }),
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
  | { type: "qa"; command: string; output: string; passed: boolean; skipped?: boolean }
  | { type: "review"; verdict: "approved" | "changes_requested"; text: string }
  | { type: "verify_done" }
  | { type: "error"; message: string };

export interface VerifyOptions {
  /** Model to use for the AI review. Defaults to the chat's model server-side. */
  reviewModel?: string;
  /** Override the auto-detected QA command (e.g. "npm test"). */
  qaCommand?: string;
  /** Set false to run only the QA gate and skip the AI review. */
  review?: boolean;
  /** Set false to use the quick diff-only review instead of the agentic reviewer. */
  agentic?: boolean;
}

/**
 * Runs the on-demand verification pass for a chat session (QA gate + optional
 * second-model review) and streams the resulting `qa`/`review`/`status`/`error`
 * events. Returns a cancel function.
 */
export function verifyChat(
  serverUrl: string,
  sessionId: string,
  onEvent: (event: ChatEvent) => void,
  options?: VerifyOptions,
): () => void {
  const controller = new AbortController();
  fetch(`${strip(serverUrl)}/api/chat/sessions/${sessionId}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options ?? {}),
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        onEvent({ type: "error", message: `Verify failed (${res.status}) ${text}` });
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
            onEvent(JSON.parse(trimmed.slice(6)) as ChatEvent);
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

/** Reverts the live chat checkout to the checkpoint captured before its latest task. */
export async function rollbackChat(serverUrl: string, sessionId: string, checkpointId?: string): Promise<void> {
  const suffix = checkpointId ? `/${encodeURIComponent(checkpointId)}` : "";
  const res = await fetch(`${strip(serverUrl)}/api/chat/sessions/${sessionId}/revert${suffix}`, { method: "POST" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to revert workspace (${res.status}) ${text}`);
  }
}

/**
 * Cancels an in-flight chat generation server-side. Works even when this client
 * isn't the one attached to the stream (e.g. after navigating away and back).
 */
export async function cancelChat(serverUrl: string, sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`${strip(serverUrl)}/api/chat/sessions/${sessionId}/cancel`, { method: "POST" });
    if (!res.ok) return false;
    const data = (await res.json()) as { cancelled?: boolean };
    return Boolean(data.cancelled);
  } catch {
    return false;
  }
}

export async function updateChatModel(
  serverUrl: string,
  sessionId: string,
  model: string,
): Promise<void> {
  const res = await fetch(`${strip(serverUrl)}/api/chat/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) throw new Error(`Failed to update model (${res.status})`);
}
