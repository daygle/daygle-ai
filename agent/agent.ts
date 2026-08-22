import { REVIEW_TOOL_DEFINITIONS, TOOL_DEFINITIONS, runTool, type CommandApprover, type ToolDefinition } from "./tools";
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
  /** When true, the review is agentic - it reads code and runs checks before deciding. */
  agenticReview?: boolean;
  /** Max tool-using steps for the agentic reviewer before it must decide. */
  maxReviewSteps?: number;
  /** Block autonomous completion when review concerns remain after all fix rounds. */
  blockOnReviewConcerns?: boolean;
  /** When true, the agent refuses to run without a sandbox (default for autonomous jobs). */
  requireSandbox?: boolean;
  /** Defaults to true; set false to skip the test-generation pass. */
  generateTests?: boolean;
  /** Max tool-using steps for the test-generation pass. */
  maxTestGenSteps?: number;
}

const DEFAULT_MAX_STEPS = 40;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_NUM_CTX = 16384;
const MIN_NUM_CTX = 4096;
const MAX_NUM_CTX = 131072;
const MAX_MODEL_CONTEXT_CHARS = 60_000;
const MAX_AGENT_RUNTIME_MS = 30 * 60 * 1000;
const MAX_TOOL_CALLS_PER_LOOP = 500;

function boundedNumCtx(value: number): number {
  return Math.max(MIN_NUM_CTX, Math.min(MAX_NUM_CTX, Math.floor(Number.isFinite(value) ? value : DEFAULT_NUM_CTX)));
}

/** Keep both the beginning (file headers/hunks) and end (latest failures) of a large diff. */
function limitModelContext(text: string): string {
  if (text.length <= MAX_MODEL_CONTEXT_CHARS) return text;
  const head = Math.floor(MAX_MODEL_CONTEXT_CHARS * 0.72);
  const tail = MAX_MODEL_CONTEXT_CHARS - head;
  return `${text.slice(0, head)}\n… (middle omitted; diff limited to ${MAX_MODEL_CONTEXT_CHARS} characters) …\n${text.slice(-tail)}`;
}

/**
 * Token-aware size estimate. Different content has different densities:
 * code ~3.5 chars/token, natural language ~4.5 chars/token, JSON ~3 chars/token.
 * Tool-call JSON is dense with punctuation so it costs more tokens per character.
 */
function estimateTokens(message: AgentMessage): number {
  const textLen = message.content.length;
  const jsonLen = JSON.stringify(message.tool_calls ?? []).length;
  // Code-heavy content (has backticks or semicolons) is denser.
  const isCode = message.content.includes("```") || message.content.includes(";");
  const charsPerToken = isCode ? 3.2 : 4.2;
  const textTokens = Math.ceil(textLen / charsPerToken);
  const jsonTokens = Math.ceil(jsonLen / 3); // JSON is very dense
  return textTokens + jsonTokens;
}

function compactAgentMessages(messages: AgentMessage[], maxChars: number): AgentMessage[] {
  const size = (message: AgentMessage) => estimateTokens(message);
  const total = messages.reduce((sum, message) => sum + size(message), 0);
  if (total <= maxChars) return messages;
  const system = messages.find((message) => message.role === "system");
  const rest = messages.filter((message) => message !== system);
  const recent: AgentMessage[] = [];
  let recentSize = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    const message = rest[i];
    const messageSize = size(message);
    if (recentSize + messageSize > Math.floor(maxChars * 0.72) && recent.length > 0) break;
    recent.unshift(message);
    recentSize += messageSize;
  }
  while (recent[0]?.role === "tool") recent.shift();
  const omitted = rest.slice(0, rest.length - recent.length);
  const summary = omitted
    .map((message) => `${message.role}${message.tool_name ? `:${message.tool_name}` : ""}: ${message.content.replace(/\s+/g, " ").slice(0, 600)}`)
    .join("\n");
  return [
    ...(system ? [system] : []),
    { role: "system", content: `Earlier task context was compacted to fit the model budget.\n${summary}` },
    ...recent,
  ];
}

