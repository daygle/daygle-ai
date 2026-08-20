import fs from "node:fs";
import path from "node:path";
import { TOOL_DEFINITIONS, runTool, type CommandApprover } from "./tools";
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
  lastActivity: number;
}

export type ChatEvent =
  | { type: "status"; message: string }
  | { type: "model_delta"; content: string }
  | { type: "model_done"; content: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: string; diff?: string }
  | { type: "approval_requested"; requestId: string; command: string }
  | { type: "approval_resolved"; requestId: string; decision: "approve" | "deny" }
  | { type: "error"; message: string };

/**
 * Compact line-level diff (LCS) between two file versions, used to show the
 * user exactly what a write_file changed instead of just "wrote N bytes".
 * Lines are prefixed with " " (context), "+" (added), or "-" (removed).
 */
function lineDiff(oldText: string, newText: string): string {
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  // Guard against O(n*m) blow-up on very large files.
  if (n > 2000 || m > 2000) return `@@ file replaced (${n} → ${m} lines) @@`;

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(` ${a[i]}`); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(`-${a[i]}`); i++; }
    else { out.push(`+${b[j]}`); j++; }
  }
  while (i < n) out.push(`-${a[i++]}`);
  while (j < m) out.push(`+${b[j++]}`);

  const MAX = 400;
  if (out.length > MAX) return `${out.slice(0, MAX).join("\n")}\n… (${out.length - MAX} more lines)`;
  return out.join("\n") || "(no changes)";
}

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

export const SYSTEM_PROMPT = `You are daygle, a helpful software engineering assistant working inside a git repository checkout.

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
  // Ensure the model always gets its system prompt (which tells it to narrate
  // what it's doing before each tool call), so the chat reads conversationally.
  if (!session.messages.some((m) => m.role === "system")) {
    session.messages.unshift({ role: "system", content: SYSTEM_PROMPT });
  }
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

      // For file writes, snapshot the previous contents so we can show a diff.
      let before: string | undefined;
      if (name === "write_file" && typeof args.path === "string") {
        try {
          before = fs.readFileSync(path.resolve(session.root, args.path), "utf8");
        } catch {
          before = ""; // new file
        }
      }

      let result: string;
      try {
        result = await runTool(session.root, name, args, approve, sandbox, signal);
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      let diff: string | undefined;
      if (name === "write_file" && before !== undefined && typeof args.content === "string" && !result.startsWith("Error")) {
        diff = lineDiff(before, args.content);
      }

      yield { type: "tool_result", name, result, diff };
      session.messages.push({ role: "tool", content: result, tool_name: name });
    }
  }

  yield { type: "model_done", content: "" };
}
