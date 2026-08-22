import fs from "node:fs";
import path from "node:path";
import { TOOL_DEFINITIONS, runTool, type CommandApprover } from "./tools";
import type { SandboxRunner } from "./sandbox";
import type { ChatProvider } from "./providers";

export interface ChatMessage {
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

/** User-tunable Ollama generation parameters, applied per request. */
export interface GenOptions {
  temperature?: number;
  num_ctx?: number;
  top_p?: number;
  top_k?: number;
  repeat_penalty?: number;
  keep_alive?: string;
  num_thread?: number;
  num_batch?: number;
  num_gpu?: number;
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
  /** True while a generation is streaming, so a reconnecting client can resume. */
  busy?: boolean;
  /** Fallback model used when the primary model fails. */
  fallbackModel?: string;
  /** AI-generated title for the chat session. */
  title?: string;
  /** Chat provider — when set, used instead of the raw Ollama fetch. */
  provider?: ChatProvider;
}

export type ChatEvent =
  | { type: "status"; message: string }
  | { type: "model_delta"; content: string }
  | { type: "model_done"; content: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: string; diff?: string }
  | { type: "diff_preview"; name: string; path: string; diff: string; requestId: string }
  | { type: "approval_requested"; requestId: string; command: string }
  | { type: "approval_resolved"; requestId: string; decision: "approve" | "deny" }
  | { type: "clarification_requested"; requestId: string; question: string; options: Array<{ label: string; description?: string }> }
  // Verification events - emitted by the on-demand "Verify" action, not the
  // normal chat stream: a QA gate result and an optional second-model review.
  | { type: "qa"; command: string; output: string; passed: boolean; skipped?: boolean }
  | { type: "review"; verdict: "approved" | "changes_requested"; text: string }
  | { type: "verify_done" }
  | { type: "workspace_update"; files: string[]; changedFiles: string[]; diff: string }
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

const TOOL_NAMES = new Set(["list_files", "read_file", "search", "write_file", "str_replace", "run_command"]);

/**
 * Normalize a keep_alive value for Ollama. Ollama accepts either a Go duration
 * string ("5m", "1h30m") or a number of seconds (-1 = keep loaded forever,
 * 0 = unload immediately). A bare integer like "-1" is NOT a valid duration
 * string ("missing unit in duration"), so send those as numbers.
 */
function normalizeKeepAlive(value: string | undefined): string | number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

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
            else if (name === 'write_file' || name === 'str_replace') args.path = strMatch[1];
            else if (name === 'run_command') args.command = strMatch[1];
          } else {
            // Unquoted string
            if (name === 'list_files' || name === 'read_file') args.path = argStr;
            else if (name === 'search') args.pattern = argStr;
            else if (name === 'write_file' || name === 'str_replace') args.path = argStr;
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

You have tools to inspect and edit the code - listing files, reading files, searching, writing files, and running shell commands. Use them by making an actual tool call; the system runs it and returns the result to you.

CRITICAL: Never write tool calls or shell commands as text. Do NOT type things like:
- "list_files()"
- "bash list_files()"
- "bash cd web vite"
- Any JSON or code snippet describing a call
These do nothing - they are just text. To use a tool you MUST invoke it through the tool interface, not print it. When you are not calling a tool, just talk normally.

Available tools:
- list_files(path) - list files/directories under a path; use the exact nested path returned (for example api/src, not src)
- read_file(path, start_line?, end_line?) - read a file with numbered lines
- read_headers(paths, lines?) - read the first N lines (default 40) of one or more files to see imports, exports, and type definitions. Use this BEFORE editing to understand module boundaries and dependencies.
- search(pattern, path?, semantic?) - regex-search files; use semantic=true for local embedding retrieval with a lexical fallback when exact names are unknown. Use exact repository paths from list_files; do not assume a root-level src directory.
- write_file(path, content) - create or overwrite a file with its COMPLETE contents
- str_replace(path, old_string, new_string, replace_all?) - replace exact text in place
- run_command(command) - run a shell command (tests, typecheck, etc.) through the command sandbox; without one, execution is denied unless trusted host fallback is explicitly enabled.
  IMPORTANT: For commands that need to run in a subdirectory, use "cd <dir> && <command>" as a single command string.

Before editing any file, use read_headers to check its imports and exports so you understand how it connects to the rest of the codebase.
Use str_replace for small, targeted edits (find-and-replace, fixing a line). Only use write_file for a new file or a full rewrite, and include every line.

When you are unsure how to proceed, ask for clarification by outputting a JSON object in your response like this:
{"clarification": {"question": "Your question here", "options": [{"label": "Option A", "description": "Description of option A"}, {"label": "Option B", "description": "Description of option B"}]}}
The system will display these options to the user and let them choose. Wait for their response before proceeding.

A good turn reads like: one short sentence about what you're doing ("Let me look at the project structure."), then the real tool call, then your reply once the result comes back.

Be concise. Read and understand before editing. Make the smallest change that solves the problem.`;

export const CHAT_ONLY_SYSTEM_PROMPT = `You are daygle, a helpful, concise assistant. Answer questions, explain concepts, and help with coding by writing and discussing code inline. You are not connected to a repository, so you cannot read or modify files - if the user needs you to work inside a codebase, suggest they connect a repository.`;

const MAX_CHAT_CONTEXT_CHARS = 64_000;
const MIN_NUM_CTX = 4096;
const MAX_NUM_CTX = 131072;

/**
 * Keep long chats usable without throwing away the durable transcript. The
 * request gets a compact local summary of older turns plus complete recent
 * turns; the full history remains available for the UI and persistence.
 */
/** Token-aware size estimate for chat messages. */
function estimateChatTokens(message: ChatMessage): number {
  const textLen = message.content.length;
  const jsonLen = JSON.stringify(message.tool_calls ?? []).length;
  const imageTokens = message.images?.length ? message.images.length * 800 : 0; // ~800 tokens per image
  const isCode = message.content.includes("```") || message.content.includes(";");
  const charsPerToken = isCode ? 3.2 : 4.2;
  return Math.ceil(textLen / charsPerToken) + Math.ceil(jsonLen / 3) + imageTokens;
}

