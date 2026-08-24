/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamChat, type ChatSession } from "./chat";
import type { ChatProvider } from "./providers";

function repeatedListFilesProvider(): ChatProvider {
  return {
    name: "test",
    async chat(_model, _messages, _tools, _options) {
      return {
        content: "Let me inspect the project structure.",
        toolCalls: [{ id: "list-files", function: { name: "list_files", arguments: {} } }],
      };
    },
    async listModels() {
      return ["test"];
    },
    async healthCheck() {
      return true;
    },
  };
}

/**
 * Emits a text-form tool call whose JSON arguments contain a backslash-escaped
 * quote adjacent to the closing braces on the first turn, then finishes. Models
 * that don't use the structured tool_calls channel are parsed via
 * parseTextToolCalls, whose balanced-JSON scanner must honor `\"` as an escaped
 * quote or it terminates the string early and drops the whole call.
 */
function escapedQuoteToolCallProvider(): ChatProvider {
  let turn = 0;
  return {
    name: "test",
    async chat(_model, _messages, _tools, _options) {
      turn += 1;
      if (turn === 1) {
        return {
          content:
            'Writing the file: {"name": "write_file", "arguments": {"path": "note.txt", "content": "he said \\""}}',
          toolCalls: [],
        };
      }
      return { content: "Done.", toolCalls: [] };
    },
    async listModels() {
      return ["test"];
    },
    async healthCheck() {
      return true;
    },
  };
}

describe("streamChat loop protection", () => {
  test("reassembles direct Ollama tool arguments before execution", async () => {
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = (async () => {
      requestCount += 1;
      const response = requestCount === 1
        ? [
            JSON.stringify({ message: { tool_calls: [{ index: 0, function: { name: "list_files", arguments: '{"path":"' } }] } }) + "\n",
            JSON.stringify({ message: { tool_calls: [{ index: 0, function: { arguments: "src" } }] } }) + "\n",
            JSON.stringify({ message: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] } }) + "\n",
          ].join("")
        : JSON.stringify({ message: { content: "Finished." } });
      return new Response(response, { headers: { "content-type": "application/x-ndjson" } });
    }) as unknown as typeof fetch;

    try {
      const root = mkdtempSync(join(tmpdir(), "daygle-chat-ollama-"));
      writeFileSync(join(root, "src.txt"), "test\n");
      const session: ChatSession = {
        id: "direct-ollama-session",
        repoUrl: "https://github.com/example/repo",
        root,
        model: "test",
        ollamaUrl: "http://127.0.0.1:11434",
        messages: [],
        createdAt: Date.now(),
        lastActivity: Date.now(),
      };

      const events = [];
      for await (const event of streamChat(session, "Inspect src.")) events.push(event);
      const toolStart = events.find((event) => event.type === "tool_start");
      expect(toolStart).toMatchObject({ name: "list_files", args: { path: "src" } });
      expect(events.at(-1)).toEqual({ type: "model_done", content: "Finished." });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("stops after repeated identical tool calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "daygle-chat-loop-"));
    writeFileSync(join(root, "README.md"), "test\n");
    const session: ChatSession = {
      id: "test-session",
      repoUrl: "https://github.com/example/repo",
      root,
      model: "test",
      ollamaUrl: "http://127.0.0.1:11434",
      messages: [],
      createdAt: Date.now(),
      lastActivity: Date.now(),
      provider: repeatedListFilesProvider(),
    };

    const events = [];
    for await (const event of streamChat(session, "Please inspect the repository.")) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === "tool_start")).toHaveLength(2);
    expect(events.at(-1)).toEqual({
      type: "error",
      message: "The model repeated list_files with the same arguments 3 times. Stopping to prevent a tool loop.",
    });
  });

  test("parses a text tool call whose JSON ends with an escaped quote", async () => {
    const root = mkdtempSync(join(tmpdir(), "daygle-chat-escape-"));
    const session: ChatSession = {
      id: "escape-session",
      repoUrl: "https://github.com/example/repo",
      root,
      model: "test",
      ollamaUrl: "http://127.0.0.1:11434",
      messages: [],
      createdAt: Date.now(),
      lastActivity: Date.now(),
      provider: escapedQuoteToolCallProvider(),
    };

    const events = [];
    for await (const event of streamChat(session, "Create note.txt.")) events.push(event);

    const toolStart = events.find((event) => event.type === "tool_start");
    expect(toolStart).toMatchObject({ name: "write_file", args: { path: "note.txt", content: 'he said "' } });
    expect(readFileSync(join(root, "note.txt"), "utf8")).toBe('he said "');
  });
});
