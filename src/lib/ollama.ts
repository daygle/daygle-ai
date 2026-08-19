export interface OllamaModelDetails {
  format?: string;
  family?: string;
  families?: string[] | null;
  parameter_size?: string;
  quantization_level?: string;
}

export interface OllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: OllamaModelDetails;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
  percent?: number;
}

export interface ChatDoneInfo {
  doneReason?: string;
  evalCount?: number;
  promptEvalCount?: number;
  totalDuration?: number;
}

export class OllamaError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "OllamaError";
  }
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function parseErrorText(text: string): string {
  try {
    const parsed = JSON.parse(text);
    return parsed.error ?? text;
  } catch {
    return text;
  }
}

export function describeError(err: unknown): string {
  if (err instanceof OllamaError) {
    return err.message;
  }
  if (err instanceof DOMException && err.name === "AbortError") {
    return "Request cancelled.";
  }
  if (err instanceof TypeError) {
    return "Could not reach the Ollama server. Check the URL, make sure `ollama serve` is running, and allow this app's origin with OLLAMA_ORIGINS (see Settings).";
  }
  if (err instanceof Error) {
    return err.message;
  }
  return "Something went wrong.";
}

export async function getVersion(baseUrl: string): Promise<string> {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/api/version`);
  if (!res.ok) {
    throw new OllamaError(`Server responded with ${res.status}.`, res.status);
  }
  const data = (await res.json()) as { version?: string };
  return data.version ?? "unknown";
}

export async function listModels(baseUrl: string): Promise<OllamaModel[]> {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/api/tags`);
  if (!res.ok) {
    throw new OllamaError(`Failed to list models (${res.status}).`, res.status);
  }
  const data = (await res.json()) as { models?: OllamaModel[] };
  return data.models ?? [];
}

export async function getRunningModels(baseUrl: string): Promise<OllamaModel[]> {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/api/ps`);
  if (!res.ok) {
    throw new OllamaError(`Failed to read running models (${res.status}).`, res.status);
  }
  const data = (await res.json()) as { models?: OllamaModel[] };
  return data.models ?? [];
}

export async function showModel(baseUrl: string, name: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/api/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new OllamaError(parseErrorText(await res.text()) || `Failed to load model (${res.status}).`, res.status);
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function deleteModel(baseUrl: string, name: string): Promise<void> {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/api/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new OllamaError(parseErrorText(await res.text()) || `Failed to delete model (${res.status}).`, res.status);
  }
}

export async function pullModel(
  baseUrl: string,
  name: string,
  onProgress: (progress: PullProgress) => void,
): Promise<void> {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, stream: true }),
  });

  if (!res.ok || !res.body) {
    throw new OllamaError(parseErrorText(await res.text().catch(() => "")) || `Failed to pull model (${res.status}).`, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const completedByDigest = new Map<string, number>();
  const totalByDigest = new Map<string, number>();
  let buffer = "";

  const emit = (line: string) => {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event.error) {
      throw new OllamaError(String(event.error));
    }
    const status = typeof event.status === "string" ? event.status : "";
    if (status === "downloading" && typeof event.digest === "string") {
      if (typeof event.completed === "number") completedByDigest.set(event.digest, event.completed);
      if (typeof event.total === "number") totalByDigest.set(event.digest, event.total);
    }

    let completed = 0;
    let total = 0;
    completedByDigest.forEach((value) => (completed += value));
    totalByDigest.forEach((value) => (total += value));

    onProgress({
      status,
      completed: total ? completed : typeof event.completed === "number" ? event.completed : undefined,
      total: total || (typeof event.total === "number" ? event.total : undefined),
      percent: total ? Math.min(100, Math.round((completed / total) * 100)) : undefined,
    });
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) emit(line);
  }
  if (buffer.trim()) emit(buffer);
}

export async function streamChat(
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  onDelta: (delta: string) => void,
  onDone: (info: ChatDoneInfo) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });

  if (!res.ok || !res.body) {
    throw new OllamaError(parseErrorText(await res.text().catch(() => "")) || `Chat failed (${res.status}).`, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.error) {
        throw new OllamaError(String(event.error));
      }
      const message = event.message as { content?: unknown } | undefined;
      if (message && typeof message.content === "string") {
        onDelta(message.content);
      }
      if (event.done) {
        onDone({
          doneReason: typeof event.done_reason === "string" ? event.done_reason : undefined,
          evalCount: typeof event.eval_count === "number" ? event.eval_count : undefined,
          promptEvalCount: typeof event.prompt_eval_count === "number" ? event.prompt_eval_count : undefined,
          totalDuration: typeof event.total_duration === "number" ? event.total_duration : undefined,
        });
      }
    }
  }
}
