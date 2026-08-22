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
  createCheckpoint,
  deleteCheckpoint,
  restoreCheckpoint,
  detectDefaultBranch,
  ghAuthenticated,
  openPullRequest,
  pushBranch,
  workingDiff,
  type WorkingTreeCheckpoint,
} from "./git";
import {
  createInstallationToken,
  createPullRequest,
  githubAppAvailable,
  parseRepo,
} from "./github";
import { detectSandbox, type SandboxRunner } from "./sandbox";
import { reviewApproverForRoot, runTool, type CommandApprover } from "./tools";
import { HistoryStore, type StoredJob } from "./history";
import { runQaGate, type QaResult } from "./qa";
import { checkModelUpdate } from "./updates";
import { getAllowedUiOrigins, isAllowedUiOrigin, isLoopbackUrl, LOOPBACK_HOST } from "./security";

const PORT = Number(process.env.PORT ?? 8787);
// The agent holds GitHub credentials and must never be reachable from the LAN.
// Keep this loopback-only unless an explicitly different deployment is intended.
const HOST = process.env.HOST?.trim() || LOOPBACK_HOST;
const ALLOWED_UI_ORIGINS = getAllowedUiOrigins();
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

function localOllamaUrl(value?: string): string | null {
  const url = (value ?? DEFAULT_OLLAMA_URL).trim();
  return isLoopbackUrl(url) ? url : null;
}

const TOKEN_PATH = path.join(os.homedir(), ".daygle", "github-token");

let sandbox: SandboxRunner | null = null;

const chatSessions = new Map<string, ChatSession>();
interface ChatCheckpointRecord {
  sessionId: string;
  id: string;
  createdAt: number;
  checkpoint: WorkingTreeCheckpoint;
}
const chatCheckpoints = new Map<string, ChatCheckpointRecord[]>();
const CHECKPOINT_ROOT = path.join(os.homedir(), ".daygle", "checkpoints");
const MAX_CHECKPOINTS_PER_CHAT = 12;
const CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_STORED_JOB_EVENTS = 2_000;
const MAX_CHAT_HISTORY_MESSAGES = 1_000;
const AUDIT_LOG_PATH = path.join(os.homedir(), ".daygle", "audit.jsonl");
const AUDIT_ROTATE_BYTES = 5 * 1024 * 1024;