const DEFAULT_SYSTEM_PROMPT = `You are daygle, a careful software engineering agent working inside a git repository checkout.
Your job is to complete the user's task by inspecting the code and, when appropriate, editing it.

You MUST use the provided tools to accomplish the task. Do NOT just describe what you would do - actually call the tools using the proper function call format.

CRITICAL: Never write tool calls or shell commands as text. Do NOT type things like "list_files()", "bash list_files()", or "bash cd web vite" - these do nothing. To use a tool you MUST invoke it through the tool interface.

Work in small, verifiable steps. Read and understand before editing.

Available tools:
- list_files(path) - list files/directories under a path (recursive, capped); use the exact nested path returned (for example api/src, not src)
- read_file(path, start_line?, end_line?) - read a file with numbered lines (up to 1500)
- read_headers(paths, lines?) - read the first N lines (default 40) of one or more files to see imports, exports, and type definitions. Use this BEFORE editing to understand module boundaries and dependencies.
- search(pattern, path?, semantic?) - search files by regex or use semantic=true for local embedding retrieval with a lexical fallback; space-separated paths are accepted. Use exact repository paths from list_files; do not assume a root-level src directory.
- write_file(path, content) - create or overwrite a file with its COMPLETE contents
- str_replace(path, old_string, new_string, replace_all?) - replace exact text in place
- run_command(command) - run a shell command in the repo (tests, typecheck, git status, etc.) through the command sandbox. If no sandbox is available, it is denied unless the trusted host fallback is explicitly enabled.
  For commands in a subdirectory, use: "cd <dir> && <command>"

Rules:
- Make the smallest change that solves the problem. Do not rewrite files unnecessarily.
- ALWAYS use str_replace for small, targeted edits (find-and-replace, fixing a line, renaming). Only use write_file for a brand-new file or a deliberate full rewrite, and then provide EVERY line of the file.
- Preserve the project's existing style and conventions.
- Before editing any file, use read_headers to check its imports and exports so you understand how it connects to the rest of the codebase.
- When a task touches multiple files, use search to find all related code (imports, usages, tests) before editing.
- After editing, verify with the project's typecheck/tests when available.
- Wait for each tool's result before acting on it.
- When finished, respond with a concise summary of what you found and changed, then STOP calling tools.
- Do not commit, push, or open pull requests - the harness handles that after you finish.
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

function isLikelyTestPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  return normalized === "test" || normalized.startsWith("test/") || normalized === "tests" || normalized.startsWith("tests/") || normalized.startsWith("fixtures/") || normalized.includes("/__fixtures__/") || normalized.includes("/test/") || normalized.includes("/tests/") || normalized.includes("/__tests__/") ||
    /(^|[./_-])(test|spec)([./_-]|$)/.test(normalized) || normalized.endsWith("_test.py") || normalized.endsWith("_test.go");
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
  /** Optional write guard used by restricted passes such as test generation. */
  writePathPolicy?: (path: string) => boolean;
}): Promise<string> {
  const { root, task, model, ollamaUrl, emit, approve, sandbox, signal } = opts;
  const temperature = opts.config?.temperature ?? DEFAULT_TEMPERATURE;
  const numCtx = boundedNumCtx(opts.config?.numCtx ?? DEFAULT_NUM_CTX);
  const maxSteps = Math.max(1, Math.min(200, opts.config?.maxSteps ?? DEFAULT_MAX_STEPS));
  const systemPrompt = opts.config?.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;

  // Enforce sandbox requirement for autonomous jobs unless explicitly opted out.
  if (opts.config?.requireSandbox && !sandbox) {
    throw new Error(
      "Agent requires a command sandbox but none is available. " +
      "Start Docker/Podman/bubblewrap, or set requireSandbox: false in the agent config for trusted environments."
    );
  }

  const throwIfCancelled = () => {
    if (signal?.aborted) throw new CancelledError();
  };

  const messages: AgentMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: task },
  ];
  const startedAt = Date.now();
  let toolCallsUsed = 0;

  for (let step = 0; step < maxSteps; step++) {
    throwIfCancelled();
    if (Date.now() - startedAt > MAX_AGENT_RUNTIME_MS) throw new Error("Agent runtime limit reached (30 minutes).");
    emit({ type: "status", message: `Thinking… (Step ${step + 1}/${maxSteps})` });
    const { content, toolCalls } = await chatOnce(
      ollamaUrl,
      model,
      compactAgentMessages(messages, Math.max(32_000, Math.min(96_000, numCtx * 3))),
      TOOL_DEFINITIONS,
      {
        temperature,
        numCtx,
        signal,
        onDelta: (delta) => emit({ type: "model_delta", content: delta }),
      },
    );
    throwIfCancelled();

    if (content) emit({ type: "model", content });

    if (toolCalls.length === 0) {
      return content.trim() || "Task finished.";
    }

    messages.push({ role: "assistant", content, tool_calls: toolCalls });

    for (const call of toolCalls) {
      toolCallsUsed += 1;
      if (toolCallsUsed > MAX_TOOL_CALLS_PER_LOOP) throw new Error("Agent tool-call limit reached (500 calls).");
      const name = call.function.name;
      const args = call.function.arguments ?? {};
      emit({ type: "tool_start", name, args });

      let result: string;
      try {
        if (opts.writePathPolicy && (name === "write_file" || name === "str_replace")) {
          const target = typeof args.path === "string" ? args.path : "";
          result = opts.writePathPolicy(target)
            ? await runTool(root, name, args, approve, sandbox, signal)
            : `Denied: this restricted pass may only edit test files; refused ${target || "an unspecified path"}.`;
        } else {
          result = await runTool(root, name, args, approve, sandbox, signal);
        }
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

const DEFAULT_MAX_TEST_GEN_STEPS = 30;

const TEST_GEN_SYSTEM_PROMPT = `You are daygle, a software engineer writing automated tests for a change that was just made to a git repository.

