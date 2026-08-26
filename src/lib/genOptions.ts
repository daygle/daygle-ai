/** User-tunable Ollama generation parameters (mirrors the agent-side type). */
export interface GenOptions {
  temperature?: number;
  num_ctx?: number;
  top_p?: number;
  top_k?: number;
  repeat_penalty?: number;
  keep_alive?: string;
  // CPU / performance tuning (see the Performance section in Settings).
  num_thread?: number;
  num_batch?: number;
  num_gpu?: number;
}

export const DEFAULT_GEN_OPTIONS: GenOptions = {
  temperature: 0.3,
  num_ctx: 16384,
};

const STORAGE_KEY = "daygle.genOptions";

// Per-surface default models. Both fall back to the legacy single-model key so
// existing installs keep their saved choice until they pick per-surface ones.
export type ModelScope = "chat" | "agent";
const CHAT_MODEL_STORAGE_KEY = "daygle.model.chat";
const AGENT_MODEL_STORAGE_KEY = "daygle.model.agent";
const LEGACY_MODEL_STORAGE_KEY = "daygle.model";

export function loadGenOptions(): GenOptions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_GEN_OPTIONS };
    return { ...DEFAULT_GEN_OPTIONS, ...(JSON.parse(raw) as GenOptions) };
  } catch {
    return { ...DEFAULT_GEN_OPTIONS };
  }
}

export function saveGenOptions(options: GenOptions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
  } catch {
    // localStorage unavailable - ignore
  }
}

function modelStorageKey(scope: ModelScope): string {
  return scope === "chat" ? CHAT_MODEL_STORAGE_KEY : AGENT_MODEL_STORAGE_KEY;
}

export function loadModelPreference(scope: ModelScope): string {
  try {
    return localStorage.getItem(modelStorageKey(scope)) ?? localStorage.getItem(LEGACY_MODEL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveModelPreference(model: string, scope: ModelScope): void {
  try {
    if (model) localStorage.setItem(modelStorageKey(scope), model);
    else localStorage.removeItem(modelStorageKey(scope));
  } catch {
    // localStorage unavailable - ignore
  }
}
