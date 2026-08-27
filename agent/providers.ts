/**
 * Provider abstraction for chat completions.
 *
 * Normalises the differences between Ollama's `/api/chat` and the
 * OpenAI-compatible `/v1/chat/completions` endpoint used by providers
 * like Hugging Face Inference, Together AI, Groq, DeepSeek, etc.
 */

import type { ToolDefinition } from "./tools";
import { isAllowedOllamaUrl, isSafeExternalUrl } from "./security";

// ── Shared types ────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Base64 image payloads supported by vision-capable Ollama models. */
  images?: string[];
  imageMimeTypes?: string[];
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

  /** Base URL of the provider endpoint, when one exists (mock providers may omit it; real providers expose it so tooling can reuse it, e.g. Ollama embeddings). */
  readonly baseUrl?: string;

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
  /** Base URL - for Ollama e.g. http://localhost:11434, for OpenAI-compatible e.g. https://api.together.xyz/v1 */
  baseUrl: string;
  /** API key (required for cloud providers, ignored for Ollama). */
  apiKey?: string;
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createProvider(config: ProviderConfig): ChatProvider {
  switch (config.kind) {
    case "ollama":
      if (!isAllowedOllamaUrl(config.baseUrl)) throw new Error("Ollama baseUrl must be a local address, or enable DAYGLE_ALLOW_REMOTE_OLLAMA=1 for a private LAN address.");
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

  constructor(public readonly baseUrl: string) {}

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
    const res = await fetch(this.url("/api/chat"), {
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
    const toolArgBuffers = new Map<number, string>();
    // NDJSON lines can span network chunks; buffer the remainder so a JSON
    // object split across reads isn't silently dropped.
    let buffer = "";

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) return;
      const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
      if (!payload || payload === "[DONE]") return;
      try {
        const obj = JSON.parse(payload) as { message?: { content?: string; tool_calls?: unknown[] }; done?: boolean };
        if (obj.message?.content) {
          content += obj.message.content;
          onDelta?.(obj.message.content);
        }
        if (obj.message?.tool_calls) {
          obj.message.tool_calls.forEach((raw, position) => {
            const call = raw as any;
            // Ollama sends each message's tool_calls complete and without an
            // `index`, so several parallel calls in one message would otherwise
            // all collapse onto key 0 - dropping every call but the first and
            // concatenating their arguments into invalid JSON. Fall back to the
            // array position (matching the direct-Ollama path in chat.ts) so
            // distinct calls stay separate.
            const idx = typeof call.index === "number" ? call.index : position;
            if (!toolCallMap.has(idx)) {
              toolCallMap.set(idx, { id: call.id, function: { name: call.function?.name ?? "", arguments: {} } });
              toolArgBuffers.set(idx, "");
            }
            const existing = toolCallMap.get(idx)!;
            if (call.id) existing.id = call.id;
            if (call.function?.name) existing.function.name = call.function.name;
            if (call.function?.arguments) {
              const argStr = typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments);
              toolArgBuffers.set(idx, (toolArgBuffers.get(idx) ?? "") + argStr);
            }
          });
        }
      } catch { /* skip malformed lines */ }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer);

    const toolCalls: ParsedToolCall[] = [...toolCallMap.entries()].map(([idx, call]) => {
      const rawArgs = toolArgBuffers.get(idx) ?? "";
      let args: Record<string, unknown> = {};
      if (rawArgs) {
        try { args = JSON.parse(rawArgs); } catch { /* malformed or incomplete arguments */ }
      }
      return { id: call.id, function: { name: call.function.name, arguments: args } };
    });
    return { content, toolCalls };
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
    public readonly baseUrl: string,
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
    const pendingToolIds: string[] = [];
    return messages.map((m, messageIndex) => {
      if (m.role === "tool") {
        return {
          role: "tool",
          content: m.content,
          tool_call_id: m.tool_call_id ?? pendingToolIds.shift() ?? `call_legacy_${messageIndex}`,
        };
      }
      const out: any = { role: m.role, content: m.content };
      if (m.tool_calls?.length) {
        out.tool_calls = m.tool_calls.map((tc, callIndex) => {
          const id = tc.id ?? `call_${messageIndex}_${callIndex}`;
          pendingToolIds.push(id);
          return {
            id,
            type: "function",
            function: {
              name: tc.function.name,
              arguments: typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments),
            },
          };
        });
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

    const res = await fetch(this.url("/chat/completions"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenAI-compatible API failed (${res.status}): ${text.slice(0, 500)}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    const isStream = contentType.includes("text/event-stream") || contentType.includes("application/x-ndjson");

    // Non-streaming JSON responses are common even when the request included
    // stream:true (some OpenAI-compatible gateways ignore that flag).
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
    // SSE/NDJSON lines can span network chunks; buffer the remainder so an
    // event split across reads isn't dropped mid-stream.
    let buffer = "";

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "[DONE]") return;
      // SSE comments (": keep-alive") carry no payload.
      if (trimmed.startsWith(":")) return;
      // SSE framing: "data: {...}" - some compatible providers omit the space
      // after the colon. Otherwise treat the line as a raw NDJSON object.
      // Deciding per line avoids misdetecting NDJSON payloads that merely
      // contain "data: " inside their text content.
      const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
      if (!payload) return;
      try {
        const obj = JSON.parse(payload) as any;
        // Some OpenAI-compatible providers surface errors mid-stream while
        // still sending HTTP 200; without this check they end as a silent
        // empty response.
        if (obj.error) {
          const message = typeof obj.error === "string" ? obj.error : obj.error.message ?? JSON.stringify(obj.error);
          throw new Error(`OpenAI-compatible API stream error: ${message}`);
        }
        const delta = obj.choices?.[0]?.delta;
        if (!delta) return;
        if (typeof delta.content === "string" && delta.content) {
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
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("OpenAI-compatible API stream error:")) throw err;
        /* skip malformed lines */
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last (possibly incomplete) line buffered. When the provider
      // uses SSE framing we can't know if it's complete, so hold it back; a
      // trailing flush below handles providers that end without a newline.
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer);

    // Finalize tool call arguments (they arrive as partial JSON strings).
    // Look up each argument buffer by its own tool-call index - array position
    // would desync when a provider skips index 0 (e.g. parallel tool calls).
    const toolCalls: ParsedToolCall[] = [...toolCallMap.entries()].map(([idx, tc]) => {
      const rawJson = toolArgBuffers.get(idx);
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
