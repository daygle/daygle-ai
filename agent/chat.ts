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
  tool_calls?: Array<{ id?: string; function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
  tool_call_id?: string;
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
  /** Chat provider - when set, used instead of the raw Ollama fetch. */
  provider?: ChatProvider;
  providerConfig?: { kind: "ollama" | "openai"; baseUrl: string; apiKey?: string };
  /** Timestamp the workspace payload was last computed, for client polling. */
  lastWorkspaceUpdate?: number;
  /** Conversation home page ("chat" or "agent") - keeps histories separate. */
  origin?: "chat" | "agent";
}

export type ChatEvent =
  | { type: "status"; message: string }
  | { type: "model_delta"; content: string }
  | { type: "model_done"; content: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown>; toolCallId?: string }
  | { type: "tool_result"; name: string; result: string; diff?: string; toolCallId?: string }
  | { type: "diff_preview"; name: string; path: string; diff: string; requestId: string; toolCallId?: string }
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

const TOOL_NAMES = new Set(["list_files", "read_headers", "read_file", "search", "write_file", "str_replace", "run_command", "create_pr"]);
const MAX_IDENTICAL_TOOL_CALLS = 3;

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function toolCallSignature(name: string, args: Record<string, unknown>): string {
  return `${name}:${stableSerialize(args)}`;
}

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
 * Find a balanced JSON object starting at `start` and return its end index (exclusive),
 * or -1 if the text ends before the braces are balanced.
 */
