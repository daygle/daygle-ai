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
  /** When true, the review is agentic — it reads code and runs checks before deciding. */
  agenticReview?: boolean;
  /** Max tool-using steps for the agentic reviewer before it must decide. */
  maxReviewSteps?: number;
  /** When true, a test-generation pass writes and runs tests for the change. */
  generateTests?: boolean;
  /** Max tool-using steps for the test-generation pass. */
  maxTestGenSteps?: number;
}

const DEFAULT_MAX_STEPS = 40;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_NUM_CTX = 16384;

const DEFAULT_SYSTEM_PROMPT = `You are daygle, a careful software engineering agent working inside a git repository checkout.
Your job is to complete the user's task by inspecting the code and, when appropriate, editing it.

You MUST use the provided tools to accomplish the task. Do NOT just describe what you would do — actually call the tools using the proper function call format.

CRITICAL: Never write tool calls or shell commands as text. Do NOT type things like "list_files()", "bash list_files()", or "bash cd web vite" — these do nothing. To use a tool you MUST invoke it through the tool interface.

Work in small, verifiable steps. Read and understand before editing.

Available tools:
- list_files(path) — list files/directories under a path (recursive, capped)
- read_file(path, start_line?, end_line?) — read a file with numbered lines (up to 1500)
- search(pattern, path?) — regex-search files, returns matches with line numbers
- write_file(path, content) — create or overwrite a file with full contents
- run_command(command) — run a shell command in the repo (tests, typecheck, git status, etc.)
  For commands in a subdirectory, use: "cd <dir> && <command>"

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
    emit({ type: "status", message: `Thinking… (Step ${step + 1}/${maxSteps})` });
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

const DEFAULT_MAX_TEST_GEN_STEPS = 30;

const TEST_GEN_SYSTEM_PROMPT = `You are daygle, a software engineer writing automated tests for a change that was just made to a git repository.

You MUST use the provided tools — read files, search, write test files, and run the tests. Do NOT describe tests as text; actually create and run them.

CRITICAL: Never write tool calls or shell commands as plain text. To use a tool you MUST invoke it through the tool interface.

How to work:
1. Study the change and the code it touches, and look for an existing test setup — a test runner, config, and where tests live (e.g. *.test.ts, *_test.py, tests/). Match the project's existing testing framework and conventions exactly. Do NOT introduce a new test framework or dependencies.
2. Write focused tests that cover the new or changed behavior, including the important edge cases — not trivial or redundant assertions.
3. Run the tests with the project's test command and iterate until they pass. If the change itself is buggy, prefer fixing the test to assert correct behavior; only touch non-test code if a test reveals a real defect.
4. If the repository has no test framework set up and adding one would be intrusive, do NOT scaffold one — stop and explain that in your summary instead.

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
  const taskText = `A change was just made to the repository to accomplish this task:\n${task}\n\nHere is the diff of that change:\n\n${diff.slice(0, 60_000)}\n\nWrite automated tests that cover this change, following the project's existing test framework and conventions, and make them pass.`;
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
 * before falling back — and default to "changes_requested" when genuinely
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
  const verdict = parseReviewVerdict(text);
  emit({ type: "review", verdict, text });
  return { verdict, text };
}

const DEFAULT_MAX_REVIEW_STEPS = 12;

const AGENTIC_REVIEW_SYSTEM_PROMPT = `You are a senior software engineer performing a pre-merge code review inside the repository checkout that already contains the change.

You have READ-ONLY tools to investigate before you decide:
- list_files(path) — list files/directories
- read_file(path, start_line?, end_line?) — read a file with numbered lines
- search(pattern, path?) — regex-search the repo
- run_command(command) — run verification commands (tests, typecheck, lint, build). Only test/build runners are permitted; anything else is denied. You cannot modify files.

How to review:
1. Read the diff, then open the surrounding code and call sites the change affects — don't judge from the diff alone.
2. When it helps, run the project's tests or typecheck to confirm the change actually works.
3. Look for correctness bugs, regressions, security issues, missing error handling, and broken conventions.

Work in small steps and wait for each tool result. When you have enough evidence, STOP calling tools and give your verdict in this exact format:
First line: APPROVED or CHANGES REQUESTED
Then: a short summary and, if changes are requested, a numbered list of concrete issues to fix (reference files/lines).`;

/**
 * Agentic pre-merge review: a reviewer model that reads the code and runs the
 * project's checks (via a scoped, read-only tool set) before returning a
 * verdict — stronger than a diff-only review because it can confirm the change
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
}): Promise<ReviewResult> {
  const { root, ollamaUrl, model, task, diff, emit, approve, sandbox, signal } = opts;
  const temperature = opts.config?.temperature ?? DEFAULT_TEMPERATURE;
  const numCtx = opts.config?.numCtx ?? DEFAULT_NUM_CTX;
  const maxSteps = Math.max(1, Math.min(40, opts.config?.maxReviewSteps ?? DEFAULT_MAX_REVIEW_STEPS));

  const throwIfCancelled = () => {
    if (signal?.aborted) throw new CancelledError();
  };

  const messages: AgentMessage[] = [
    { role: "system", content: AGENTIC_REVIEW_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Task being implemented:\n${task}\n\nDiff under review:\n\n${diff.slice(0, 60_000)}\n\nInvestigate as needed, then give your verdict.`,
    },
  ];

  let lastContent = "";
  for (let step = 0; step < maxSteps; step++) {
    throwIfCancelled();
    emit({ type: "status", message: `Reviewing… (step ${step + 1}/${maxSteps})` });
    const { content, toolCalls } = await chatOnce(ollamaUrl, model, messages, REVIEW_TOOL_DEFINITIONS, {
      temperature,
      numCtx,
      signal,
    });
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
      if (name === "write_file") {
        emit({ type: "tool_start", name, args });
        const result = "Denied: the reviewer is read-only and cannot write files.";
        emit({ type: "tool_result", name, result });
        messages.push({ role: "tool", content: result, tool_name: name });
        continue;
      }
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

  // Ran out of steps without a clean stop — treat the last words as the verdict,
  // defaulting to changes-requested so an inconclusive review doesn't approve.
  const text = lastContent.trim()
    ? `${lastContent.trim()}\n\n(Reviewer reached its step limit.)`
    : "CHANGES REQUESTED\n(reviewer reached its step limit without a verdict)";
  const verdict = parseReviewVerdict(text);
  emit({ type: "review", verdict, text });
  return { verdict, text };
}
