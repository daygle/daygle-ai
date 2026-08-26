/**
 * Server-side model-pull manager.
 *
 * A model download can take many minutes. Driving it from the browser means a
 * flaky connection, a closed tab, or a phone locking the screen aborts it. This
 * module runs the pull on the agent server instead: once started it streams from
 * Ollama and continues to completion regardless of whether any browser is
 * connected. The UI attaches to live progress over SSE and can reattach after a
 * disconnect (or a full browser restart) while the download keeps going here.
 *
 * Ollama keeps partially downloaded blobs, so a dropped stream between the agent
 * and Ollama is resumed by re-issuing the same pull rather than restarting.
 */

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
  percent?: number;
}

export type PullEvent =
  | { type: "progress"; progress: PullProgress }
  | { type: "done" }
  | { type: "error"; message: string };

export type PullStatus = "running" | "done" | "error";

export interface PullSnapshot {
  name: string;
  status: PullStatus;
  progress: PullProgress | null;
  error?: string;
}

interface PullJob {
  name: string;
  ollamaUrl: string;
  status: PullStatus;
  progress: PullProgress | null;
  error?: string;
  listeners: Set<(event: PullEvent) => void>;
  controller: AbortController;
  createdAt: number;
  finishedAt?: number;
  evictTimer?: ReturnType<typeof setTimeout>;
}

/** Re-pull attempts after a mid-download connection drop (Ollama resumes). */
const MAX_RESUME_ATTEMPTS = 8;
/** How long a finished pull stays queryable so a reconnecting UI sees the result. */
const DONE_TTL_MS = 2 * 60 * 1000;

const pulls = new Map<string, PullJob>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const resumeDelayMs = (attempt: number) => Math.min(8000, 1000 * 2 ** (attempt - 1));

function firstLine(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).split(/\r?\n/, 1)[0].trim();
  return text || "Pull failed.";
}

function snapshot(job: PullJob): PullSnapshot {
  return { name: job.name, status: job.status, progress: job.progress, error: job.error };
}

function emit(job: PullJob, event: PullEvent): void {
  if (event.type === "progress") job.progress = event.progress;
  for (const listener of job.listeners) listener(event);
}

/** A mid-stream drop that Ollama can resume - retried rather than surfaced. */
class StreamInterrupted extends Error {}

/** A real error Ollama reported in the stream (bad model, etc.) - never retried. */
class OllamaStreamError extends Error {}

export function listPulls(): PullSnapshot[] {
  return [...pulls.values()].map(snapshot);
}

export function getPull(name: string): PullSnapshot | undefined {
  const job = pulls.get(name);
  return job ? snapshot(job) : undefined;
}

/**
 * Subscribe to a pull's events. Immediately replays the latest known state so a
 * (re)connecting client is caught up, then streams live events. Returns an
 * unsubscribe function; for an already-finished pull it fires the terminal event
 * and there is nothing to unsubscribe.
 */
export function subscribePull(name: string, listener: (event: PullEvent) => void): () => void {
  const job = pulls.get(name);
  if (!job) {
    listener({ type: "error", message: "No active download for this model." });
    return () => {};
  }
  if (job.progress) listener({ type: "progress", progress: job.progress });
  if (job.status === "done") {
    listener({ type: "done" });
    return () => {};
  }
  if (job.status === "error") {
    listener({ type: "error", message: job.error ?? "Pull failed." });
    return () => {};
  }
  job.listeners.add(listener);
  return () => job.listeners.delete(listener);
}

export function cancelPull(name: string): boolean {
  const job = pulls.get(name);
  if (!job || job.status !== "running") return false;
  job.controller.abort();
  return true;
}

/**
 * Start (or attach to) a server-side pull for `name`. Idempotent: if a pull for
 * the same model is already running, the existing job is returned so callers
 * share one download.
 */
