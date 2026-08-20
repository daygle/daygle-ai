/** User-tunable Ollama generation parameters (mirrors the agent-side type). */
export interface GenOptions {
  temperature?: number;
  num_ctx?: number;
  top_p?: number;
  top_k?: number;
  repeat_penalty?: number;
  keep_alive?: string;
}

export const DEFAULT_GEN_OPTIONS: GenOptions = {
  temperature: 0.3,
  num_ctx: 16384,
};

const STORAGE_KEY = "daygle.genOptions";

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
    // localStorage unavailable — ignore
  }
}
