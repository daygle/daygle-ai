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
const MODEL_STORAGE_KEY = "daygle.model";

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

export function loadModelPreference(): string {
  try {
    return localStorage.getItem(MODEL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveModelPreference(model: string): void {
  try {
    if (model) localStorage.setItem(MODEL_STORAGE_KEY, model);
    else localStorage.removeItem(MODEL_STORAGE_KEY);
  } catch {
    // localStorage unavailable - ignore
  }
}