You MUST use the provided tools - read files, search, write test files, and run the tests. Do NOT describe tests as text; actually create and run them.

CRITICAL: Never write tool calls or shell commands as plain text. To use a tool you MUST invoke it through the tool interface.

How to work:
1. First, search for existing tests related to the changed code. Use search with patterns like the function/class names, and check common test directories (tests/, test/, __tests__/, *.test.ts, *_test.py, etc.). Understand the existing test conventions before writing new ones.
2. Study the change and the code it touches, and look for an existing test setup - a test runner, config, and where tests live. Match the project's existing testing framework and conventions exactly. Do NOT introduce a new test framework or dependencies.
3. Write focused tests that cover the new or changed behavior, including the important edge cases - not trivial or redundant assertions. Place new tests in the same directory/style as existing tests.
4. After creating each test file, run the project's test command to verify it passes. If tests fail, debug and fix them. If the change itself is buggy, prefer fixing the test to assert correct behavior; only touch non-test code if a test reveals a real defect.
5. If the repository has no test framework set up and adding one would be intrusive, do NOT scaffold one - stop and explain that in your summary instead.

Rules:
- Only add or edit test files (and minimal fixtures) unless a test uncovers a real bug in the change.
- Keep tests deterministic and self-contained. No network, no reliance on external services.
- When finished, give a short summary of the tests you added and their result, then STOP calling tools.`;

/**
 * Test-generation pass: reuses the coding agent loop with a test-focused prompt
 * to write and run automated tests covering a change. Runs after the main task
 * so the diff exists, and before the QA gate so the new tests are verified (and
 * fixed) by the normal rounds.
 */
export async function runTestGeneration(opts: {
  root: string;
  task: string;
  diff: string;
  model: string;
  ollamaUrl: string;
  emit: (event: AgentEvent) => void;
  approve?: CommandApprover;
  sandbox?: SandboxRunner;
  signal?: AbortSignal;
  config?: AgentConfig;
}): Promise<string> {
  const { root, task, diff, model, ollamaUrl, emit, approve, sandbox, signal } = opts;
  const taskText = `A change was just made to the repository to accomplish this task:\n${task}\n\nHere is the diff of that change:\n\n${limitModelContext(diff)}\n\nWrite automated tests that cover this change, following the project's existing test framework and conventions, and make them pass.`;
  return runAgentLoop({
    root,
    task: taskText,
    model,
    ollamaUrl,
    emit,
    approve,
    sandbox,
    signal,
    config: {
      ...opts.config,
      systemPrompt: TEST_GEN_SYSTEM_PROMPT,
      maxSteps: opts.config?.maxTestGenSteps ?? DEFAULT_MAX_TEST_GEN_STEPS,
    },
    writePathPolicy: isLikelyTestPath,
  });
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
 * Classify a reviewer's free-text response into a verdict. The reviewer is
 * asked to start with "APPROVED" or "CHANGES REQUESTED", but models phrase it
 * many ways, so we look for explicit change/approve signals near the top
 * before falling back - and default to "changes_requested" when genuinely
 * ambiguous, so an unclear review never silently waves changes through.
 */
