import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CancelledError, runAgentLoop, runAgenticReview, runReview, runTestGeneration, type AgentConfig, type AgentEvent } from "./agent";
import { ChatSession, streamChat, type ChatEvent, type GenOptions } from "./chat";
import { ChatHistoryStore, deriveTitle } from "./chat-history";
import {
  changedFiles,
  cloneRepo,
  commitAll,
  createBranch,
  detectDefaultBranch,
  ghAuthenticated,
  openPullRequest,
  pushBranch,
  workingDiff,
} from "./git";
import {
  createInstallationToken,
  createPullRequest,
  githubAppAvailable,
  parseRepo,
} from "./github";
import { detectSandbox, type SandboxRunner } from "./sandbox";
import { reviewApprover, runTool, type CommandApprover } from "./tools";
import { HistoryStore, type StoredJob } from "./history";
import { runQaGate, type QaResult } from "./qa";
import { checkModelUpdate } from "./updates";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";

const TOKEN_PATH = path.join(os.homedir(), ".daygle", "github-token");

let sandbox: SandboxRunner | null = null;

const chatSessions = new Map<string, ChatSession>();

function loadGithubToken(): string {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

function saveGithubToken(token: string): void {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, token.trim(), "utf8");
}

interface Job {
  id: string;
  repoUrl: string;
  task: string;
  model: string;
  baseBranch: string;
  ollamaUrl: string;
  status: "running" | "done" | "error" | "cancelled";
  events: AgentEvent[];
  listeners: Set<(event: AgentEvent) => void>;
  approved: Set<string>;
  denied: Set<string>;
  prUrl?: string;
  summary?: string;
  controller: AbortController;
  createdAt: number;
  finishedAt?: number;
  config?: AgentConfig;
}

const jobs = new Map<string, Job>();

interface PendingApproval {
  jobId?: string;
  resolve: (decision: "approve" | "deny") => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingApprovals = new Map<string, PendingApproval>();

// Evict idle chat sessions and remove their cloned repos so memory and disk
// don't grow without bound.
const CHAT_SESSION_TTL_MS = 60 * 60 * 1000;
const chatSweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of chatSessions) {
    if (now - session.lastActivity > CHAT_SESSION_TTL_MS) {
      chatSessions.delete(id);
      if (session.root) {
        try {
          fs.rmSync(session.root, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    }
  }
}, 10 * 60 * 1000);
chatSweeper.unref?.();

const historyStore = new HistoryStore(path.join(os.homedir(), ".daygle", "history"));
const chatHistoryStore = new ChatHistoryStore(path.join(os.homedir(), ".daygle", "chat-history"));

function persistChat(session: ChatSession): void {
  chatHistoryStore.save({
    id: session.id,
    repoUrl: session.repoUrl,
    model: session.model,
    ollamaUrl: session.ollamaUrl,
    title: deriveTitle(session.messages),
    messages: session.messages,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    options: session.options,
  });
}

/**
 * Restore a persisted chat into memory when its in-memory session has expired.
 * Re-clones the repo so the conversation can continue against a fresh checkout.
 */
async function rehydrateChat(id: string): Promise<ChatSession | null> {
  const stored = chatHistoryStore.load(id);
  if (!stored) return null;
  let dir = "";
  if (stored.repoUrl) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "daygle-chat-"));
    try {
      const token = loadGithubToken() || undefined;
      await cloneRepo(stored.repoUrl, dir, token);
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }
  const session: ChatSession = {
    id: stored.id,
    repoUrl: stored.repoUrl,
    root: dir,
    model: stored.model,
    ollamaUrl: stored.ollamaUrl,
    messages: stored.messages,
    createdAt: stored.createdAt,
    lastActivity: Date.now(),
    options: stored.options,
  };
  chatSessions.set(id, session);
  return session;
}

