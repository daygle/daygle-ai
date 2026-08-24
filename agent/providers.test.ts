/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { createProvider } from "./providers";

describe("Ollama provider tool calls", () => {
  test("reassembles streamed tool arguments", async () => {
    const originalFetch = globalThis.fetch;
    const chunks = [
      JSON.stringify({ message: { tool_calls: [{ index: 0, function: { name: "list_files", arguments: '{"path":"' } }] } }) + "\n",
      JSON.stringify({ message: { tool_calls: [{ index: 0, function: { arguments: "src" } }] } }) + "\n",
      JSON.stringify({ message: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] } }) + "\n",
    ].join("");
    globalThis.fetch = (async () =>
      new Response(chunks, { headers: { "content-type": "application/x-ndjson" } })) as unknown as typeof fetch;

    try {
      const provider = createProvider({ kind: "ollama", baseUrl: "http://127.0.0.1:11434" });
      const result = await provider.chat("test", [], [], { temperature: 0, numCtx: 4096 });
      expect(result.toolCalls).toEqual([
        { id: undefined, function: { name: "list_files", arguments: { path: "src" } } },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps parallel tool calls in one message separate", async () => {
    const originalFetch = globalThis.fetch;
    // Ollama emits several complete tool_calls in a single message with no
    // `index`; each must be preserved as its own call with its own arguments.
    const chunk = JSON.stringify({
      message: {
        tool_calls: [
          { function: { name: "read_file", arguments: { path: "a.ts" } } },
          { function: { name: "read_file", arguments: { path: "b.ts" } } },
        ],
      },
    }) + "\n";
    globalThis.fetch = (async () =>
      new Response(chunk, { headers: { "content-type": "application/x-ndjson" } })) as unknown as typeof fetch;

    try {
      const provider = createProvider({ kind: "ollama", baseUrl: "http://127.0.0.1:11434" });
      const result = await provider.chat("test", [], [], { temperature: 0, numCtx: 4096 });
      expect(result.toolCalls).toEqual([
        { id: undefined, function: { name: "read_file", arguments: { path: "a.ts" } } },
        { id: undefined, function: { name: "read_file", arguments: { path: "b.ts" } } },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("OpenAI-compatible provider responses", () => {
  test("parses a normal JSON response even when the gateway ignores stream=true", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        choices: [{
          message: {
            content: "Done.",
            tool_calls: [{ id: "call-1", function: { name: "list_files", arguments: '{"path":"src"}' } }],
          },
        }],
      }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    try {
      const provider = createProvider({ kind: "openai", baseUrl: "https://api.example.com/v1", apiKey: "test" });
      const result = await provider.chat("test", [], [], { temperature: 0, numCtx: 4096 });
      expect(result.content).toBe("Done.");
      expect(result.toolCalls).toEqual([
        { id: "call-1", function: { name: "list_files", arguments: { path: "src" } } },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
