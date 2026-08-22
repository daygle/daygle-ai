/**
 * Provider abstraction for chat completions.
 *
 * Normalises the differences between Ollama's `/api/chat` and the
 * OpenAI-compatible `/v1/chat/completions` endpoint used by providers
 * like Hugging Face Inference, Together AI, Groq, DeepSeek, etc.
 */

import type { ToolDefinition } from "./tools";
import { isLoopbackUrl, isSafeExternalUrl } from "./security";

// ── Shared types ────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function: { name: string; arguments: unknown };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface ChatCompletionOptions {
  temperature: number;
  numCtx: number;
  signal?: AbortSignal;
  onDelta?: (chunk: string) => void;
  onToolCall?: (call: RawToolCallDelta) => void;
}

export interface RawToolCallDelta {
  id?: string;
  index?: number;
  function?: { name?: string; arguments?: string };
}

export interface ChatCompletionResult {
  content: string;
  toolCalls: ParsedToolCall[];
}

export interface ParsedToolCall {
  id?: string;
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatProvider {
  readonly name: string;

  /** Send a chat completion request and stream the result. */
  chat(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ChatCompletionOptions,
  ): Promise<ChatCompletionResult>;

  /** List available model names. */
  listModels(): Promise<string[]>;

  /** Check whether the provider is reachable. */
  healthCheck(): Promise<boolean>;
}

// ── Provider config ─────────────────────────────────────────────────────────

export type ProviderKind = "ollama" | "openai";

export interface ProviderConfig {
  kind: ProviderKind;
  /** Base URL — for Ollama e.g. http://localhost:11434, for OpenAI-compatible e.g. https://api.together.xyz/v1 */
  baseUrl: string;
  /** API key (required for cloud providers, ignored for Ollama). */
  apiKey?: string;
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createProvider(config: ProviderConfig): ChatProvider {
  switch (config.kind) {
    case "ollama":
      if (!isLoopbackUrl(config.baseUrl)) throw new Error("Ollama baseUrl must be a loopback address.");
      return new OllamaProvider(config.baseUrl);
    case "openai":
      if (!isSafeExternalUrl(config.baseUrl)) throw new Error("Cloud provider URL must be a public HTTPS address.");
      return new OpenAICompatibleProvider(config.baseUrl, config.apiKey ?? "");
    default:
      throw new Error(`Unknown provider kind: ${config.kind}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseToolCalls(raw: unknown[] | undefined): ParsedToolCall[] {
  return (raw ?? []).map((call: any) => {
    const name = call.function?.name ?? "unknown";
    let args: unknown = call.function?.arguments ?? {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) args = {};
    return { id: call.id, function: { name, arguments: args as Record<string, unknown> } };
  });
}

// ── Ollama ──────────────────────────────────────────────────────────────────

class OllamaProvider implements ChatProvider {
  readonly name = "ollama";

  constructor(private baseUrl: string) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  async chat(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    const { temperature, numCtx, signal, onDelta } = options;
    let res: Response;
    try {
      res = await fetch(this.url("/api/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          tools,
          stream: true,
          options: { temperature, num_ctx: numCtx },
        }),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama /api/chat failed (${res.status}): ${text.slice(0, 500)}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    const isStream = contentType.includes("application/x-ndjson") || contentType.includes("text/event-stream");

    if (!isStream) {
      const data = (await res.json()) as { message?: { content?: string; tool_calls?: unknown[] } };
      const message = data.message ?? {};
      const content = typeof message.content === "string" ? message.content : "";
      if (content) onDelta?.(content);
      return { content, toolCalls: parseToolCalls(message.tool_calls) };
    }

    const reader = res.body?.getReader();
    if (!reader) {
      const data = (await res.json()) as { message?: { content?: string; tool_calls?: unknown[] } };
      const message = data.message ?? {};
      const content = typeof message.content === "string" ? message.content : "";
      if (content) onDelta?.(content);
      return { content, toolCalls: parseToolCalls(message.tool_calls) };
    }

    const decoder = new TextDecoder();
    let content = "";
    const toolCallMap = new Map<number, ParsedToolCall>();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as { message?: { content?: string; tool_calls?: unknown[] }; done?: boolean };
          if (obj.message?.content) {
            content += obj.message.content;
            onDelta?.(obj.message.content);
          }
          if (obj.message?.tool_calls) {
            for (const raw of obj.message.tool_calls) {
              const call = raw as any;
              const idx = call.index ?? 0;
              if (!toolCallMap.has(idx)) {
                toolCallMap.set(idx, { id: call.id, function: { name: call.function?.name ?? "", arguments: {} } });
              }
              const existing = toolCallMap.get(idx)!;
              if (call.function?.name) existing.function.name = call.function.name;
              if (call.function?.arguments) {
                const argStr = typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments);
                const prev = typeof existing.function.arguments === "object" ? JSON.stringify(existing.function.arguments) : "";
                try { existing.function.arguments = JSON.parse(prev + argStr); } catch { /* partial JSON */ }
              }
            }
          }
        } catch { /* skip malformed lines */ }
      }
    }

    return { content, toolCalls: [...toolCallMap.values()] };
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(this.url("/api/tags"), { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return [];
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      return (data.models ?? []).map((m) => m.name);
    } catch {
      return [];
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(this.url("/api/tags"), { signal: AbortSignal.timeout(3_000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ── OpenAI-compatible ───────────────────────────────────────────────────────

class OpenAICompatibleProvider implements ChatProvider {
  readonly name = "openai";

  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  /** Convert our internal message format to OpenAI chat format. */
  private toOpenAIMessages(messages: ChatMessage[]): unknown[] {
    return messages.map((m) => {
      if (m.role === "tool") {
        return { role: "tool", content: m.content, tool_call_id: m.tool_call_id };
      }
      const out: any = { role: m.role, content: m.content };
      if (m.tool_calls?.length) {
        out.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id ?? `call_${Math.random().toString(36).slice(2)}`,
          type: "function",
          function: {
            name: tc.function.name,
            arguments: typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments),
          },
        }));
      }
      return out;
    });
  }

  async chat(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    const { temperature, signal, onDelta } = options;
    const body: any = {
      model,
      messages: this.toOpenAIMessages(messages),
      stream: true,
      temperature,
    };
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      }));
    }

    let res: Response;
    try {
      res = await fetch(this.url("/chat/completions"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenAI-compatible API failed (${res.status}): ${text.slice(0, 500)}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    const isStream = contentType.includes("text/event-stream") || contentType.includes("application/x-ndjson") || contentType.includes("application/json");

    // Non-streaming fallback
    if (!isStream || !res.body) {
      const data = await res.json() as any;
      const choice = data.choices?.[0];
      const msg = choice?.message ?? {};
      const content = typeof msg.content === "string" ? msg.content : "";
      if (content) onDelta?.(content);
      return { content, toolCalls: parseToolCalls(msg.tool_calls) };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let content = "";
    const toolCallMap = new Map<number, ParsedToolCall>();
    const toolArgBuffers = new Map<number, string>();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });

      // SSE format: lines starting with "data: "
      // NDJSON format: raw JSON lines
      const lines = chunk.includes("data: ")
        ? chunk.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6))
        : chunk.split("\n");

      for (const line of lines) {
        if (!line.trim() || line.trim() === "[DONE]") continue;
        try {
          const obj = JSON.parse(line) as any;
          const delta = obj.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) {
            content += delta.content;
            onDelta?.(delta.content);
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallMap.has(idx)) {
                toolCallMap.set(idx, { id: tc.id, function: { name: "", arguments: {} } });
                toolArgBuffers.set(idx, "");
              }
              const existing = toolCallMap.get(idx)!;
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.function.name += tc.function.name;
              if (tc.function?.arguments) {
                toolArgBuffers.set(idx, (toolArgBuffers.get(idx) ?? "") + tc.function.arguments);
              }
            }
          }
        } catch { /* skip malformed lines */ }
      }
    }

    // Finalize tool call arguments (they arrive as partial JSON strings)
    const toolCalls: ParsedToolCall[] = [...toolCallMap.values()].map((tc, i) => {
      const rawJson = toolArgBuffers.get(i);
      let args: Record<string, unknown> = {};
      if (rawJson) {
        try { args = JSON.parse(rawJson); } catch { /* partial */ }
      }
      return { id: tc.id, function: { name: tc.function.name, arguments: args } };
    });

    return { content, toolCalls };
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(this.url("/models"), {
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as any;
      // OpenAI format: { data: [{ id: "model-name" }] }
      return (data.data ?? []).map((m: any) => m.id).filter(Boolean);
    } catch {
      return [];
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(this.url("/models"), {
        headers: this.headers(),
        signal: AbortSignal.timeout(3_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
