import { TOOL_DEFINITIONS, runTool, type CommandApprover, type ToolDefinition } from "./tools";
import type { SandboxRunner } from "./sandbox";

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

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

export class CancelledError extends Error {
  constructor() {
    super("Job cancelled.");
    this.name = "CancelledError";
  }
}

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

const DEFAULT_MAX_STEPS = 40;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_NUM_CTX = 16384;

const DEFAULT_SYSTEM_PROMPT = `You are daygle, a careful software engineering agent working inside a git repository checkout.
Your job is to complete the user's task by inspecting the code and, when appropriate, editing it.

Work in small, verifiable steps. Read and understand before editing.

Available tools:
- list_files(path) — list files/directories under a path (recursive, capped)
- read_file(path, start_line?, end_line?) — read a file with numbered lines (up to 1500)
- search(pattern, path?) — regex-search files, returns matches with line numbers
- write_file(path, content) — create or overwrite a file with full contents
- run_command(command) — run a shell command in the repo (tests, typecheck, git status, etc.)

Rules:
- Make the smallest change that solves the problem. Do not rewrite files unnecessarily.
- Preserve the project's existing style and conventions.
- After editing, verify with the project's typecheck/tests when available.
- Wait for each tool's result before acting on it.
- When finished, respond with a concise summary of what you found and changed, then STOP calling tools.
- Do not commit, push, or open pull requests — the harness handles that after you finish.
- If the task cannot be completed with the available information, explain why and stop.`;

interface RawToolCall {
  function?: { name?: string; arguments?: unknown };
}

function parseToolCalls(raw: RawToolCall[] | undefined): ToolCall[] {
  return (raw ?? []).map((call) => {
    const name = call.function?.name ?? "unknown";
    let args: unknown = call.function?.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      args = {};
    }
    return { function: { name, arguments: args as Record<string, unknown> } };
  });
}

