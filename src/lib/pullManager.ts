import {
  describeError,
  OllamaConnectionInterrupted,
  pullModel,
  type PullProgress,
} from "./ollama";

/** Re-pull attempts after a mid-download connection drop (Ollama resumes). */
const MAX_RESUME_ATTEMPTS = 8;

function resumeDelayMs(attempt: number): number {
  return Math.min(8000, 1000 * 2 ** (attempt - 1));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Module-level manager for an in-flight model download. It owns the pull stream
 * so the download and its progress survive navigating away from the Models page
 * (the component subscribes and reflects the live state on return), instead of
 * appearing to stop when the page unmounts.
 */
export interface PullState {
  name: string | null;
  progress: PullProgress | null;
  pulling: boolean;
  error: string | null;
}

let state: PullState = { name: null, progress: null, pulling: false, error: null };
const listeners = new Set<(state: PullState) => void>();
let clearTimer: ReturnType<typeof setTimeout> | undefined;

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

/**
 * Start a model pull. No-ops if one is already running. `onComplete` (e.g. a
 * models refresh) runs after a successful pull; it's captured here so it still
 * fires even if the initiating page has since unmounted.
 */
export async function startPull(
  baseUrl: string,
  name: string,
  onComplete?: () => void | Promise<void>,
): Promise<void> {
  const target = name.trim();
  if (!target || state.pulling) return;
  if (clearTimer) clearTimeout(clearTimer);
  set({ name: target, pulling: true, progress: null, error: null });
  try {
    // A slow or flaky connection - or a phone locking/backgrounding the tab -
    // can cut a long download's stream mid-transfer. Ollama keeps the partial
    // blobs, so on an interrupted connection we reconnect and re-issue the pull;
    // it resumes rather than restarting. Only genuinely interrupted streams are
    // retried - a real Ollama error (bad model name, etc.) fails immediately.
    for (let attempt = 1; ; attempt++) {
      try {
        await pullModel(baseUrl, target, (progress) => set({ progress }));
        break;
      } catch (err) {
        const resumable = err instanceof OllamaConnectionInterrupted;
        if (!resumable || attempt >= MAX_RESUME_ATTEMPTS) throw err;
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
    set({ progress: { status: "done" }, pulling: false });
    await onComplete?.();
    // Briefly show "done", then clear - unless another pull has started since.
    clearTimer = setTimeout(() => {
      if (!state.pulling && state.name === target) {
        set({ name: null, progress: null });
      }
    }, 1200);
  } catch (err) {
    set({ name: null, progress: null, pulling: false, error: describeError(err, baseUrl) });
  }
}
