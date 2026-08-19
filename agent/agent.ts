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
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: string }
  | { type: "approval_requested"; requestId: string; command: string }
  | { type: "error"; message: string }
  | { type: "cancelled"; message: string }
  | { type: "done"; summary: string; prUrl?: string; branch?: string; changedFiles?: string[] };

export class CancelledError extends Error {
  constructor() {
    super("Job cancelled.");
    this.name = "CancelledError";
  }
}

const MAX_STEPS = 40;

const SYSTEM_PROMPT = `You are daygle, a careful software engineering agent working inside a git repository checkout.
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

async function chatOnce(
  ollamaUrl: string,
  model: string,
  messages: AgentMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  let res: Response;
  try {
    res = await fetch(`${ollamaUrl.replace(/\/+$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        tools,
        stream: false,
        options: { temperature: 0.2, num_ctx: 16384 },
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

  const data = (await res.json()) as {
    message?: { content?: string; tool_calls?: RawToolCall[] };
  };
  const message = data.message ?? {};
  const content = typeof message.content === "string" ? message.content : "";
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call) => {
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

  return { content, toolCalls };
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
}): Promise<string> {
  const { root, task, model, ollamaUrl, emit, approve, sandbox, signal } = opts;

  const throwIfCancelled = () => {
    if (signal?.aborted) throw new CancelledError();
  };

  const messages: AgentMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: task },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    throwIfCancelled();
    emit({ type: "status", message: `Thinking… (step ${step + 1}/${MAX_STEPS})` });
    const { content, toolCalls } = await chatOnce(ollamaUrl, model, messages, TOOL_DEFINITIONS, signal);
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
