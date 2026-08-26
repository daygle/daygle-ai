import {
  describeError,
  OllamaConnectionInterrupted,
  pullModel,
  type PullProgress,
} from "./ollama";
import {
  DEFAULT_AGENT_URL,
  listModelPulls,
  openModelPullEvents,
  startModelPull,
} from "./agent";

/** Re-pull attempts after a mid-download connection drop (Ollama resumes). */
const MAX_RESUME_ATTEMPTS = 8;

function resumeDelayMs(attempt: number): number {
  return Math.min(8000, 1000 * 2 ** (attempt - 1));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Module-level manager for an in-flight model download. It owns the pull so the
 * download and its progress survive navigating away from the Models page (the
 * component subscribes and reflects the live state on return).
 *
 * When the agent server is running, the download runs there and this manager
 * only attaches to its progress over SSE - so the download completes even if the
 * browser is closed entirely, and can be reattached on a later visit. If the
 * agent is unreachable, it falls back to a browser-driven pull that reconnects
 * and resumes (via Ollama's partial blobs) when the stream drops.
 */
export interface PullState {
  name: string | null;
  progress: PullProgress | null;
  pulling: boolean;
  error: string | null;
  /** True while the active download is running on the agent server. */
  serverSide: boolean;
}

let state: PullState = { name: null, progress: null, pulling: false, error: null, serverSide: false };
const listeners = new Set<(state: PullState) => void>();
let clearTimer: ReturnType<typeof setTimeout> | undefined;
// Unsubscribe from the current server-side progress stream, if any.
let detachServer: (() => void) | undefined;

function set(patch: Partial<PullState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener(state));
}

export function getPullState(): PullState {
  return state;
}

export function subscribePull(listener: (state: PullState) => void): () => void {
  listeners.add(listener);
  listener(state); // push current state immediately (reconnect on mount)
  return () => {
    listeners.delete(listener);
  };
}

function finishSuccess(target: string, onComplete?: () => void | Promise<void>) {
  set({ progress: { status: "done" }, pulling: false });
  void Promise.resolve(onComplete?.()).finally(() => {
    // Briefly show "done", then clear - unless another pull has started since.
    clearTimer = setTimeout(() => {
      if (!state.pulling && state.name === target) {
        set({ name: null, progress: null, serverSide: false });
      }
    }, 1200);
  });
}

/**
 * Attach to a server-side pull's SSE progress. Resolves when the download
 * reaches a terminal state. EventSource reconnects on its own if the browser's
 * connection drops, while the agent keeps downloading.
 */
function attachServerPull(
  agentUrl: string,
  target: string,
  onComplete?: () => void | Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve) => {
    detachServer?.();
    detachServer = openModelPullEvents(agentUrl, target, (event) => {
      if (state.name !== target) return; // superseded
      if (event.type === "progress") {
        set({ progress: event.progress });
      } else if (event.type === "done") {
        detachServer = undefined;
        finishSuccess(target, onComplete);
        resolve();
      } else {
        detachServer = undefined;
        set({ name: null, progress: null, pulling: false, serverSide: false, error: event.message });
        resolve();
      }
    });
  });
}

/** Browser-driven pull with reconnect-and-resume on a dropped stream. */
async function browserPull(
  baseUrl: string,
  target: string,
  onComplete?: () => void | Promise<void>,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pullModel(baseUrl, target, (progress) => {
        if (state.name === target) set({ progress });
      });
      break;
    } catch (err) {
      if (!(err instanceof OllamaConnectionInterrupted) || attempt >= MAX_RESUME_ATTEMPTS) throw err;
      set({
        progress: {
          status: `connection dropped - reconnecting (attempt ${attempt + 1})…`,
          percent: state.progress?.percent,
        },
      });
      await sleep(resumeDelayMs(attempt));
      if (state.name !== target) return; // superseded by another pull
    }
  }
  finishSuccess(target, onComplete);
}

/**
 * Start a model pull. No-ops if one is already running. `onComplete` (e.g. a
 * models refresh) runs after a successful pull; it's captured here so it still
 * fires even if the initiating page has since unmounted.
 */
export async function startPull(
  baseUrl: string,
  name: string,
  onComplete?: () => void | Promise<void>,
  agentUrl: string = DEFAULT_AGENT_URL,
): Promise<void> {
  const target = name.trim();
  if (!target || state.pulling) return;
  if (clearTimer) clearTimeout(clearTimer);
  detachServer?.();
  detachServer = undefined;
  set({ name: target, pulling: true, progress: null, error: null, serverSide: false });

  // Prefer a server-side pull so the download survives a browser disconnect.
  // Fall back to a browser-driven pull if the agent isn't reachable.
  try {
    await startModelPull(agentUrl, target, baseUrl);
    set({ serverSide: true });
    await attachServerPull(agentUrl, target, onComplete);
    return;
  } catch {
    // Agent unavailable (or refused the request) - drive the pull from the browser.
    if (state.name !== target) return;
    set({ serverSide: false });
  }

  try {
    await browserPull(baseUrl, target, onComplete);
  } catch (err) {
    set({ name: null, progress: null, pulling: false, serverSide: false, error: describeError(err, baseUrl) });
  }
}

/**
 * Reattach to a pull already running on the agent server - e.g. after a full
 * browser restart during a long download. No-ops if a pull is already tracked
 * locally or the agent is unreachable.
 */
export async function reattachServerPull(
  agentUrl: string = DEFAULT_AGENT_URL,
  onComplete?: () => void | Promise<void>,
): Promise<void> {
  if (state.pulling || state.name) return;
  let pulls: Awaited<ReturnType<typeof listModelPulls>>;
  try {
    pulls = await listModelPulls(agentUrl);
  } catch {
    return; // agent not running - nothing to reattach
  }
  const active = pulls.find((p) => p.status === "running");
  if (!active) return;
  if (clearTimer) clearTimeout(clearTimer);
  set({
    name: active.name,
    pulling: true,
    progress: active.progress,
    error: null,
    serverSide: true,
  });
  void attachServerPull(agentUrl, active.name, onComplete);
}
