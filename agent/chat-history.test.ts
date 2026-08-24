/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatHistoryStore, generateTitle, type StoredChat } from "./chat-history";
import type { ChatProvider } from "./providers";

function titleProvider(): ChatProvider {
  return {
    name: "test-provider",
    async chat() {
      return { content: "Title: Configure cloud models", toolCalls: [] };
    },
    async listModels() {
      return [];
    },
    async healthCheck() {
      return true;
    },
  };
}

describe("chat history", () => {
  test("generates titles through the selected provider", async () => {
    const title = await generateTitle(
      [{ role: "user", content: "Use my cloud model" }],
      titleProvider(),
      "cloud-model",
    );
    expect(title).toBe("Configure cloud models");
  });

  test("does not retain provider credentials in persisted chats", () => {
    const dir = mkdtempSync(join(tmpdir(), "daygle-chat-history-"));
    const store = new ChatHistoryStore(dir);
    const chat: StoredChat = {
      id: "safe-session",
      repoUrl: "",
      model: "test",
      ollamaUrl: "http://127.0.0.1:11434",
      title: "Test",
      messages: [],
      createdAt: Date.now(),
      lastActivity: Date.now(),
      providerConfig: { kind: "openai", baseUrl: "https://api.example.com/v1" },
    };

    store.save(chat);
    const file = join(dir, "safe-session.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("providerConfig.apiKey");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("rejects path-like chat ids", () => {
    const store = new ChatHistoryStore(mkdtempSync(join(tmpdir(), "daygle-chat-history-")));
    expect(store.load("../outside")).toBeNull();
    expect(() => store.delete("../outside")).not.toThrow();
  });

  test("migrates legacy records without returning their API key", () => {
    const dir = mkdtempSync(join(tmpdir(), "daygle-chat-history-"));
    writeFileSync(join(dir, "legacy.json"), JSON.stringify({
      id: "legacy",
      repoUrl: "",
      model: "test",
      ollamaUrl: "http://127.0.0.1:11434",
      title: "Legacy",
      messages: [],
      createdAt: 0,
      lastActivity: 0,
      providerConfig: { kind: "openai", baseUrl: "https://api.example.com/v1", apiKey: "secret" },
    }));

    const loaded = new ChatHistoryStore(dir).load("legacy");
    expect(loaded?.providerConfig).toEqual({ kind: "openai", baseUrl: "https://api.example.com/v1" });
    expect(loaded?.providerConfig).not.toHaveProperty("apiKey");
  });
});
