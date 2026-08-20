import { describeError, pullModel, type PullProgress } from "./ollama";

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
    await pullModel(baseUrl, target, (progress) => set({ progress }));
    set({ progress: { status: "done" }, pulling: false });
    await onComplete?.();
    // Briefly show "done", then clear — unless another pull has started since.
    clearTimer = setTimeout(() => {
      if (!state.pulling && state.name === target) {
        set({ name: null, progress: null });
      }
    }, 1200);
  } catch (err) {
    set({ name: null, progress: null, pulling: false, error: describeError(err) });
  }
}