function toStored(job: Job): StoredJob {
  return {
    id: job.id,
    repoUrl: job.repoUrl,
    task: job.task,
    model: job.model,
    baseBranch: job.baseBranch,
    ollamaUrl: job.ollamaUrl,
    status: job.status,
    events: job.events,
    approved: [...job.approved],
    denied: [...job.denied],
    prUrl: job.prUrl,
    summary: job.summary,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

function persist(job: Job): void {
  historyStore.save(toStored(job));
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

function publish(job: Job, event: AgentEvent): void {
  if (event.type === "model_delta" || event.type === "diff") {
    // Streaming deltas and diff snapshots are live-only; the full `model` event and
    // the tool results are what get persisted.
    for (const listener of job.listeners) listener(event);
    return;
  }
  job.events.push(event);
  for (const listener of job.listeners) listener(event);
  persist(job);
}

function makeApprover(job: Job): (command: string) => Promise<"approve" | "deny"> {
  return async (command: string) => {
    if (job.approved.has(command)) return "approve";
    if (job.denied.has(command)) return "deny";

    return new Promise<"approve" | "deny">((resolve) => {
      const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        const pending = pendingApprovals.get(requestId);
        if (pending) {
          pendingApprovals.delete(requestId);
          pending.resolve("deny");
        }
      }, 10 * 60 * 1000);
      pendingApprovals.set(requestId, { jobId: job.id, resolve, timer });
      publish(job, { type: "approval_requested", requestId, command });
    }).then((decision) => {
      if (decision === "approve") job.approved.add(command);
      else job.denied.add(command);
      return decision;
    });
  };
}

function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      data += chunk.toString();
      if (data.length > maxBytes) {
        rejected = true;
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!rejected) resolve(data);
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "task";
}

function buildBody(task: string, summary: string, files: string[], review?: string, qaNote?: string): string {
  const parts = [`## ${task}`, "", summary, "", "### Changed files", ...files.map((file) => `- \`${file}\``)];
  if (review) {
    parts.push("", "### AI review", "", review, "");
  }
  if (qaNote) {
    parts.push("", "### QA", "", qaNote, "");
  }
  parts.push("", "---", "_Generated by the daygle agent (local Ollama + GitHub CLI)._");
  return parts.join("\n");
}