export function startPull(ollamaUrl: string, name: string): PullSnapshot {
  const target = name.trim();
  const existing = pulls.get(target);
  if (existing && existing.status === "running") return snapshot(existing);

  const job: PullJob = {
    name: target,
    ollamaUrl: ollamaUrl.replace(/\/+$/, ""),
    status: "running",
    progress: null,
    listeners: new Set(),
    controller: new AbortController(),
    createdAt: Date.now(),
  };
  pulls.set(target, job);
  void run(job);
  return snapshot(job);
}

function scheduleEvict(job: PullJob): void {
  if (job.evictTimer) clearTimeout(job.evictTimer);
  job.evictTimer = setTimeout(() => {
    // Only evict if this exact job is still the registered one and it's finished.
    if (pulls.get(job.name) === job && job.status !== "running") pulls.delete(job.name);
  }, DONE_TTL_MS);
  job.evictTimer.unref?.();
}

async function run(job: PullJob): Promise<void> {
  const completedByDigest = new Map<string, number>();
  const totalByDigest = new Map<string, number>();
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await pullOnce(job, completedByDigest, totalByDigest);
        break;
      } catch (err) {
        if (job.controller.signal.aborted) throw err;
        if (!(err instanceof StreamInterrupted) || attempt >= MAX_RESUME_ATTEMPTS) throw err;
        emit(job, {
          type: "progress",
          progress: {
            ...(job.progress ?? { status: "" }),
            status: `connection to Ollama dropped - reconnecting (attempt ${attempt + 1})…`,
          },
        });
        await sleep(resumeDelayMs(attempt));
      }
    }
    job.status = "done";
    job.finishedAt = Date.now();
    emit(job, { type: "done" });
  } catch (err) {
    job.status = "error";
    job.finishedAt = Date.now();
    job.error = job.controller.signal.aborted ? "Download cancelled." : firstLine(err);
    emit(job, { type: "error", message: job.error });
  } finally {
    job.listeners.clear();
    scheduleEvict(job);
  }
}

async function pullOnce(
  job: PullJob,
  completedByDigest: Map<string, number>,
  totalByDigest: Map<string, number>,
): Promise<void> {
  const res = await fetch(`${job.ollamaUrl}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: job.name, stream: true }),
    signal: job.controller.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Failed to pull model (${res.status}).`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedAny = false;

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event.error) throw new OllamaStreamError(String(event.error));
    const status = typeof event.status === "string" ? event.status : "";
    if (status === "downloading" && typeof event.digest === "string") {
      if (typeof event.completed === "number") completedByDigest.set(event.digest, event.completed);
      if (typeof event.total === "number") totalByDigest.set(event.digest, event.total);
    }
    let completed = 0;
    let total = 0;
    completedByDigest.forEach((value) => (completed += value));
    totalByDigest.forEach((value) => (total += value));
    emit(job, {
      type: "progress",
      progress: {
        status,
        completed: total ? completed : typeof event.completed === "number" ? event.completed : undefined,
        total: total || (typeof event.total === "number" ? event.total : undefined),
        percent: total ? Math.min(100, Math.round((completed / total) * 100)) : undefined,
      },
    });
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedAny = true;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    }
  } catch (err) {
    // A real Ollama error reported in the stream is fatal - propagate it.
    if (err instanceof OllamaStreamError) throw err;
    // A cancellation is terminal.
    if (job.controller.signal.aborted) throw err;
    // Any other failure while reading is a dropped connection. If the download
    // had started, it's resumable (Ollama keeps partial blobs); otherwise the
    // request never really got going, so surface it.
    if (receivedAny) throw new StreamInterrupted();
    throw err;
  }
  if (buffer.trim()) handleLine(buffer);
}

/** Test-only: clear the registry between cases. */
export function _resetPullsForTest(): void {
  for (const job of pulls.values()) {
    if (job.evictTimer) clearTimeout(job.evictTimer);
    job.controller.abort();
  }
  pulls.clear();
}
