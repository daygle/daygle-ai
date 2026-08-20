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

/** User-tunable Ollama generation parameters, applied per request. */
export interface GenOptions {
  temperature?: number;
  num_ctx?: number;
  top_p?: number;
  top_k?: number;
  repeat_penalty?: number;
  keep_alive?: string;
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
  options?: GenOptions;
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
 * Parse a clarification request from model output text.
 * Looks for a JSON object with a "clarification" key containing a question and options.
 * Returns null if no clarification request is found.
 */
function parseClarificationRequest(text: string): { question: string; options: Array<{ label: string; description?: string }> } | null {
  // Look for JSON objects with a "clarification" key
  const regex = /\{\s*"clarification"\s*:\s*\{([^}]+)\}\s*\}/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const obj = JSON.parse(`{"clarification": {${match[1]}}}`) as {
        clarification: { question: string; options: Array<{ label: string; description?: string }> };
      };
      if (obj.clarification?.question && Array.isArray(obj.clarification?.options) && obj.clarification.options.length > 0) {
        return obj.clarification;
      }
    } catch {
      // skip malformed JSON
    }
  }
  return null;
}

/**
 * Fallback: parse tool calls that models output as raw text
 * instead of using Ollama's structured tool_calls format.
 * Handles patterns like:
 *   {"name": "list_files", "arguments": {"path": "/"}}
 *   ```json{"name": "read_file", "arguments": {"path": "src/main.ts"}}```
 *   bash list_files("src")
 *   list_files("src")
 *   list_files({path: "src"})
 */