async function chatOnce(
  ollamaUrl: string,
  model: string,
  messages: AgentMessage[],
  tools: ToolDefinition[],
  options: {
    temperature: number;
    numCtx: number;
    signal?: AbortSignal;
    onDelta?: (chunk: string) => void;
  },
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const { temperature, numCtx, signal, onDelta } = options;
  let res: Response;
  try {
    res = await fetch(`${ollamaUrl.replace(/\/+$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        tools,
        stream: true,
        options: { temperature, num_ctx: numCtx },
      }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new CancelledError();
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama /api/chat failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  const isStream =
    contentType.includes("application/x-ndjson") || contentType.includes("text/event-stream");

  // Some servers ignore `stream: true`; fall back to a single JSON body.
  if (!isStream) {
    const data = (await res.json()) as { message?: { content?: string; tool_calls?: RawToolCall[] } };
    const message = data.message ?? {};
    const content = typeof message.content === "string" ? message.content : "";
    if (content) onDelta?.(content);
    return { content, toolCalls: parseToolCalls(message.tool_calls) };
  }

  const reader = res.body?.getReader();
  if (!reader) {
    const data = (await res.json()) as { message?: { content?: string; tool_calls?: RawToolCall[] } };
    const message = data.message ?? {};
    const content = typeof message.content === "string" ? message.content : "";
    if (content) onDelta?.(content);
    return { content, toolCalls: parseToolCalls(message.tool_calls) };
  }

  const decoder = new TextDecoder();
  let content = "";
  let rawToolCalls: RawToolCall[] | undefined;
  let buffer = "";

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let data: { message?: { content?: string; tool_calls?: RawToolCall[] } };
    try {
      data = JSON.parse(trimmed) as typeof data;
    } catch {
      return;
    }
    const message = data.message ?? {};
    const delta = typeof message.content === "string" ? message.content : "";
    if (delta) {
      content += delta;
      onDelta?.(delta);
    }
    if (message.tool_calls?.length) rawToolCalls = message.tool_calls;
  };

  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (signal?.aborted) throw new CancelledError();
      throw err;
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
  }
  if (buffer.trim()) consumeLine(buffer);

  return { content, toolCalls: parseToolCalls(rawToolCalls) };
}

export async function runAgentLoop(opts: {
  root: string;
  task: string;
  model: string;
  ollamaUrl: string;
  emit: (event: AgentEvent) => void;
  approve?: CommandApprover;
  sandbox?: SandboxRunner;
  signal?: AbortSignal;
  config?: AgentConfig;
}): Promise<string> {
  const { root, task, model, ollamaUrl, emit, approve, sandbox, signal } = opts;
  const temperature = opts.config?.temperature ?? DEFAULT_TEMPERATURE;
  const numCtx = opts.config?.numCtx ?? DEFAULT_NUM_CTX;
  const maxSteps = Math.max(1, Math.min(200, opts.config?.maxSteps ?? DEFAULT_MAX_STEPS));
  const systemPrompt = opts.config?.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;

  const throwIfCancelled = () => {
    if (signal?.aborted) throw new CancelledError();
  };

  const messages: AgentMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: task },
  ];

  for (let step = 0; step < maxSteps; step++) {
    throwIfCancelled();
    emit({ type: "status", message: `Thinking… (step ${step + 1}/${maxSteps})` });
    const { content, toolCalls } = await chatOnce(ollamaUrl, model, messages, TOOL_DEFINITIONS, {
      temperature,
      numCtx,
      signal,
      onDelta: (delta) => emit({ type: "model_delta", content: delta }),
    });
    throwIfCancelled();

    if (content) emit({ type: "model", content });

    if (toolCalls.length === 0) {
      return content.trim() || "Task finished.";
    }

    messages.push({ role: "assistant", content, tool_calls: toolCalls });

    for (const call of toolCalls) {
      const name = call.function.name;
      const args = call.function.arguments ?? {};
      emit({ type: "tool_start", name, args });

      let result: string;
      try {
        result = await runTool(root, name, args, approve, sandbox, signal);
        throwIfCancelled();
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      emit({ type: "tool_result", name, result });
      messages.push({ role: "tool", content: result, tool_name: name });
    }
  }

  return "Reached the maximum number of steps without finishing.";
}

export interface ReviewResult {
  verdict: "approved" | "changes_requested";
  text: string;
}

const REVIEW_SYSTEM_PROMPT = `You are a senior software engineer performing a pre-merge code review.
Review the diff for correctness, bugs, security issues, regressions, and style. Be specific and concise; reference exact lines or functions where possible.

Respond in this exact format:
First line: APPROVED or CHANGES REQUESTED
Then: a short summary and, if changes are requested, a numbered list of the concrete issues to fix.`;

/**
 * Reviews a diff with (typically) a different model before the changes are committed.
 * Emits a single `review` event with the verdict and the full review text.
 */
export async function runReview(opts: {
  ollamaUrl: string;
  model: string;
  task: string;
  diff: string;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
  config?: AgentConfig;
}): Promise<ReviewResult> {
  const { ollamaUrl, model, task, diff, emit, signal } = opts;
  const temperature = opts.config?.temperature ?? DEFAULT_TEMPERATURE;
  const numCtx = opts.config?.numCtx ?? DEFAULT_NUM_CTX;

  const user = `Task being implemented:\n${task}\n\nDiff to review:\n\n${diff.slice(0, 60_000)}`;
  const { content } = await chatOnce(
    ollamaUrl,
    model,
    [
      { role: "system", content: REVIEW_SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    [],
    { temperature, numCtx, signal },
  );

  const text = content.trim() || "APPROVED\n(no review content returned)";
  const verdict: ReviewResult["verdict"] = /^\s*APPROVED\b/i.test(text) ? "approved" : "changes_requested";
  emit({ type: "review", verdict, text });
  return { verdict, text };
}
