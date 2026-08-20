import { TOOL_DEFINITIONS, runTool, type CommandApprover, type ToolDefinition } from "./tools";
import type { SandboxRunner } from "./sandbox";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
}

export interface ChatSession {
  id: string;
  repoUrl: string;
  root: string;
  model: string;
  ollamaUrl: string;
  messages: ChatMessage[];
  createdAt: number;
}

export type ChatEvent =
  | { type: "status"; message: string }
  | { type: "model_delta"; content: string }
  | { type: "model_done"; content: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: string }
  | { type: "error"; message: string };

const SYSTEM_PROMPT = `You are daygle, a helpful software engineering assistant working inside a git repository checkout.

You can inspect and edit code using tools. Respond conversationally — answer questions, explain code, suggest improvements, and make changes when asked.

Available tools:
- list_files(path) — list files/directories under a path
- read_file(path, start_line?, end_line?) — read a file with numbered lines
- search(pattern, path?) — regex-search files for patterns
- write_file(path, content) — create or overwrite a file
- run_command(command) — run a shell command (tests, typecheck, etc.)

Be concise. Read and understand before editing. Make the smallest change that solves the problem.`;

export async function* streamChat(
  session: ChatSession,
  userMessage: string,
  approve?: CommandApprover,
  sandbox?: SandboxRunner,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  session.messages.push({ role: "user", content: userMessage });

  const MAX_STEPS = 20;
  const temperature = 0.3;
  const numCtx = 16384;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) return;

    yield { type: "status", message: `Thinking… (step ${step + 1})` };

    const res = await fetch(`${session.ollamaUrl.replace(/\/+$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: session.model,
        messages: session.messages,
        tools: TOOL_DEFINITIONS,
        stream: true,
        options: { temperature, num_ctx: numCtx },
      }),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      yield { type: "error", message: `Ollama failed (${res.status}): ${text.slice(0, 300)}` };
      return;
    }

    // Stream the response
    const reader = res.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let content = "";
    let rawToolCalls: Array<{ function?: { name?: string; arguments?: unknown } }> | undefined;
    let buffer = "";

    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        return;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const data = JSON.parse(trimmed) as { message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> } };
          const msg = data.message ?? {};
          const delta = typeof msg.content === "string" ? msg.content : "";
          if (delta) {
            content += delta;
            yield { type: "model_delta", content: delta };
          }
          if (msg.tool_calls?.length) rawToolCalls = msg.tool_calls;
        } catch {
          // skip malformed lines
        }
      }
    }
    if (buffer.trim()) {
      try {
        const data = JSON.parse(buffer.trim()) as { message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> } };
        const msg = data.message ?? {};
        const delta = typeof msg.content === "string" ? msg.content : "";
        if (delta) {
          content += delta;
          yield { type: "model_delta", content: delta };
        }
        if (msg.tool_calls?.length) rawToolCalls = msg.tool_calls;
      } catch {
        // skip
      }
    }

    // Parse tool calls
    const toolCalls = (rawToolCalls ?? []).map((call) => {
      const name = call.function?.name ?? "unknown";
      let args: unknown = call.function?.arguments ?? {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      if (typeof args !== "object" || args === null || Array.isArray(args)) args = {};
      return { function: { name, arguments: args as Record<string, unknown> } };
    });

    if (content) {
      session.messages.push({ role: "assistant", content, tool_calls: toolCalls.length ? toolCalls : undefined });
    }

    // No tool calls — model is done responding
    if (toolCalls.length === 0) {
      yield { type: "model_done", content };
      return;
    }

    // Execute each tool call
    for (const call of toolCalls) {
      const name = call.function.name;
      const args = call.function.arguments ?? {};
      yield { type: "tool_start", name, args };

      let result: string;
      try {
        result = await runTool(session.root, name, args, approve, sandbox, signal);
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      yield { type: "tool_result", name, result };
      session.messages.push({ role: "tool", content: result, tool_name: name });
    }
  }

  yield { type: "model_done", content: "" };
}