export function parseReviewVerdict(text: string): ReviewResult["verdict"] {
  // Weigh only the opening of the review, where the verdict line lives, so a
  // later "no other changes requested" style aside can't flip the result.
  const head = text.trim().split(/\r?\n/).slice(0, 3).join("\n").toLowerCase();
  const wantsChanges = /\bchanges?\s+requested\b|\brequest(?:ing|s)?\s+changes\b|\bnot\s+approved\b|\brejected\b|\bneeds?\s+(?:changes|work|fixes)\b/.test(head);
  const approves = /\bapproved?\b|\blgtm\b|\blooks\s+good\b|\bno\s+changes?\s+(?:needed|required)\b/.test(head);
  if (wantsChanges) return "changes_requested";
  if (approves) return "approved";
  return "changes_requested";
}

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
  const numCtx = boundedNumCtx(opts.config?.numCtx ?? DEFAULT_NUM_CTX);

  const user = `Task being implemented:\n${task}\n\nDiff to review:\n\n${limitModelContext(diff)}`;
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
  const verdict = parseReviewVerdict(text);
  emit({ type: "review", verdict, text });
  return { verdict, text };
}

const DEFAULT_MAX_REVIEW_STEPS = 12;

const AGENTIC_REVIEW_SYSTEM_PROMPT = `You are a senior software engineer performing a pre-merge code review inside the repository checkout that already contains the change.

You have READ-ONLY tools to investigate before you decide:
- list_files(path) - list files/directories
- read_file(path, start_line?, end_line?) - read a file with numbered lines
- search(pattern, path?) - regex-search the repo
- run_command(command) - run verification commands (tests, typecheck, lint, build) inside a mandatory read-only sandbox. Only approved verification runners are permitted; anything else is denied. You cannot modify files.

How to review:
1. Read the diff, then open the surrounding code and call sites the change affects - don't judge from the diff alone.
2. When it helps, run the project's tests or typecheck to confirm the change actually works.
3. Look for correctness bugs, regressions, security issues, missing error handling, and broken conventions.

Work in small steps and wait for each tool result. When you have enough evidence, STOP calling tools and give your verdict in this exact format:
First line: APPROVED or CHANGES REQUESTED
Then: a short summary and, if changes are requested, a numbered list of concrete issues to fix (reference files/lines).`;

/**
 * Agentic pre-merge review: a reviewer model that reads the code and runs the
 * project's checks (via a scoped, read-only tool set) before returning a
 * verdict - stronger than a diff-only review because it can confirm the change
 * actually works. Emits tool/status events so the investigation is visible, and
 * a final `review` event.
 */