async function executeJob(job: Job): Promise<void> {
  const signal = job.controller.signal;
  const throwIfCancelled = () => {
    if (signal.aborted) throw new CancelledError();
  };
  let workDir = "";
  let tempWorkDir = false;

  // Debounced working-tree diff snapshots so the UI can show file changes live.
  let diffTimer: ReturnType<typeof setTimeout> | undefined;
  const snapshotDiff = () => {
    if (diffTimer || !workDir) return;
    diffTimer = setTimeout(() => {
      diffTimer = undefined;
      void (async () => {
        try {
          const { stat, diff } = await workingDiff(workDir);
          publish(job, { type: "diff", stat, diff });
        } catch {
          // repo mid-operation; skip this snapshot
        }
      })();
    }, 250);
  };

  const emit = (event: AgentEvent) => {
    publish(job, event);
    if (event.type === "tool_result") snapshotDiff();
  };
  try {
    let appMode = false;
    let token: string | undefined;
    let repoOwner = "";
    let repoName = "";
    let base = "";
    let branch = "";

    appMode = githubAppAvailable();
    if (appMode) {
      const parsed = parseRepo(job.repoUrl);
      repoOwner = parsed.owner;
      repoName = parsed.repo;
      emit({ type: "status", message: "Requesting repo-scoped GitHub App token…" });
      token = await createInstallationToken(repoOwner);
    } else {
      token = loadGithubToken() || undefined;
    }

    emit({ type: "status", message: `Cloning ${job.repoUrl}…` });
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "daygle-"));
    tempWorkDir = true;
    await cloneRepo(job.repoUrl, workDir, token);

    base = job.baseBranch || (await detectDefaultBranch(job.repoUrl, token));
    branch = `daygle/${slugify(job.task)}-${Date.now().toString(36)}`;
    emit({ type: "status", message: `Branch ${branch} (base ${base})` });
    await createBranch(workDir, branch);

    emit({
      type: "status",
      message: sandbox
        ? `Command sandbox: ${sandbox.name}`
        : "No container sandbox available — commands run on the host (policy-gated).",
    });
    emit({ type: "status", message: `Running ${job.model}…` });
    let summary = await runAgentLoop({
      root: workDir,
      task: job.task,
      model: job.model,
      ollamaUrl: job.ollamaUrl,
      emit,
      approve: makeApprover(job),
      sandbox: sandbox ?? undefined,
      signal,
      config: job.config,
    });

    throwIfCancelled();
    try {
      const { stat, diff } = await workingDiff(workDir);
      publish(job, { type: "diff", stat, diff });
    } catch {
      // final snapshot is best-effort
    }
    let changed = await changedFiles(workDir);
    if (changed.length > 0) {
      // ---- Optional test-generation pass: write and run tests for the change
      // before the QA gate, so the new tests are verified by the normal rounds. ----
      if (job.config?.generateTests) {
        emit({ type: "status", message: "Generating tests for the change…" });
        const { diff } = await workingDiff(workDir).catch(() => ({ stat: "", diff: "" }));
        if (diff.trim()) {
          await runTestGeneration({
            root: workDir,
            task: job.task,
            diff,
            model: job.model,
            ollamaUrl: job.ollamaUrl,
            emit,
            approve: makeApprover(job),
            sandbox: sandbox ?? undefined,
            signal,
            config: job.config,
          });
          throwIfCancelled();
          try {
            const snapshot = await workingDiff(workDir);
            publish(job, { type: "diff", stat: snapshot.stat, diff: snapshot.diff });
          } catch {
            // best-effort snapshot
          }
          changed = await changedFiles(workDir);
        }
      }

      // ---- QA verification gate (harness-run): install deps, run typecheck/test/build,
      // and send failures back to the agent for fix rounds. ----
      const maxQaRounds = Math.max(0, Math.min(5, job.config?.maxQaRounds ?? 2));
      let qaNote: string | undefined;
      const runQaOnce = async (): Promise<QaResult> => {
        const qa = await runQaGate({
          root: workDir,
          command: job.config?.qaCommand,
          signal,
          onStatus: (message) => emit({ type: "status", message }),
        });
        publish(job, { type: "qa", command: qa.command, output: qa.output, passed: qa.passed, skipped: !qa.ran });
        return qa;
      };
      const runQaFixLoop = async (): Promise<void> => {
        let qa = await runQaOnce();
        for (let round = 0; round < maxQaRounds && qa.ran && !qa.passed; round++) {
          emit({ type: "status", message: `QA failed — fix round ${round + 1}…` });
          summary = await runAgentLoop({
            root: workDir,
            task: `A QA verification gate ran "${qa.command}" and reported failures:\n\n${qa.output}\n\nFix the failures, re-verify, and finish.`,
            model: job.model,
            ollamaUrl: job.ollamaUrl,
            emit,
            approve: makeApprover(job),
            sandbox: sandbox ?? undefined,
            signal,
            config: job.config,
          });
          throwIfCancelled();
          qa = await runQaOnce();
        }
        qaNote = qa.ran
          ? `Verification (${qa.command || "detected scripts"}): ${qa.passed ? "passed" : "failed"}.`
          : undefined;
      };
      await runQaFixLoop();

      // ---- Optional AI review gate: a second model reviews the diff before commit. ----
      let reviewText: string | undefined;
      let reviewFixRounds = 0;
      const reviewModel = job.config?.reviewModel?.trim();
      if (reviewModel) {
        const maxRounds = Math.max(0, Math.min(5, job.config?.maxReviewRounds ?? 2));
        for (let round = 0; round <= maxRounds; round++) {
          const { diff } = await workingDiff(workDir).catch(() => ({ stat: "", diff: "" }));
          if (!diff.trim()) break;
          const agentic = Boolean(job.config?.agenticReview);
          emit({ type: "status", message: `${agentic ? "Agentic review" : "AI review"} by ${reviewModel}…` });
          const review = agentic
            ? await runAgenticReview({
                root: workDir,
                ollamaUrl: job.ollamaUrl,
                model: reviewModel,
                task: job.task,
                diff,
                emit,
                approve: reviewApprover,
                sandbox: sandbox ?? undefined,
                signal,
                config: job.config,
              })
            : await runReview({
                ollamaUrl: job.ollamaUrl,
                model: reviewModel,
                task: job.task,
                diff,
                emit,
                signal,
                config: job.config,
              });
          reviewText = review.text;
          if (review.verdict === "approved") break;
          if (round >= maxRounds) {
            emit({ type: "status", message: "Reviewer still has concerns — opening the PR with review notes." });
            break;
          }
          reviewFixRounds += 1;
          emit({ type: "status", message: `Reviewer requested changes — fix round ${round + 1}…` });
          summary = await runAgentLoop({
            root: workDir,
            task: `A code reviewer requested the following changes:\n\n${review.text}\n\nAddress these issues, verify your work, and finish.`,
            model: job.model,
            ollamaUrl: job.ollamaUrl,
            emit,
            approve: makeApprover(job),
            sandbox: sandbox ?? undefined,
            signal,
            config: job.config,
          });
          throwIfCancelled();
        }
      }
      // Re-verify after any review-driven fixes.
      if (reviewFixRounds > 0) {
        await runQaFixLoop();
      }

      emit({ type: "status", message: `${changed.length} file(s) changed — committing…` });
      await commitAll(workDir, `daygle: ${job.task.slice(0, 72)}`);
      const title = `daygle: ${job.task.slice(0, 72)}`;
      const body = buildBody(job.task, summary, changed, reviewText, qaNote);
      let prUrl: string;
      if (appMode && token) {
        emit({ type: "status", message: "Pushing branch…" });
        await pushBranch(workDir, branch);
        emit({ type: "status", message: "Opening pull request via GitHub App…" });
        prUrl = await createPullRequest(token, repoOwner, repoName, { base, head: branch, title, body });
      } else {
        emit({ type: "status", message: "Pushing and opening pull request via gh…" });
        prUrl = await openPullRequest(workDir, base, branch, title, body);
      }
      job.prUrl = prUrl;
      job.summary = summary;
      job.status = "done";
      job.finishedAt = Date.now();
      publish(job, { type: "done", summary, prUrl, branch, changedFiles: changed });
    } else {
      job.summary = summary;
      job.status = "done";
      job.finishedAt = Date.now();
      publish(job, { type: "done", summary, branch, changedFiles: [] });
    }
  } catch (err) {
    job.finishedAt = Date.now();
    if (err instanceof CancelledError) {
      job.status = "cancelled";
      publish(job, { type: "cancelled", message: "Job cancelled by the user." });
    } else {
      job.status = "error";
      publish(job, { type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    if (diffTimer) clearTimeout(diffTimer);
    if (tempWorkDir && workDir) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
    }
  }
}

function handleEvents(req: IncomingMessage, res: ServerResponse, job: Job): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...CORS_HEADERS,
  });

  const send = (event: AgentEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type === "done" || event.type === "error" || event.type === "cancelled") {
      job.listeners.delete(send);
      res.end();
    }
  };

  job.events.forEach(send);
  if (job.status === "running") {
    job.listeners.add(send);
    req.on("close", () => job.listeners.delete(send));
  }
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      const gh = await ghAuthenticated();
      const app = githubAppAvailable();
      const token = loadGithubToken();
      sendJson(res, 200, { ok: true, gh, app, token: !!token, sandbox: sandbox?.name ?? null });
      return;
    }

    if (url.pathname === "/api/github-token") {
      if (req.method === "GET") {
        const token = loadGithubToken();
        sendJson(res, 200, { token });
        return;
      }
      if (req.method === "POST") {
        let body: { token?: string };
        try {
          body = JSON.parse(await readBody(req)) as { token?: string };
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body." });
          return;
        }
        saveGithubToken(body.token ?? "");
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    // ---- Chat sessions (interactive agent chat) ----
    if (req.method === "GET" && url.pathname === "/api/chat/sessions") {
      sendJson(res, 200, { sessions: chatHistoryStore.list() });
      return;
    }

    const chatWorkspaceMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/workspace$/);
    if (chatWorkspaceMatch && req.method === "GET") {
      const sessionId = chatWorkspaceMatch[1];
      let session = chatSessions.get(sessionId);
      if (!session) {
        try {
          session = (await rehydrateChat(sessionId)) ?? undefined;
        } catch (err) {
          sendJson(res, 400, { error: `Failed to restore chat: ${err instanceof Error ? err.message : String(err)}` });
          return;
        }
      }
      if (!session) {
        sendJson(res, 404, { error: "Chat not found." });
        return;
      }
      if (!session.root) {
        sendJson(res, 200, { files: [], changedFiles: [], stat: "", diff: "" });
        return;
      }
      try {
        const filesResult = await runTool(session.root, "list_files", {});
        const { stat, diff } = await workingDiff(session.root);
        const changed = await changedFiles(session.root);
        const files = filesResult === "(empty)"
          ? []
          : filesResult.split(/\r?\n/).filter(Boolean);
        sendJson(res, 200, { files, changedFiles: changed, stat, diff });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // On-demand verification for a chat session: runs the QA gate (typecheck /
    // test / build, or a custom command) and, optionally, a second-model review
    // of the working diff. Streams the results as SSE using the same channel
    // shape as the chat stream so the UI can render them inline.
    const chatVerifyMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/verify$/);
    if (chatVerifyMatch && req.method === "POST") {
      const sessionId = chatVerifyMatch[1];
      let session = chatSessions.get(sessionId);
      if (!session) {
        try {
          session = (await rehydrateChat(sessionId)) ?? undefined;
        } catch (err) {
          sendJson(res, 400, { error: `Failed to restore chat: ${err instanceof Error ? err.message : String(err)}` });
          return;
        }
      }
      if (!session) {
        sendJson(res, 404, { error: "Chat session not found." });
        return;
      }
      if (!session.root) {
        sendJson(res, 400, { error: "This chat isn't connected to a repository, so there's nothing to verify." });
        return;
      }
      let body: { reviewModel?: string; qaCommand?: string; review?: boolean; agentic?: boolean };
      try {
        const raw = await readBody(req);
        body = raw ? (JSON.parse(raw) as typeof body) : {};
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body." });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...CORS_HEADERS,
      });
      const controller = new AbortController();
      req.on("close", () => controller.abort());
      const emit = (event: ChatEvent) => {
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          // socket already closed
        }
      };

      try {
        // 1) QA gate — install deps if needed, run detected/configured checks.
        const qa = await runQaGate({
          root: session.root,
          command: body.qaCommand?.trim() || undefined,
          signal: controller.signal,
          onStatus: (message) => emit({ type: "status", message }),
        });
        emit({ type: "qa", command: qa.command, output: qa.output, passed: qa.passed, skipped: !qa.ran });

        // 2) Optional second-model review of the current working diff.
        const wantReview = body.review !== false;
        if (wantReview && !controller.signal.aborted) {
          const { diff } = await workingDiff(session.root).catch(() => ({ stat: "", diff: "" }));
          if (diff.trim()) {
            const reviewModel = body.reviewModel?.trim() || session.model;
            const agentic = body.agentic !== false; // default to the agentic reviewer
            const reviewConfig = session.options
              ? { temperature: session.options.temperature, numCtx: session.options.num_ctx }
              : undefined;
            emit({ type: "status", message: `${agentic ? "Agentic review" : "AI review"} by ${reviewModel}…` });
            // Forward the reviewer's tool/status steps so the investigation is
            // visible in the chat transcript.
            const forward = (event: AgentEvent) => {
              if (event.type === "status") emit({ type: "status", message: event.message });
              else if (event.type === "tool_start") emit({ type: "tool_start", name: event.name, args: event.args });
              else if (event.type === "tool_result") emit({ type: "tool_result", name: event.name, result: event.result });
            };
            const review = agentic
              ? await runAgenticReview({
                  root: session.root,
                  ollamaUrl: session.ollamaUrl,
                  model: reviewModel,
                  task: deriveTitle(session.messages) || "the requested changes",
                  diff,
                  emit: forward,
                  approve: reviewApprover,
                  sandbox: sandbox ?? undefined,
                  signal: controller.signal,
                  config: reviewConfig,
                })
              : await runReview({
                  ollamaUrl: session.ollamaUrl,
                  model: reviewModel,
                  task: deriveTitle(session.messages) || "the requested changes",
                  diff,
                  emit: () => {},
                  signal: controller.signal,
                  config: reviewConfig,
                });
            emit({ type: "review", verdict: review.verdict, text: review.text });
          } else {
            emit({ type: "status", message: "No working-directory changes to review." });
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        emit({ type: "verify_done" });
      }
      res.end();
      return;
    }

    const chatIdMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)$/);
    if (chatIdMatch && req.method === "GET") {
      const id = chatIdMatch[1];
      const live = chatSessions.get(id);
      const chat = live
        ? {
            id: live.id,
            repoUrl: live.repoUrl,
            model: live.model,
            ollamaUrl: live.ollamaUrl,
            title: deriveTitle(live.messages),
            messages: live.messages,
            createdAt: live.createdAt,
            lastActivity: live.lastActivity,
            busy: Boolean(live.busy),
          }
        : chatHistoryStore.load(id);
      if (!chat) {
        sendJson(res, 404, { error: "Chat not found." });
        return;
      }
      sendJson(res, 200, { chat });
      return;
    }

    if (chatIdMatch && req.method === "DELETE") {
      const id = chatIdMatch[1];
      const live = chatSessions.get(id);
      if (live) {
        chatSessions.delete(id);
        if (live.root) {
          try {
            fs.rmSync(live.root, { recursive: true, force: true });
          } catch {
            // best effort
          }
        }
      }
      chatHistoryStore.delete(id);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (chatIdMatch && req.method === "PATCH") {
      const id = chatIdMatch[1];
      let body: { model?: string; options?: GenOptions };
      try {
        body = JSON.parse(await readBody(req)) as typeof body;
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body." });
        return;
      }
      const live = chatSessions.get(id);
      if (!live) {
        sendJson(res, 404, { error: "Chat not found." });
        return;
      }
      if (body.model?.trim()) {
        live.model = body.model.trim();
      }
      if (body.options) {
        live.options = body.options;
      }
      sendJson(res, 200, { ok: true, model: live.model });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/chat/sessions") {
      let body: { repoUrl?: string; model?: string; ollamaUrl?: string; options?: GenOptions };
      try {
        body = JSON.parse(await readBody(req)) as typeof body;
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body." });
        return;
      }
      if (!body.model?.trim()) {
        sendJson(res, 400, { error: "model is required." });
        return;
      }
      const repoUrl = body.repoUrl?.trim() ?? "";
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      // A repo is optional: with one, we clone for tool use; without, it's a
      // plain conversation and there's nothing to check out.
      let dir = "";
      if (repoUrl) {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "daygle-chat-"));
        try {
          const token = loadGithubToken() || undefined;
          await cloneRepo(repoUrl, dir, token);
        } catch (err) {
          fs.rmSync(dir, { recursive: true, force: true });
          sendJson(res, 400, { error: `Failed to clone repo: ${err instanceof Error ? err.message : String(err)}` });
          return;
        }
      }
      const session: ChatSession = {
        id,
        repoUrl,
        root: dir,
        model: body.model.trim(),
        ollamaUrl: (body.ollamaUrl ?? "http://localhost:11434").trim(),
        messages: [],
        createdAt: Date.now(),
        lastActivity: Date.now(),
        options: body.options,
      };
      chatSessions.set(id, session);
      sendJson(res, 200, { id, repoUrl: session.repoUrl });
      return;
    }

    const chatMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)(?:\/messages)?$/);
    if (chatMatch && req.method === "POST") {
      const sessionId = chatMatch[1];
      let session = chatSessions.get(sessionId);
      if (!session) {
        // Session expired from memory — restore it from disk if we have a transcript.
        try {
          session = (await rehydrateChat(sessionId)) ?? undefined;
        } catch (err) {
          sendJson(res, 400, { error: `Failed to restore chat: ${err instanceof Error ? err.message : String(err)}` });
          return;
        }
        if (!session) {
          sendJson(res, 404, { error: "Chat session not found." });
          return;
        }
      }
      let body: { message?: string; image?: { data?: string; mimeType?: string } };
      try {
        body = JSON.parse(await readBody(req, 12_000_000)) as typeof body;
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body." });
        return;
      }
      if (!body.message?.trim()) {
        sendJson(res, 400, { error: "message is required." });
        return;
      }
      let image: { data: string; mimeType: string } | undefined;
      if (body.image?.data || body.image?.mimeType) {
        if (!body.image.data || !body.image.mimeType?.startsWith("image/")) {
          sendJson(res, 400, { error: "A valid image attachment is required." });
          return;
        }
        if (body.image.data.length > 10_000_000) {
          sendJson(res, 413, { error: "Image attachment is too large." });
          return;
        }
        image = { data: body.image.data, mimeType: body.image.mimeType };
      }
      session.lastActivity = Date.now();
      // Stream the response as SSE
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...CORS_HEADERS,
      });
      const controller = new AbortController();
      const emit = (event: ChatEvent) => {
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          // socket already closed
        }
      };

      // Approval channel: commands that mutate/execute pause here until the user
      // approves or denies from the chat UI (or a 10-minute timeout denies).
      const localApprovals = new Set<string>();
      const approve: CommandApprover = (command) => {
        const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        localApprovals.add(requestId);
        return new Promise<"approve" | "deny">((resolve) => {
          const timer = setTimeout(() => {
            if (pendingApprovals.delete(requestId)) resolve("deny");
          }, 10 * 60 * 1000);
          pendingApprovals.set(requestId, { resolve, timer });
          emit({ type: "approval_requested", requestId, command });
        }).then((decision) => {
          localApprovals.delete(requestId);
          emit({ type: "approval_resolved", requestId, decision });
          return decision;
        });
      };

      req.on("close", () => {
        controller.abort();
        // Release any approvals still waiting so the generator doesn't hang.
        for (const id of localApprovals) {
          const pending = pendingApprovals.get(id);
          if (pending) {
            pendingApprovals.delete(id);
            clearTimeout(pending.timer);
            pending.resolve("deny");
          }
        }
      });

      // Mark the session busy so a client that navigated away and came back can
      // detect the in-flight generation and reconnect to it (see getChatSession).
      session.busy = true;
      try {
        for await (const event of streamChat(session, body.message.trim(), approve, sandbox ?? undefined, controller.signal, image)) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      } catch (err) {
        if (!(err instanceof Error && err.name === "AbortError")) {
          res.write(`data: ${JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) })}\n\n`);
        }
      } finally {
        session.busy = false;
      }
      // Persist the transcript so the conversation survives restarts / TTL eviction.
      session.lastActivity = Date.now();
      persistChat(session);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/model-updates") {
      const ollamaUrl = (url.searchParams.get("ollamaUrl") ?? "").trim();
      const names = (url.searchParams.get("names") ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
        .slice(0, 50);
      if (!ollamaUrl || names.length === 0) {
        sendJson(res, 400, { error: "ollamaUrl and names are required." });
        return;
      }
      const results = await Promise.all(names.map((name) => checkModelUpdate(ollamaUrl, name)));
      sendJson(res, 200, { results });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/jobs") {
      let body: {
        repoUrl?: string;
        task?: string;
        model?: string;
        baseBranch?: string;
        ollamaUrl?: string;
        config?: AgentConfig;
      };
      try {
        body = JSON.parse(await readBody(req)) as typeof body;
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body." });
        return;
      }

      if (!body.repoUrl?.trim() || !body.task?.trim() || !body.model?.trim()) {
        sendJson(res, 400, { error: "repoUrl, task, and model are required." });
        return;
      }

      const job: Job = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        repoUrl: body.repoUrl.trim(),
        task: body.task.trim(),
        model: body.model.trim(),
        baseBranch: (body.baseBranch ?? "").trim(),
        ollamaUrl: (body.ollamaUrl ?? "http://localhost:11434").trim(),
        status: "running",
        events: [],
        listeners: new Set(),
        approved: new Set(),
        denied: new Set(),
        controller: new AbortController(),
        createdAt: Date.now(),
        config: body.config,
      };
      jobs.set(job.id, job);
      persist(job);
      void executeJob(job);
      sendJson(res, 200, { id: job.id });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/jobs") {
      const history = historyStore.loadAll().sort((a, b) => b.createdAt - a.createdAt);
      sendJson(res, 200, {
        jobs: history.map((job) => ({
          id: job.id,
          repoUrl: job.repoUrl,
          task: job.task,
          model: job.model,
          status: job.status,
          prUrl: job.prUrl,
          createdAt: job.createdAt,
          finishedAt: job.finishedAt,
        })),
      });
      return;
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(events|cancel))?$/);
    if (jobMatch) {
      const id = jobMatch[1];
      const sub = jobMatch[2];

      if (sub === "events" && req.method === "GET") {
        const job = jobs.get(id);
        if (!job) {
          sendJson(res, 404, { error: "Job not found." });
          return;
        }
        handleEvents(req, res, job);
        return;
      }

      if (sub === "cancel" && req.method === "POST") {
        const job = jobs.get(id);
        if (!job) {
          sendJson(res, 404, { error: "Job not found." });
          return;
        }
        if (job.status !== "running") {
          sendJson(res, 409, { error: "Job is not running." });
          return;
        }
        job.controller.abort();
        // Wake any pending approval so the loop can observe the cancellation.
        for (const [requestId, pending] of pendingApprovals) {
          if (pending.jobId === id) {
            pendingApprovals.delete(requestId);
            clearTimeout(pending.timer);
            pending.resolve("deny");
          }
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (!sub && req.method === "GET") {
        const live = jobs.get(id);
        const stored = live ? toStored(live) : historyStore.load(id);
        if (!stored) {
          sendJson(res, 404, { error: "Job not found." });
          return;
        }
        sendJson(res, 200, { job: stored });
        return;
      }
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/approvals/")) {
      const requestId = url.pathname.split("/").pop() ?? "";
      const pending = pendingApprovals.get(requestId);
      if (!pending) {
        sendJson(res, 404, { error: "Approval request not found or already resolved." });
        return;
      }
      let body: { decision?: string };
      try {
        body = JSON.parse(await readBody(req)) as { decision?: string };
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body." });
        return;
      }
      if (body.decision !== "approve" && body.decision !== "deny") {
        sendJson(res, 400, { error: "decision must be 'approve' or 'deny'." });
        return;
      }
      pendingApprovals.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve(body.decision);
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  })();
});

detectSandbox().then((runner) => {
  sandbox = runner;
  console.log(runner ? `command sandbox: ${runner.name}` : "command sandbox: none (host execution)");
  server.listen(PORT, HOST, () => {
    console.log(`daygle agent listening on http://localhost:${PORT}`);
  });
});