function compactMessages(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  const size = (message: ChatMessage) => estimateChatTokens(message);
  const total = messages.reduce((sum, message) => sum + size(message), 0);
  if (total <= maxChars) return messages;

  const system = messages.find((message) => message.role === "system");
  const rest = messages.filter((message) => message !== system);
  const recent: ChatMessage[] = [];
  let recentChars = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    const message = rest[i];
    const messageSize = size(message);
    if (recentChars + messageSize > Math.floor(maxChars * 0.72) && recent.length > 0) break;
    recent.unshift(message);
    recentChars += messageSize;
  }
  while (recent[0]?.role === "tool") recent.shift();

  const omitted = rest.slice(0, rest.length - recent.length);
  const summary = omitted
    .map((message) => `${message.role}${message.tool_name ? `:${message.tool_name}` : ""}: ${message.content.replace(/\s+/g, " ").slice(0, 500)}`)
    .join("\n");
  const compacted: ChatMessage[] = [];
  if (system) compacted.push(system);
  compacted.push({
    role: "system",
    content: `Earlier conversation context was compacted to keep the model within its context budget.\n${summary}`,
  });
  compacted.push(...recent);
  return compacted;
}

export async function* streamChat(
  session: ChatSession,
  userMessage: string,
  approve?: CommandApprover,
  sandbox?: SandboxRunner,
  signal?: AbortSignal,
  image?: ChatImage,
): AsyncGenerator<ChatEvent> {
  // A session with a checkout gets the tool-using coding prompt; a repo-less
  // session is a plain conversation (no tools).
  const hasRepo = Boolean(session.root);
  if (!session.messages.some((m) => m.role === "system")) {
    session.messages.unshift({ role: "system", content: hasRepo ? SYSTEM_PROMPT : CHAT_ONLY_SYSTEM_PROMPT });
  }
  session.messages.push({
    role: "user",
    content: userMessage,
    ...(image ? { images: [image.data], imageMimeTypes: [image.mimeType] } : {}),
  });

  const MAX_STEPS = 20;
  const MAX_TOOL_CALLS = 200;
  const MAX_RUNTIME_MS = 30 * 60 * 1000;
  const startedAt = Date.now();
  let toolCallsUsed = 0;
  // User-tunable generation options, falling back to sensible defaults.
  const opts = session.options ?? {};
  const genOptions: Record<string, number> = {
    temperature: opts.temperature ?? 0.3,
    num_ctx: Math.max(MIN_NUM_CTX, Math.min(MAX_NUM_CTX, Math.floor(opts.num_ctx ?? 16384))),
  };
  if (typeof opts.top_p === "number") genOptions.top_p = opts.top_p;
  if (typeof opts.top_k === "number") genOptions.top_k = opts.top_k;
  if (typeof opts.repeat_penalty === "number") genOptions.repeat_penalty = opts.repeat_penalty;
  // CPU / performance knobs - forwarded straight to Ollama when set.
  if (typeof opts.num_thread === "number") genOptions.num_thread = opts.num_thread;
  if (typeof opts.num_batch === "number") genOptions.num_batch = opts.num_batch;
  if (typeof opts.num_gpu === "number") genOptions.num_gpu = opts.num_gpu;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) return;
    if (Date.now() - startedAt > MAX_RUNTIME_MS) {
      yield { type: "error", message: "Chat runtime limit reached (30 minutes)." };
      return;
    }

    yield { type: "status", message: `Thinking… (Step ${step + 1})` };

    const compacted = compactMessages(session.messages, Math.max(32_000, Math.min(MAX_CHAT_CONTEXT_CHARS, genOptions.num_ctx * 3)));
    const cleanedMessages = compacted.map((message) => {
      const { imageMimeTypes, ...rest } = message;
      void imageMimeTypes;
      return rest;
    });
    let content = "";
    let toolCalls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> = [];

    if (session.provider) {
      // Use the provider abstraction (cloud or Ollama-via-provider).
      try {
        const deltas: string[] = [];
        const result = await session.provider.chat(
          session.model,
          cleanedMessages as any,
          hasRepo ? TOOL_DEFINITIONS : [],
          {
            temperature: genOptions.temperature,
            numCtx: genOptions.num_ctx,
            signal,
            onDelta: (delta) => deltas.push(delta),
          },
        );
        content = result.content;
        toolCalls = hasRepo ? (result.toolCalls as any[]) : [];
        for (const delta of deltas) yield { type: "model_delta" as const, content: delta };
      } catch (err) {
        if (signal?.aborted) return;
        yield { type: "error", message: `Provider failed: ${err instanceof Error ? err.message : String(err)}` };
        return;
      }
    } else {
      // Fallback: direct Ollama fetch (legacy path).
      const modelsToTry = [session.model, session.fallbackModel].filter(Boolean) as string[];
      let res: Response | undefined;
      let lastError = "";
      for (const tryModel of modelsToTry) {
        const attempt = await fetch(`${session.ollamaUrl.replace(/\/+$/, "")}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: tryModel,
            messages: cleanedMessages,
            tools: hasRepo ? TOOL_DEFINITIONS : undefined,
            stream: true,
            keep_alive: normalizeKeepAlive(opts.keep_alive),
            options: genOptions,
          }),
          signal,
        });
        if (attempt.ok) { res = attempt; break; }
        lastError = await attempt.text().catch(() => "");
        if (tryModel !== session.model) {
          yield { type: "status", message: `Primary model failed, trying ${tryModel}…` };
        }
      }
      if (!res) {
        yield { type: "error", message: `Ollama failed: ${lastError.slice(0, 300)}` };
        return;
      }

      // Stream the response
      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
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

      toolCalls = hasRepo
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
    }

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
        .replace(/(?:bash\s+)?(?:list_files|read_file|search|write_file|str_replace|run_command)\s*\([^)]*\)/gi, "")
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

    // No tool calls - model is done responding
    if (toolCalls.length === 0) {
      yield { type: "model_done", content: displayContent };
      return;
    }

    // Execute each tool call
    for (const call of toolCalls) {
      toolCallsUsed += 1;
      if (toolCallsUsed > MAX_TOOL_CALLS) {
        yield { type: "error", message: "Chat tool-call limit reached (200 calls)." };
        return;
      }
      const name = call.function.name;
      const args = call.function.arguments ?? {};
      yield { type: "tool_start", name, args };

      // For file edits, compute a preview diff and require approval for large changes.
      let before: string | undefined;
      if ((name === "write_file" || name === "str_replace") && typeof args.path === "string") {
        try {
          before = fs.readFileSync(path.resolve(session.root, args.path), "utf8");
        } catch {
          before = ""; // new file
        }
      }

      // Diff preview: show what will change before applying.
      if (before !== undefined && (name === "write_file" || name === "str_replace")) {
        let previewDiff = "";
        if (name === "write_file" && typeof args.content === "string") {
          previewDiff = lineDiff(before, args.content);
        } else if (name === "str_replace" && typeof args.old_string === "string" && typeof args.new_string === "string") {
          const oldStr = args.old_string;
          const newStr = args.new_string;
          const replaceAll = args.replace_all === true;
          try {
            const after = replaceAll
              ? before.split(oldStr).join(newStr)
              : before.replace(oldStr, newStr);
            previewDiff = lineDiff(before, after);
          } catch { /* pattern error caught by runTool */ }
        }
        if (previewDiff && previewDiff !== "(no changes)") {
          const changedLines = previewDiff.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-")).length;
          // Require approval when the edit changes more than 20 lines.
          if (changedLines > 20 && approve) {
            const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            const filePath = String(args.path ?? "");
            yield { type: "diff_preview", name, path: filePath, diff: previewDiff, requestId };
            const decision = await approve(`edit ${filePath}: ${changedLines} lines changed`);
            if (decision !== "approve") {
              yield { type: "tool_result", name, result: `Edit denied: ${filePath} was not changed.`, diff: previewDiff };
              session.messages.push({ role: "tool", content: `Edit denied: ${filePath} was not changed.`, tool_name: name });
              continue;
            }
          }
        }
      }

      let result: string;
      try {
        result = await runTool(session.root, name, args, approve, sandbox, signal);
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      let diff: string | undefined;
      if ((name === "write_file" || name === "str_replace") && before !== undefined && !result.startsWith("Error")) {
        if (name === "write_file" && typeof args.content === "string") {
          diff = lineDiff(before, args.content);
        } else {
          try {
            diff = lineDiff(before, fs.readFileSync(path.resolve(session.root, String(args.path)), "utf8"));
          } catch {
            diff = undefined;
          }
        }
      }

      yield { type: "tool_result", name, result, diff };
      session.messages.push({ role: "tool", content: result, tool_name: name });
    }
  }

  yield { type: "model_done", content: "" };
}
