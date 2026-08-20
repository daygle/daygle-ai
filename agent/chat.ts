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

const TOOL_NAMES = new Set(["list_files", "read_file", "search", "write_file", "run_command"]);

/**
 * Fallback: parse tool calls that models output as raw JSON text
 * instead of using Ollama's structured tool_calls format.
 * Handles patterns like:
 *   {"name": "list_files", "arguments": {"path": "/"}}
 *   ```json{"name": "read_file", "arguments": {"path": "src/main.ts"}}```
 */
function parseTextToolCalls(text: string): Array<{ function: { name: string; arguments: Record<string, unknown> } }> {
  const calls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> = [];
  // Match JSON objects that look like tool calls
  const regex = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[^}]*\})\s*\}/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const name = match[1];
    if (!TOOL_NAMES.has(name)) continue;
    try {
      const args = JSON.parse(match[2]) as Record<string, unknown>;
      calls.push({ function: { name, arguments: args } });
    } catch {
      // skip malformed args
    }
  }
  return calls;
}

const SYSTEM_PROMPT = `You are daygle, a helpful software engineering assistant working inside a git repository checkout.

You can inspect and edit code using tools. Respond conversationally — answer questions, explain code, suggest improvements, and make changes when asked.

Before using a tool, briefly explain what you're about to do. For example:
- "Let me look at the project structure first."
- "I'll search for the login function."
- "I see the issue — let me read that file."
- "I'll fix that and then run the tests."

This helps the user follow your reasoning.

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

    // Parse tool calls — first try structured format, then fallback to text parsing
    let toolCalls = (rawToolCalls ?? []).map((call) => {
      const name = call.function?.name ?? "unknown";
      let args: unknown = call.function?.arguments ?? {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      if (typeof args !== "object" || args === null || Array.isArray(args)) args = {};
      return { function: { name, arguments: args as Record<string, unknown> } };
    });

    // Fallback: if no structured tool calls, try parsing from text content
    if (toolCalls.length === 0 && content) {
      toolCalls = parseTextToolCalls(content);
    }

    // Strip raw JSON tool calls from displayed content (they're shown as cards)
    let displayContent = content;
    if (toolCalls.length > 0) {
      displayContent = content
        .replace(/```(?:json|tool_code)?/gi, "")
        .replace(/\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g, "")
        .trim();
    }

    if (content) {
      session.messages.push({ role: "assistant", content, tool_calls: toolCalls.length ? toolCalls : undefined });
    }

    // No tool calls — model is done responding
    if (toolCalls.length === 0) {
      yield { type: "model_done", content: displayContent };
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