function findBalancedJson(text: string, start: number): number {
  if (text[start] !== "{") return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/**
 * Parse a clarification request from model output text.
 * Looks for a JSON object with a "clarification" key containing a question and options.
 * Returns null if no clarification request is found.
 */
function parseClarificationRequest(text: string): { question: string; options: Array<{ label: string; description?: string }> } | null {
  // Find the "clarification" key, then extract the balanced JSON object around it
  const keyRegex = /"clarification"\s*:/g;
  let keyMatch;
  while ((keyMatch = keyRegex.exec(text)) !== null) {
    // Walk back to find the opening '{' before the key
    let braceStart = keyMatch.index - 1;
    while (braceStart >= 0 && /\s/.test(text[braceStart])) braceStart--;
    if (braceStart < 0 || text[braceStart] !== "{") continue;
    const end = findBalancedJson(text, braceStart);
    if (end < 0) continue;
    try {
      const obj = JSON.parse(text.slice(braceStart, end)) as {
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
 *   read_headers({paths: "src/main.ts", lines: 20})
 *   create_pr({title: "Fix bug", body: "Details", base: "main"})
 */
export function parseTextToolCalls(text: string): Array<{ function: { name: string; arguments: Record<string, unknown> } }> {
  const calls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> = [];

  // First: scan balanced JSON objects so nested arguments (for example a PR
  // body or replacement content containing braces) are not cut off early.
  const jsonMarker = /\{\s*"name"\s*:/g;
  let match;
  while ((match = jsonMarker.exec(text)) !== null) {
    const start = match.index;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < text.length; index++) {
      const character = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        end = index + 1;
        break;
      }
    }
    if (end < 0) continue;
    try {
      const candidate = JSON.parse(text.slice(start, end)) as { name?: unknown; arguments?: unknown };
      if (typeof candidate.name === "string" && TOOL_NAMES.has(candidate.name) && candidate.arguments && typeof candidate.arguments === "object" && !Array.isArray(candidate.arguments)) {
        calls.push({ function: { name: candidate.name, arguments: candidate.arguments as Record<string, unknown> } });
      }
    } catch {
      // skip malformed args
    }
    jsonMarker.lastIndex = end;
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
            else if (name === 'read_headers') args.paths = strMatch[1];
            else if (name === 'search') args.pattern = strMatch[1];
            else if (name === 'write_file' || name === 'str_replace') args.path = strMatch[1];
            else if (name === 'run_command') args.command = strMatch[1];
            else if (name === 'create_pr') args.title = strMatch[1];
          } else {
            // Unquoted string
            if (name === 'list_files' || name === 'read_file') args.path = argStr;
            else if (name === 'read_headers') args.paths = argStr;
            else if (name === 'search') args.pattern = argStr;
            else if (name === 'write_file' || name === 'str_replace') args.path = argStr;
            else if (name === 'run_command') args.command = argStr;
            else if (name === 'create_pr') args.title = argStr;
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

export const SYSTEM_PROMPT = `You are daygle, a friendly and encouraging software engineering assistant working inside a git repository checkout. You're a supportive pair-programmer: warm, approachable, and genuinely glad to help.

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
- str_replace(path, old_string, new_string, replace_all?) - replace exact text in place; path may be a file, directory, or glob such as api/src/**/*.ts

- run_command(command) - run a shell command (tests, typecheck, etc.) through the command sandbox; without one, execution is denied unless trusted host fallback is explicitly enabled.
- create_pr(title, body, base?) - commit the current changes, push the branch, and open a GitHub pull request. This is interactive-chat only, requires explicit approval, a configured sandbox, and DAYGLE_SANDBOX_NETWORK=1.
  IMPORTANT: For commands that need to run in a subdirectory, use "cd <dir> && <command>" as a single command string.

Before editing any file, use read_headers to check its imports and exports so you understand how it connects to the rest of the codebase.
Use str_replace for small, targeted edits (find-and-replace, fixing a line). Only use write_file for a new file or a full rewrite, and include every line.

When you are unsure how to proceed, ask for clarification by outputting a JSON object in your response like this:
{"clarification": {"question": "Your question here", "options": [{"label": "Option A", "description": "Description of option A"}, {"label": "Option B", "description": "Description of option B"}]}}
The system will display these options to the user and let them choose. Wait for their response before proceeding.

A good turn reads like: one short sentence about what you're doing ("Let me look at the project structure."), then the real tool call, then your reply once the result comes back.

Tone: be warm, plain-spoken, and encouraging. Explain what you're doing in everyday language, celebrate small wins, and when something goes wrong stay calm and reassuring and suggest a clear next step. Never be condescending or terse to the point of feeling curt.

Be concise. Read and understand before editing. Make the smallest change that solves the problem.`;

export const CHAT_ONLY_SYSTEM_PROMPT = `You are daygle, a friendly, encouraging, and concise assistant. Greet people warmly and keep a supportive, approachable tone. Answer questions, explain concepts, and help with coding by writing and discussing code inline. You are not connected to a repository, so you cannot read or modify files - if the user needs you to work inside a codebase, warmly suggest they connect one.`;

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

function compactMessages(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  const size = (message: ChatMessage) => estimateChatTokens(message);
  const total = messages.reduce((sum, message) => sum + size(message), 0);
  if (total <= maxTokens) return messages;

  const system = messages.find((message) => message.role === "system");
  const rest = messages.filter((message) => message !== system);
  // Preserve the assistant tool-call + tool-result protocol as one unit. This
  // prevents compaction from sending an orphaned tool result or tool request.
  const groups: ChatMessage[][] = [];
  for (let index = 0; index < rest.length; index++) {
    const message = rest[index];
    const group = [message];
    if (message.role === "assistant" && message.tool_calls?.length) {
      while (index + 1 < rest.length && rest[index + 1].role === "tool") group.push(rest[++index]);
    }
    groups.push(group);
  }

  const recentGroups: ChatMessage[][] = [];
  let recentSize = 0;
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index];
    const groupSize = group.reduce((sum, message) => sum + size(message), 0);
    if (recentSize + groupSize > Math.floor(maxTokens * 0.72) && recentGroups.length > 0) break;
    recentGroups.unshift(group);
    recentSize += groupSize;
  }
  const recent = recentGroups.flat();
  const omitted = groups.slice(0, groups.length - recentGroups.length).flat();
  const summary = omitted
    .map((message) => `${message.role}${message.tool_name ? `:${message.tool_name}` : ""}: ${message.content.replace(/\s+/g, " ").slice(0, 500)}`)
    .join("\n")
    .slice(0, Math.floor(maxTokens * 2));
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
  let previousToolSignature = "";
  let consecutiveIdenticalToolCalls = 0;
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
    let toolCalls: Array<{ id?: string; function: { name: string; arguments: Record<string, unknown> } }> = [];

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
        if (tryModel !== session.model) {
          // Announce the fallback BEFORE attempting it, so the user sees why
          // the response is delayed rather than a notice after the fact.
          yield { type: "status", message: `Primary model failed, trying ${tryModel}…` };
        }
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
      }
      if (!res) {
        yield { type: "error", message: `Ollama failed: ${lastError.slice(0, 300)}` };
        return;
      }

      const contentType = res.headers.get("content-type") ?? "";
      const rawToolCalls = new Map<number, { id?: string; name: string; arguments: string }>();
      if (!contentType.includes("application/x-ndjson") && !contentType.includes("text/event-stream")) {
        try {
          const data = await res.json() as { message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> } };
          const msg = data.message ?? {};
          if (typeof msg.content === "string" && msg.content) {
            content += msg.content;
            yield { type: "model_delta", content: msg.content };
          }
          if (msg.tool_calls?.length) {
            for (const [index, call] of msg.tool_calls.entries()) {
              const current = rawToolCalls.get(index) ?? { id: undefined, name: "", arguments: "" };
              if (call.id) current.id = call.id;
              if (call.function?.name) current.name = call.function.name;
              if (call.function?.arguments !== undefined) {
                current.arguments += typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments);
              }
              rawToolCalls.set(index, current);
            }
          }
        } catch {
          yield { type: "error", message: "Ollama returned an unreadable response." };
          return;
        }
      } else {
      // Stream the response
      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
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
            const data = JSON.parse(trimmed) as { message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> } };
            const msg = data.message ?? {};
            const delta = typeof msg.content === "string" ? msg.content : "";
            if (delta) {
              content += delta;
              yield { type: "model_delta", content: delta };
            }
            if (msg.tool_calls?.length) {
              for (const [index, call] of msg.tool_calls.entries()) {
                const key = typeof (call as { index?: unknown }).index === "number"
                  ? (call as { index: number }).index
                  : index;
                const current = rawToolCalls.get(key) ?? { id: undefined, name: "", arguments: "" };
                if (call.id) current.id = call.id;
                if (call.function?.name) current.name = call.function.name;
                if (call.function?.arguments !== undefined) {
                  current.arguments += typeof call.function.arguments === "string"
                    ? call.function.arguments
                    : JSON.stringify(call.function.arguments);
                }
                rawToolCalls.set(key, current);
              }
            }
          } catch {
            // skip malformed lines
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        try {
          const data = JSON.parse(buffer.trim()) as { message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> } };
          const msg = data.message ?? {};
          const delta = typeof msg.content === "string" ? msg.content : "";
          if (delta) {
            content += delta;
            yield { type: "model_delta", content: delta };
          }
          if (msg.tool_calls?.length) {
            for (const [index, call] of msg.tool_calls.entries()) {
              const key = typeof (call as { index?: unknown }).index === "number"
                ? (call as { index: number }).index
                : index;
              const current = rawToolCalls.get(key) ?? { id: undefined, name: "", arguments: "" };
              if (call.id) current.id = call.id;
              if (call.function?.name) current.name = call.function.name;
              if (call.function?.arguments !== undefined) {
                current.arguments += typeof call.function.arguments === "string"
                  ? call.function.arguments
                  : JSON.stringify(call.function.arguments);
              }
              rawToolCalls.set(key, current);
            }
          }
        } catch {
          // skip
        }
      }

      }

      toolCalls = hasRepo
        ? [...rawToolCalls.values()].map((call) => {
            let args: unknown = {};
            if (call.arguments) {
              try { args = JSON.parse(call.arguments); } catch { args = {}; }
            }
            if (typeof args !== "object" || args === null || Array.isArray(args)) args = {};
            return { id: call.id, function: { name: call.name || "unknown", arguments: args as Record<string, unknown> } };
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
        .replace(/(?:bash\s+)?(?:list_files|read_headers|read_file|search|write_file|str_replace|run_command|create_pr)\s*\([^)]*\)/gi, "")
        // Strip bash cd patterns like: bash cd web vite
        .replace(/(?:bash\s+)?cd\s+\S+\s+.+/gi, "")
        .trim();
    }

    // Record the assistant message whenever there is text OR structured tool
    // calls. Pushing only when `content` is truthy would drop tool-only turns
    // (model emitted calls with no text, common on OpenAI-compatible APIs) and
    // leave the following tool results without the assistant tool_call message
    // the provider requires for the next request.
    if (content || toolCalls.length > 0) {
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
      const signature = toolCallSignature(name, args);
      if (signature === previousToolSignature) {
        consecutiveIdenticalToolCalls += 1;
      } else {
        previousToolSignature = signature;
        consecutiveIdenticalToolCalls = 1;
      }
      if (consecutiveIdenticalToolCalls >= MAX_IDENTICAL_TOOL_CALLS) {
        yield {
          type: "error",
          message: `The model repeated ${name} with the same arguments ${MAX_IDENTICAL_TOOL_CALLS} times. Stopping to prevent a tool loop.`,
        };
        return;
      }
      yield { type: "tool_start", name, args, toolCallId: call.id };

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
            yield { type: "diff_preview", name, path: filePath, diff: previewDiff, requestId, toolCallId: call.id };
            const decision = await approve(`edit ${filePath}: ${changedLines} lines changed`);
            if (decision !== "approve") {
              yield { type: "tool_result", name, result: `Edit denied: ${filePath} was not changed.`, diff: previewDiff, toolCallId: call.id };
              session.messages.push({ role: "tool", content: `Edit denied: ${filePath} was not changed.`, tool_name: name, tool_call_id: call.id });
              continue;
            }
          }
        }
      }

      let result: string;
      try {
        result = await runTool(session.root, name, args, approve, sandbox, signal, false, session.ollamaUrl);
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

      yield { type: "tool_result", name, result, diff, toolCallId: call.id };
      session.messages.push({ role: "tool", content: result, tool_name: name, tool_call_id: call.id });
    }
  }

  yield { type: "model_done", content: "" };
}