function redactAuditText(value: string): string {
  const token = loadGithubToken();
  return (token ? value.replaceAll(token, "[credential redacted]") : value)
    .replace(/(authorization|token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function checkpointManifestPath(sessionId: string, id: string): string {
  return path.join(CHECKPOINT_ROOT, sessionId, id, "manifest.json");
}

function loadChatCheckpoints(sessionId: string): ChatCheckpointRecord[] {
  const existing = chatCheckpoints.get(sessionId);
  if (existing) return existing;
  const records: ChatCheckpointRecord[] = [];
  try {
    for (const id of fs.readdirSync(path.join(CHECKPOINT_ROOT, sessionId))) {
      try {
        const raw = JSON.parse(fs.readFileSync(checkpointManifestPath(sessionId, id), "utf8")) as ChatCheckpointRecord;
        if (raw.sessionId === sessionId && raw.id === id && raw.checkpoint?.directory && path.resolve(raw.checkpoint.directory).startsWith(path.resolve(CHECKPOINT_ROOT) + path.sep)) {
          records.push(raw);
        }
      } catch {
        // skip incomplete checkpoint directories
      }
    }
  } catch {
    // no persisted checkpoints yet
  }
  records.sort((a, b) => a.createdAt - b.createdAt);
  chatCheckpoints.set(sessionId, records);
  return records;
}

function deleteChatCheckpoint(record: ChatCheckpointRecord): void {
  deleteCheckpoint(record.checkpoint);
  try { fs.rmSync(path.join(CHECKPOINT_ROOT, record.sessionId, record.id), { recursive: true, force: true }); } catch { /* best effort */ }
}

function pruneChatCheckpoints(records: ChatCheckpointRecord[]): void {
  const now = Date.now();
  while (records.length > MAX_CHECKPOINTS_PER_CHAT || (records[0] && now - records[0].createdAt > CHECKPOINT_TTL_MS)) {
    const old = records.shift();
    if (old) deleteChatCheckpoint(old);
  }
}

function saveCheckpointManifest(record: ChatCheckpointRecord): void {
  const manifest = checkpointManifestPath(record.sessionId, record.id);
  fs.mkdirSync(path.dirname(manifest), { recursive: true, mode: 0o700 });
  fs.writeFileSync(manifest, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
}

function cleanupCheckpointStore(): void {
  try {
    for (const sessionId of fs.readdirSync(CHECKPOINT_ROOT)) {
      const records = loadChatCheckpoints(sessionId);
      pruneChatCheckpoints(records);
      if (records.length === 0) fs.rmSync(path.join(CHECKPOINT_ROOT, sessionId), { recursive: true, force: true });
    }
  } catch {
    // checkpoint cleanup is best effort
  }
}

cleanupCheckpointStore();

/** Append structured, redacted tool activity for post-mortem debugging. */
function audit(scope: string, event: unknown): void {
  try {
    const value = event as { type?: string; name?: string; args?: Record<string, unknown>; result?: string; diff?: string };
    const safeArgs = value.args
      ? Object.fromEntries(Object.entries(value.args).map(([key, item]) => [key, key === "content" ? `[${String(item).length} chars]` : String(item).slice(0, 500)]))
      : undefined;
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true, mode: 0o700 });
    if (fs.existsSync(AUDIT_LOG_PATH) && fs.statSync(AUDIT_LOG_PATH).size > AUDIT_ROTATE_BYTES) {
      const rotated = `${AUDIT_LOG_PATH}.1`;
      fs.rmSync(rotated, { force: true });
      fs.renameSync(AUDIT_LOG_PATH, rotated);
    }
    const record = {
      timestamp: new Date().toISOString(),
      scope,
      type: value.type,
      name: value.name,
      args: safeArgs ? Object.fromEntries(Object.entries(safeArgs).map(([key, item]) => [key, redactAuditText(String(item))])) : undefined,
      result: value.result ? redactAuditText(value.result.slice(0, 2_000)) : undefined,
      diff: value.diff ? redactAuditText(value.diff.slice(0, 2_000)) : undefined,
    };
    fs.appendFileSync(AUDIT_LOG_PATH, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Audit logging must never interrupt an agent run.
  }
}

function readAuditLog(scope?: string, limit = 200): unknown[] {
  try {
    const lines = fs.readFileSync(AUDIT_LOG_PATH, "utf8").split(/\r?\n/).filter(Boolean);
    return lines
      .slice(-Math.max(1, Math.min(500, limit)))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => !scope || entry.scope === scope);
  } catch {
    return [];
  }
}

// Cancel handles for in-flight chat generations, keyed by session id, so a
// /cancel request (or a disconnect) can stop a run even when the streaming
// client is gone - e.g. the user navigated away and clicks Stop from a
// reconnected view.
const activeChatRuns = new Map<string, () => void>();

function loadGithubToken(): string {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

function saveGithubToken(token: string): void {
  const directory = path.dirname(TOKEN_PATH);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(TOKEN_PATH, token.trim(), { encoding: "utf8", mode: 0o600 });
  // chmod also tightens permissions when the file was created by an older version.
  fs.chmodSync(TOKEN_PATH, 0o600);
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
// don't grow without bound. Also evicts finished jobs from memory after a TTL
// (they're persisted to disk by HistoryStore, which GET /api/jobs falls back to).
const CHAT_SESSION_TTL_MS = 60 * 60 * 1000;
const JOB_TTL_MS = 60 * 60 * 1000;
const chatSweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of chatSessions) {
    if (session.busy) continue; // never evict a session mid-generation
    if (now - session.lastActivity > CHAT_SESSION_TTL_MS) {
      chatSessions.delete(id);
      const checkpoints = chatCheckpoints.get(id) ?? loadChatCheckpoints(id);
      for (const checkpoint of checkpoints) deleteChatCheckpoint(checkpoint);
      chatCheckpoints.delete(id);
      if (session.root) {
        try {
          fs.rmSync(session.root, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    }
  }
  for (const [id, job] of jobs) {
    if (job.status !== "running" && job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000);
chatSweeper.unref?.();

const historyStore = new HistoryStore(path.join(os.homedir(), ".daygle", "history"));
const chatHistoryStore = new ChatHistoryStore(path.join(os.homedir(), ".daygle", "chat-history"));

function persistChat(session: ChatSession): void {
  const messages = session.messages.length > MAX_CHAT_HISTORY_MESSAGES
    ? [
        ...session.messages.filter((message) => message.role === "system").slice(0, 1),
        { role: "system" as const, content: "Older transcript turns were dropped from durable storage to enforce the chat history quota." },
        ...session.messages.slice(-(MAX_CHAT_HISTORY_MESSAGES - 2)),
      ]
    : session.messages;
  chatHistoryStore.save({
    id: session.id,
    repoUrl: session.repoUrl,
    model: session.model,
    ollamaUrl: session.ollamaUrl,
    title: deriveTitle(session.messages),
    messages,
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
    ollamaUrl: localOllamaUrl(stored.ollamaUrl) ?? DEFAULT_OLLAMA_URL,
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
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/** Allow browser calls only from the local UI, never from arbitrary web origins. */
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (isAllowedUiOrigin(origin, ALLOWED_UI_ORIGINS)) {
    res.setHeader("Access-Control-Allow-Origin", origin!);
    res.setHeader("Vary", "Origin");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

/**
 * Turns an unknown thrown value into a short, single-line message safe to
 * send to clients. Error `message` fields can embed full stack traces (e.g.
 * child_process failures), which would leak internal paths and function
 * names - so everything after the first line is dropped.
 */
function errMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const token = loadGithubToken();
  const text = token ? raw.replaceAll(token, "[credential redacted]") : raw;
  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  return firstLine.length > 500 ? `${firstLine.slice(0, 500)}…` : firstLine;
}

function publish(job: Job, event: AgentEvent): void {
  if (event.type === "tool_start" || event.type === "tool_result" || event.type === "diff") {
    audit(`job:${job.id}`, event);
  }
  if (event.type === "model_delta" || event.type === "diff") {
    // Streaming deltas and diff snapshots are live-only; the full `model` event and
    // the tool results are what get persisted.
    for (const listener of job.listeners) listener(event);
    return;
  }
  const storedEvent = event.type === "tool_result"
    ? { ...event, result: event.result.slice(0, 4_000) }
    : event.type === "model"
      ? { ...event, content: event.content.slice(0, 12_000) }
      : event;
  job.events.push(storedEvent);
  if (job.events.length > MAX_STORED_JOB_EVENTS) job.events.splice(0, job.events.length - MAX_STORED_JOB_EVENTS);
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
        : "No container sandbox available - commands run on the host (policy-gated).",
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
      if (job.config?.generateTests !== false) {
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
          sandbox: sandbox ?? undefined,
          onStatus: (message) => emit({ type: "status", message }),
        });
        publish(job, { type: "qa", command: qa.command, output: qa.output, passed: qa.passed, skipped: !qa.ran });
        return qa;
      };
      const runQaFixLoop = async (): Promise<void> => {
        let qa = await runQaOnce();
        for (let round = 0; round < maxQaRounds && qa.ran && !qa.passed; round++) {
          emit({ type: "status", message: `QA failed - fix round ${round + 1}…` });
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
      // Every autonomous task gets a second-pass review by default. Users can
      // still disable it explicitly with an empty review model in config.
      const reviewModel = job.config?.reviewModel === "" ? "" : (job.config?.reviewModel?.trim() || job.model);
      if (reviewModel) {
        const maxRounds = Math.max(0, Math.min(5, job.config?.maxReviewRounds ?? 2));
        for (let round = 0; round <= maxRounds; round++) {
          const { diff } = await workingDiff(workDir).catch(() => ({ stat: "", diff: "" }));
          if (!diff.trim()) break;
          const agentic = job.config?.agenticReview !== false;
          emit({ type: "status", message: `${agentic ? "Agentic review" : "AI review"} by ${reviewModel}…` });
          const review = agentic
            ? await runAgenticReview({
                root: workDir,
                ollamaUrl: job.ollamaUrl,
                model: reviewModel,
                task: job.task,
                diff,
                emit,
                approve: reviewApproverForRoot(workDir),
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
            emit({ type: "status", message: "Reviewer still has concerns - opening the PR with review notes." });
            break;
          }
          reviewFixRounds += 1;
          emit({ type: "status", message: `Reviewer requested changes - fix round ${round + 1}…` });
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

      emit({ type: "status", message: `${changed.length} file(s) changed - committing…` });
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
      publish(job, { type: "error", message: errMessage(err) });
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
  applyCors(req, res);
  void (async () => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? LOOPBACK_HOST}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/audit") {
      const limit = Number(url.searchParams.get("limit") ?? "200");
      sendJson(res, 200, { entries: readAuditLog(url.searchParams.get("scope") || undefined, Number.isFinite(limit) ? limit : 200) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      const gh = await ghAuthenticated();
      const app = githubAppAvailable();
      const token = loadGithubToken();
      sendJson(res, 200, { ok: true, gh, app, token: !!token, sandbox: sandbox?.name ?? null });
      return;
    }

    // Exercising the sandbox: re-detect the backend on demand (so a backend
    // installed since the agent started is picked up without a restart), then
    // run a trivial command through it so the UI can show not just which
    // backend is active, but whether it actually works right now.
    if (req.method === "GET" && url.pathname === "/api/sandbox/check") {
      const fresh = await detectSandbox();
      if (fresh?.name !== sandbox?.name) {
        sandbox = fresh;
        console.log(fresh ? `command sandbox: ${fresh.name}` : "command sandbox: none (host execution)");
      }
      try {
        if (!sandbox) {
          sendJson(res, 200, {
            ok: false,
            name: null,
            output: "No sandbox backend detected - commands run on the host (policy-gated).",
          });
          return;
        }
        const result = await sandbox.runCapture(os.tmpdir(), "true", { timeoutMs: 60_000 });
        const output =
          result.code === 0
            ? `Sandbox check passed - ${sandbox.name} ran a test command successfully.`
            : `Sandbox check failed (exit ${result.code ?? "error"}).\n${(
                `${result.stdout}\n${result.stderr}`
              )
                .trim()
                .slice(0, 4000)}`;
        sendJson(res, 200, { ok: result.code === 0, name: sandbox.name, output });
      } catch (err) {
        sendJson(res, 200, {
          ok: false,
          name: sandbox?.name ?? null,
          output: `Sandbox check failed: ${errMessage(err)}`,
        });
      }
      return;
    }

    if (url.pathname === "/api/github-token") {
      if (req.method === "GET") {
        // Never send the GitHub credential back to a browser. The UI only needs
        // to know whether one is configured; jobs read it server-side.
        sendJson(res, 200, { configured: Boolean(loadGithubToken()) });
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

    // Cancel an in-flight chat generation for a session. Works regardless of
    // which client (or none) is currently attached to the stream.
    const chatCancelMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/cancel$/);
    if (chatCancelMatch && req.method === "POST") {
      const cancel = activeChatRuns.get(chatCancelMatch[1]);
      if (cancel) cancel();
      sendJson(res, 200, { ok: true, cancelled: Boolean(cancel) });
      return;
    }

    // Restore the checkout to the snapshot taken immediately before the latest
    // chat task. This is deliberately scoped to the live clone and never
    // touches the user's source checkout.
    const chatRevertMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/revert(?:\/([^/]+))?$/);
    if (chatRevertMatch && req.method === "POST") {
      const sessionId = chatRevertMatch[1];
      const requestedId = chatRevertMatch[2];
      const session = chatSessions.get(sessionId);
      const records = loadChatCheckpoints(sessionId);
      const index = requestedId ? records.findIndex((record) => record.id === requestedId) : records.length - 1;
      const selected = index >= 0 ? records[index] : undefined;
      if (!session || !session.root) {
        sendJson(res, 404, { error: "Chat workspace not found." });
        return;
      }
      if (session.busy) {
        sendJson(res, 409, { error: "Stop the current response before reverting." });
        return;
      }
      if (!selected) {
        sendJson(res, 409, { error: "No task checkpoint is available yet." });
        return;
      }
      try {
        await restoreCheckpoint(session.root, selected.checkpoint);
        for (const record of records.splice(index)) deleteChatCheckpoint(record);
        chatCheckpoints.set(sessionId, records);
        audit(`chat:${sessionId}`, { type: "revert", diff: `working tree restored to checkpoint ${selected.id}` });
        sendJson(res, 200, { ok: true, checkpointId: selected.id });
      } catch (err) {
        sendJson(res, 400, { error: `Failed to revert workspace: ${errMessage(err)}` });
      }
      return;
    }

    const chatCheckpointListMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/checkpoints$/);
    if (chatCheckpointListMatch && req.method === "GET") {
      const records = loadChatCheckpoints(chatCheckpointListMatch[1]);
      pruneChatCheckpoints(records);
      sendJson(res, 200, { checkpoints: records.map(({ id, createdAt }) => ({ id, createdAt })) });
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
          sendJson(res, 400, { error: `Failed to restore chat: ${errMessage(err)}` });
          return;
        }
      }
      if (!session) {
        sendJson(res, 404, { error: "Chat not found." });
        return;
      }
      if (!session.root) {
        sendJson(res, 200, { files: [], changedFiles: [], stat: "", diff: "", checkpoints: [] });
        return;
      }
      try {
        const filesResult = await runTool(session.root, "list_files", {});
        const { stat, diff } = await workingDiff(session.root);
        const changed = await changedFiles(session.root);
        const files = filesResult === "(empty)"
          ? []
          : filesResult.split(/\r?\n/).filter(Boolean);
        const checkpoints = loadChatCheckpoints(sessionId);
        pruneChatCheckpoints(checkpoints);
        sendJson(res, 200, {
          files,
          changedFiles: changed,
          stat,
          diff,
          checkpoints: checkpoints.map(({ id, createdAt }) => ({ id, createdAt })),
        });
      } catch (err) {
        sendJson(res, 400, { error: errMessage(err) });
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
          sendJson(res, 400, { error: `Failed to restore chat: ${errMessage(err)}` });
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
        audit(`chat:${sessionId}`, event);
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          // socket already closed
        }
      };

      try {
        // 1) QA gate - install deps if needed, run detected/configured checks.
        const qa = await runQaGate({
          root: session.root,
          command: body.qaCommand?.trim() || undefined,
          signal: controller.signal,
          sandbox: sandbox ?? undefined,
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
                  approve: reviewApproverForRoot(session.root),
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
          emit({ type: "error", message: errMessage(err) });
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
        const checkpoints = chatCheckpoints.get(id) ?? loadChatCheckpoints(id);
        for (const checkpoint of checkpoints) deleteChatCheckpoint(checkpoint);
        chatCheckpoints.delete(id);
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
      const ollamaUrl = localOllamaUrl(body.ollamaUrl);
      if (!ollamaUrl) {
        sendJson(res, 400, { error: "ollamaUrl must point to the local Ollama server." });
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
          sendJson(res, 400, { error: `Failed to clone repo: ${errMessage(err)}` });
          return;
        }
      }
      const session: ChatSession = {
        id,
        repoUrl,
        root: dir,
        model: body.model.trim(),
        ollamaUrl,
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
        // Session expired from memory - restore it from disk if we have a transcript.
        try {
          session = (await rehydrateChat(sessionId)) ?? undefined;
        } catch (err) {
          sendJson(res, 400, { error: `Failed to restore chat: ${errMessage(err)}` });
          return;
        }
        if (!session) {
          sendJson(res, 404, { error: "Chat session not found." });
          return;
        }
      }
      if (session.busy) {
        sendJson(res, 409, { error: "This chat is already working. Queue the message in the client and try again when it finishes." });
        return;
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
      if (session.root) {
        const checkpointId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const checkpointDir = path.join(CHECKPOINT_ROOT, sessionId, checkpointId);
        try {
          const checkpoint = await createCheckpoint(session.root, checkpointDir);
          const records = loadChatCheckpoints(sessionId);
          const record: ChatCheckpointRecord = { sessionId, id: checkpointId, createdAt: Date.now(), checkpoint };
          records.push(record);
          records.sort((a, b) => a.createdAt - b.createdAt);
          saveCheckpointManifest(record);
          pruneChatCheckpoints(records);
        } catch (err) {
          fs.rmSync(checkpointDir, { recursive: true, force: true });
          sendJson(res, 500, { error: `Could not create a safety checkpoint: ${errMessage(err)}` });
          return;
        }
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
        audit(`chat:${sessionId}`, event);
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

      // Stops this run: aborts generation and releases any waiting approvals so
      // the generator doesn't hang. Shared by client disconnect and /cancel.
      const cancelRun = () => {
        controller.abort();
        for (const id of localApprovals) {
          const pending = pendingApprovals.get(id);
          if (pending) {
            pendingApprovals.delete(id);
            clearTimeout(pending.timer);
            pending.resolve("deny");
          }
        }
      };
      req.on("close", cancelRun);

      // Mark the session busy so a client that navigated away and came back can
      // detect the in-flight generation and reconnect to it (see getChatSession),
      // and register a cancel handle so Stop works from a reconnected view.
      session.busy = true;
      activeChatRuns.set(sessionId, cancelRun);
      try {
        for await (const event of streamChat(session, body.message.trim(), approve, sandbox ?? undefined, controller.signal, image)) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      } catch (err) {
        if (!(err instanceof Error && err.name === "AbortError")) {
          res.write(`data: ${JSON.stringify({ type: "error", message: errMessage(err) })}\n\n`);
        }
      } finally {
        session.busy = false;
        if (activeChatRuns.get(sessionId) === cancelRun) activeChatRuns.delete(sessionId);
      }
      // Persist the transcript so the conversation survives restarts / TTL eviction.
      session.lastActivity = Date.now();
      persistChat(session);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/model-updates") {
      // Model-registry requests run from this server; never trust a browser-
      // supplied Ollama destination, even though the UI normally uses a proxy.
      const ollamaUrl = DEFAULT_OLLAMA_URL;
      const names = (url.searchParams.get("names") ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
        .slice(0, 50);
      if (names.length === 0) {
        sendJson(res, 400, { error: "At least one model name is required." });
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

      const ollamaUrl = localOllamaUrl(body.ollamaUrl);
      if (!ollamaUrl) {
        sendJson(res, 400, { error: "ollamaUrl must point to the local Ollama server." });
        return;
      }

      const job: Job = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        repoUrl: body.repoUrl.trim(),
        task: body.task.trim(),
        model: body.model.trim(),
        baseBranch: (body.baseBranch ?? "").trim(),
        ollamaUrl,
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
  })().catch((err) => {
    // Safety net: an unexpected throw in any handler must not become an
    // unhandled rejection that leaves the socket hanging.
    console.error("request handler failed:", err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: errMessage(err) });
    } else {
      res.end();
    }
  });
});

function startListening(): void {
  server.listen(PORT, HOST, () => {
    console.log(`daygle agent listening on http://localhost:${PORT}`);
  });
}

detectSandbox()
  .then((runner) => {
    sandbox = runner;
    console.log(runner ? `command sandbox: ${runner.name}` : "command sandbox: none (host execution)");
    // Pre-pull the sandbox image in the background so the first sandboxed
    // command doesn't stall on the download (no-op for bubblewrap).
    runner?.warmup?.();
    startListening();
  })
  .catch((err) => {
    // Sandbox detection is best-effort; never leave the server unstarted.
    console.error("sandbox detection failed:", err instanceof Error ? err.message : err);
    startListening();
  });