export async function runAgenticReview(opts: {
  root: string;
  ollamaUrl: string;
  model: string;
  task: string;
  diff: string;
  emit: (event: AgentEvent) => void;
  approve?: CommandApprover;
  sandbox?: SandboxRunner;
  signal?: AbortSignal;
  config?: AgentConfig;
  writePathPolicy?: (path: string) => boolean;
}): Promise<ReviewResult> {
  const { root, ollamaUrl, model, task, diff, emit, approve, sandbox, signal } = opts;
  if (!sandbox) {
    throw new Error(
      "Agentic review refused: a command sandbox is unavailable. Start Docker/Podman/bubblewrap before running a review that executes repository checks.",
    );
  }
  const temperature = opts.config?.temperature ?? DEFAULT_TEMPERATURE;
  const numCtx = boundedNumCtx(opts.config?.numCtx ?? DEFAULT_NUM_CTX);
  const maxSteps = Math.max(1, Math.min(40, opts.config?.maxReviewSteps ?? DEFAULT_MAX_REVIEW_STEPS));

  const throwIfCancelled = () => {
    if (signal?.aborted) throw new CancelledError();
  };

  const messages: AgentMessage[] = [
    { role: "system", content: AGENTIC_REVIEW_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Task being implemented:\n${task}\n\nDiff under review:\n\n${limitModelContext(diff)}\n\nInvestigate as needed, then give your verdict.`,
    },
  ];

  let lastContent = "";
  for (let step = 0; step < maxSteps; step++) {
    throwIfCancelled();
    emit({ type: "status", message: `Reviewing… (step ${step + 1}/${maxSteps})` });
    const { content, toolCalls } = await chatOnce(
      ollamaUrl,
      model,
      compactAgentMessages(messages, Math.max(32_000, Math.min(96_000, numCtx * 3))),
      REVIEW_TOOL_DEFINITIONS,
      {
        temperature,
        numCtx,
        signal,
      },
    );
    throwIfCancelled();
    if (content) lastContent = content;

    if (toolCalls.length === 0) {
      const text = content.trim() || "CHANGES REQUESTED\n(reviewer returned no verdict)";
      const verdict = parseReviewVerdict(text);
      emit({ type: "review", verdict, text });
      return { verdict, text };
    }

    messages.push({ role: "assistant", content, tool_calls: toolCalls });
    for (const call of toolCalls) {
      const name = call.function.name;
      const args = call.function.arguments ?? {};
      // Defense in depth: the reviewer must never mutate the tree.
      if (name === "write_file" || name === "str_replace") {
        emit({ type: "tool_start", name, args });
        const result = "Denied: the reviewer is read-only and cannot write files.";
        emit({ type: "tool_result", name, result });
        messages.push({ role: "tool", content: result, tool_name: name });
        continue;
      }
      emit({ type: "tool_start", name, args });
      let result: string;
      try {
        if (opts.writePathPolicy && (name === "write_file" || name === "str_replace")) {
          const target = typeof args.path === "string" ? args.path : "";
          result = opts.writePathPolicy(target)
            ? await runTool(root, name, args, approve, sandbox, signal, true)
            : `Denied: this restricted pass may only edit test files; refused ${target || "an unspecified path"}.`;
        } else {
          result = await runTool(root, name, args, approve, sandbox, signal, true);
        }
        throwIfCancelled();
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      emit({ type: "tool_result", name, result });
      messages.push({ role: "tool", content: result, tool_name: name });
    }
  }

  // Ran out of steps without a clean stop - treat the last words as the verdict,
  // defaulting to changes-requested so an inconclusive review doesn't approve.
  const text = lastContent.trim()
    ? `${lastContent.trim()}\n\n(Reviewer reached its step limit.)`
    : "CHANGES REQUESTED\n(reviewer reached its step limit without a verdict)";
  const verdict = parseReviewVerdict(text);
  emit({ type: "review", verdict, text });
  return { verdict, text };
}
