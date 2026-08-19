import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CancelledError, runAgentLoop, runReview, type AgentConfig, type AgentEvent } from "./agent";
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
import { HistoryStore, type StoredJob } from "./history";
import { runQaGate, type QaResult } from "./qa";
import { checkModelUpdate } from "./updates";
import {
  commitWorkspace,
  connectWorkspace,
  currentBranch,
  openWorkspacePr,
  pullWorkspace,
  pushWorkspace,
  statusWorkspace,
  type WorkspaceStatus,
} from "./workspace";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";

let sandbox: SandboxRunner | null = null;

let workspace: { repoUrl: string; dir: string } | null = null;

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
  jobId: string;
  resolve: (decision: "approve" | "deny") => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingApprovals = new Map<string, PendingApproval>();

const historyStore = new HistoryStore(path.join(os.homedir(), ".daygle", "history"));

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
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > 1_000_000) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
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
  const workspaceMode = !!job.config?.workspace;
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

    if (workspaceMode) {
      if (!workspace) {
        throw new Error("No workspace connected — connect a repo in the Workspace panel first.");
      }
      workDir = workspace.dir;
      const wb = await currentBranch(workDir).catch(() => "");
      emit({ type: "status", message: `Working in persistent workspace ${workspace.repoUrl} (branch: ${wb || "?"})…` });
    } else {
      appMode = githubAppAvailable();
      if (appMode) {
        const parsed = parseRepo(job.repoUrl);
        repoOwner = parsed.owner;
        repoName = parsed.repo;
        emit({ type: "status", message: "Requesting repo-scoped GitHub App token…" });
        token = await createInstallationToken(repoOwner);
      }

      emit({ type: "status", message: `Cloning ${job.repoUrl}…` });
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), "daygle-"));
      tempWorkDir = true;
      await cloneRepo(job.repoUrl, workDir, token);

      base = job.baseBranch || (await detectDefaultBranch(job.repoUrl, token));
      branch = `daygle/${slugify(job.task)}-${Date.now().toString(36)}`;
      emit({ type: "status", message: `Branch ${branch} (base ${base})` });
      await createBranch(workDir, branch);
    }

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
    }    const changed = await changedFiles(workDir);
    if (workspaceMode) {
      // Leave changes uncommitted — the user delivers from the Workspace panel.
      job.summary = summary;
      job.status = "done";
      job.finishedAt = Date.now();
      publish(job, { type: "done", summary, changedFiles: changed, pending: changed.length > 0 });
    } else if (changed.length > 0) {
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
          emit({ type: "status", message: `AI review by ${reviewModel}…` });
          const review = await runReview({
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
      sendJson(res, 200, { ok: true, gh, app, sandbox: sandbox?.name ?? null });
      return;
    }

    if (url.pathname.startsWith("/api/workspace")) {
      if (req.method === "GET" && url.pathname === "/api/workspace") {
        if (!workspace) {
          sendJson(res, 200, { connected: false } as WorkspaceStatus);
          return;
        }
        sendJson(res, 200, await statusWorkspace(workspace.repoUrl, workspace.dir));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/workspace/connect") {
        let body: { repoUrl?: string };
        try {
          body = JSON.parse(await readBody(req)) as { repoUrl?: string };
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body." });
          return;
        }
        if (!body.repoUrl?.trim()) {
          sendJson(res, 400, { error: "repoUrl is required." });
          return;
        }
        try {
          const status = await connectWorkspace(body.repoUrl.trim());
          workspace = { repoUrl: status.repoUrl ?? body.repoUrl.trim(), dir: status.dir ?? "" };
          sendJson(res, 200, status);
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (!workspace) {
        sendJson(res, 409, { error: "No workspace connected. Connect a repo in the Workspace panel first." });
        return;
      }
      const dir = workspace.dir;
      const repoUrl = workspace.repoUrl;
      try {
        if (req.method === "POST" && url.pathname === "/api/workspace/pull") {
          await pullWorkspace(dir);
        } else if (req.method === "POST" && url.pathname === "/api/workspace/commit") {
          const body = JSON.parse(await readBody(req)) as { message?: string };
          if (!body.message?.trim()) {
            sendJson(res, 400, { error: "message is required." });
            return;
          }
          await commitWorkspace(dir, body.message.trim());
        } else if (req.method === "POST" && url.pathname === "/api/workspace/push") {
          await pushWorkspace(dir);
        } else if (req.method === "POST" && url.pathname === "/api/workspace/pr") {
          const body = JSON.parse(await readBody(req)) as { title?: string; body?: string };
          const title = body.title?.trim() || "daygle: workspace changes";
          const prUrl = await openWorkspacePr(dir, title, body.body?.trim());
          sendJson(res, 200, { prUrl });
          return;
        } else {
          sendJson(res, 404, { error: "Not found." });
          return;
        }
        sendJson(res, 200, await statusWorkspace(repoUrl, dir));
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
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