function parseTextToolCalls(text: string): Array<{ function: { name: string; arguments: Record<string, unknown> } }> {
  const calls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> = [];

  // First: try to match JSON objects that look like tool calls
  const jsonRegex = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[^}]*\})\s*\}/g;
  let match;
  while ((match = jsonRegex.exec(text)) !== null) {
    const name = match[1];
    if (!TOOL_NAMES.has(name)) continue;
    try {
      const args = JSON.parse(match[2]) as Record<string, unknown>;
      calls.push({ function: { name, arguments: args } });
    } catch {
      // skip malformed args
    }
  }

  // Second: if no JSON calls found, try to match bash-style calls like:
  //   bash list_files("src")
  //   list_files("src")
  //   list_files({path: "src"})
  if (calls.length === 0) {
    const bashRegex = /(?:bash\s+)?([a-z_]+)\s*\(([^)]*)\)/gi;
    while ((match = bashRegex.exec(text)) !== null) {
      const name = match[1].toLowerCase();
      if (!TOOL_NAMES.has(name)) continue;

      let args: Record<string, unknown> = {};
      const argStr = match[2].trim();

      if (argStr) {
        // Try JSON object format: {path: "src"} or {"path": "src"}
        const objMatch = argStr.match(/^\{(.*)\}$/);
        if (objMatch) {
          try {
            // Try to parse as JSON (handle unquoted keys)
            const jsonStr = objMatch[1].replace(/([a-z_]+):/gi, '"$1":');
            args = JSON.parse(`{${jsonStr}}`) as Record<string, unknown>;
          } catch {
            // Try simpler key=value parsing
            const kvPairs = objMatch[1].split(',');
            for (const kv of kvPairs) {
              const [key, ...valueParts] = kv.split(':');
              if (key) {
                const value = valueParts.join(':').trim().replace(/^['"]|['"]$/g, '');
                args[key.trim()] = value;
              }
            }
          }
        } else {
          // Simple string argument: list_files("src")
          const strMatch = argStr.match(/^['"](.*)['"]$/);
          if (strMatch) {
            // First positional arg maps to the main parameter
            if (name === 'list_files' || name === 'read_file') args.path = strMatch[1];
            else if (name === 'search') args.pattern = strMatch[1];
            else if (name === 'write_file') args.path = strMatch[1];
            else if (name === 'run_command') args.command = strMatch[1];
          } else {
            // Unquoted string
            if (name === 'list_files' || name === 'read_file') args.path = argStr;
            else if (name === 'search') args.pattern = argStr;
            else if (name === 'write_file') args.path = argStr;
            else if (name === 'run_command') args.command = argStr;
          }
        }
      }      calls.push({ function: { name, arguments: args } });
    }
  }

  // Third: catch "bash cd <dir> <command>" patterns and convert to run_command
  // e.g. "bash cd web vite" -> run_command("cd web && vite")
  if (calls.length === 0) {
    const cdRegex = /(?:bash\s+)?cd\s+(\S+)\s+(.+)/gi;
    while ((match = cdRegex.exec(text)) !== null) {
      const dir = match[1];
      const cmd = match[2].trim();
      if (cmd && !cmd.startsWith('{')) {
        calls.push({ function: { name: 'run_command', arguments: { command: `cd ${dir} && ${cmd}` } } });
      }
    }
  }

  return calls;
}

export const SYSTEM_PROMPT = `You are daygle, a helpful software engineering assistant working inside a git repository checkout.

You have tools to inspect and edit the code — listing files, reading files, searching, writing files, and running shell commands. Use them by making an actual tool call; the system runs it and returns the result to you.

CRITICAL: Never write tool calls or shell commands as text. Do NOT type things like:
- "list_files()"
- "bash list_files()"
- "bash cd web vite"
- Any JSON or code snippet describing a call
These do nothing — they are just text. To use a tool you MUST invoke it through the tool interface, not print it. When you are not calling a tool, just talk normally.

Available tools:
- list_files(path) — list files/directories under a path
- read_file(path, start_line?, end_line?) — read a file with numbered lines
- search(pattern, path?) — regex-search files for patterns
- write_file(path, content) — create or overwrite a file
- run_command(command) — run a shell command (tests, typecheck, etc.)
  IMPORTANT: For commands that need to run in a subdirectory, use "cd <dir> && <command>" as a single command string.

When you are unsure how to proceed, ask for clarification by outputting a JSON object in your response like this:
{"clarification": {"question": "Your question here", "options": [{"label": "Option A", "description": "Description of option A"}, {"label": "Option B", "description": "Description of option B"}]}}
The system will display these options to the user and let them choose. Wait for their response before proceeding.

A good turn reads like: one short sentence about what you're doing ("Let me look at the project structure."), then the real tool call, then your reply once the result comes back.

Be concise. Read and understand before editing. Make the smallest change that solves the problem.`;

export const CHAT_ONLY_SYSTEM_PROMPT = `You are daygle, a helpful, concise assistant. Answer questions, explain concepts, and help with coding by writing and discussing code inline. You are not connected to a repository, so you cannot read or modify files — if the user needs you to work inside a codebase, suggest they connect a repository.`;

export async function* streamChat(
  session: ChatSession,
  userMessage: string,
  approve?: CommandApprover,
  sandbox?: SandboxRunner,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  // A session with a checkout gets the tool-using coding prompt; a repo-less
  // session is a plain conversation (no tools).
  const hasRepo = Boolean(session.root);
  if (!session.messages.some((m) => m.role === "system")) {
    session.messages.unshift({ role: "system", content: hasRepo ? SYSTEM_PROMPT : CHAT_ONLY_SYSTEM_PROMPT });
  }
  session.messages.push({ role: "user", content: userMessage });

  const MAX_STEPS = 20;
  // User-tunable generation options, falling back to sensible defaults.
  const opts = session.options ?? {};
  const genOptions: Record<string, number> = {
    temperature: opts.temperature ?? 0.3,
    num_ctx: opts.num_ctx ?? 16384,
  };
  if (typeof opts.top_p === "number") genOptions.top_p = opts.top_p;
  if (typeof opts.top_k === "number") genOptions.top_k = opts.top_k;
  if (typeof opts.repeat_penalty === "number") genOptions.repeat_penalty = opts.repeat_penalty;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) return;

    yield { type: "status", message: `Thinking… (Step ${step + 1})` };

    const res = await fetch(`${session.ollamaUrl.replace(/\/+$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: session.model,
        messages: session.messages,
        tools: hasRepo ? TOOL_DEFINITIONS : undefined,
        stream: true,
        keep_alive: opts.keep_alive,
        options: genOptions,
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

    // Parse tool calls — first try structured format, then fallback to text parsing.
    // Repo-less sessions are pure conversation, so tools are ignored entirely.
    let toolCalls = hasRepo
      ? (rawToolCalls ?? []).map((call) => {
          const name = call.function?.name ?? "unknown";
          let args: unknown = call.function?.arguments ?? {};
          if (typeof args === "string") {
            try { args = JSON.parse(args); } catch { args = {}; }
          }
          if (typeof args !== "object" || args === null || Array.isArray(args)) args = {};
          return { function: { name, arguments: args as Record<string, unknown> } };
        })
      : [];

    // Fallback: if no structured tool calls, try parsing from text content
    if (hasRepo && toolCalls.length === 0 && content) {
      toolCalls = parseTextToolCalls(content);
    }

    // Strip raw tool calls from displayed content (they're shown as cards)
    let displayContent = content;
    if (toolCalls.length > 0) {
      displayContent = content
        .replace(/```(?:json|tool_code)?/gi, "")
        .replace(/\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g, "")
        // Strip example output objects like: { "file": "...", "line": 12 }
        .replace(/\{\s*"file"\s*:\s*"[^"]+"\s*,\s*"line"\s*:\s*\d+\s*\}/g, "")
        // Strip bash-style tool calls like: bash list_files("src")
        .replace(/(?:bash\s+)?(?:list_files|read_file|search|write_file|run_command)\s*\([^)]*\)/gi, "")
        // Strip bash cd patterns like: bash cd web vite
        .replace(/(?:bash\s+)?cd\s+\S+\s+.+/gi, "")
        .trim();
    }

    if (content) {
      session.messages.push({ role: "assistant", content, tool_calls: toolCalls.length ? toolCalls : undefined });
    }

    // Check for clarification request in the model output
    const clarificationRequest = parseClarificationRequest(content);
    if (clarificationRequest && toolCalls.length === 0) {
      const requestId = `clar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      // Strip the clarification JSON from display content
      const cleanedContent = content.replace(/\{\s*"clarification"\s*:\s*\{[^}]+\}\s*\}/g, "").trim();
      if (cleanedContent) {
        yield { type: "model_done", content: cleanedContent };
      }
      yield { type: "clarification_requested", requestId, question: clarificationRequest.question, options: clarificationRequest.options };
      return;
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
