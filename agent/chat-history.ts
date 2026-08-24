import fs from "node:fs";
import path from "node:path";
import type { ChatMessage, GenOptions } from "./chat";
import type { ChatProvider } from "./providers";

export type StoredProviderConfig = { kind: "ollama" | "openai"; baseUrl: string };

export interface StoredChat {
  id: string;
  repoUrl: string;
  model: string;
  ollamaUrl: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  lastActivity: number;
  options?: GenOptions;
  /** Provider routing is retained, but credentials are intentionally not persisted. */
  providerConfig?: StoredProviderConfig;
}

const CHAT_ID_PATTERN = /^[a-z0-9-]+$/i;

function chatFile(dir: string, id: string): string {
  if (!CHAT_ID_PATTERN.test(id)) throw new Error("Invalid chat id.");
  return path.join(dir, `${id}.json`);
}

export interface ChatSummary {
  id: string;
  repoUrl: string;
  model: string;
  title: string;
  messageCount: number;
  createdAt: number;
  lastActivity: number;
}

/** Persists chat transcripts to disk so conversations survive restarts. */
export class ChatHistoryStore {
  constructor(private readonly dir: string) {}

  save(chat: StoredChat): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.dir, 0o700);
      const file = chatFile(this.dir, chat.id);
      fs.writeFileSync(file, JSON.stringify(chat), { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(file, 0o600);
    } catch {
      // history is best-effort; never break a chat because of a write failure
    }
  }

  load(id: string): StoredChat | null {
    try {
      const chat = JSON.parse(fs.readFileSync(chatFile(this.dir, id), "utf8")) as StoredChat & {
        providerConfig?: { kind?: string; baseUrl?: unknown; apiKey?: unknown };
      };
      // Migrate older records without ever returning their persisted API key.
      if (chat.providerConfig) {
        chat.providerConfig = {
          kind: chat.providerConfig.kind === "openai" ? "openai" : "ollama",
          baseUrl: typeof chat.providerConfig.baseUrl === "string" ? chat.providerConfig.baseUrl : "",
        };
      }
      return chat;
    } catch {
      return null;
    }
  }

  /** Conversation summaries, newest activity first. */
  list(): ChatSummary[] {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((file) => file.endsWith(".json"));
    } catch {
      return [];
    }
    const chats: ChatSummary[] = [];
    for (const file of files) {
      try {
        const chat = JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8")) as StoredChat;
        chats.push({
          id: chat.id,
          repoUrl: chat.repoUrl,
          model: chat.model,
          title: chat.title,
          messageCount: chat.messages.filter((m) => m.role === "user" || m.role === "assistant").length,
          createdAt: chat.createdAt,
          lastActivity: chat.lastActivity,
        });
      } catch {
        // skip unreadable files
      }
    }
    return chats.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  delete(id: string): void {
    try {
      fs.rmSync(chatFile(this.dir, id), { force: true });
    } catch {
      // best effort
    }
  }
}

/** Derives a short title from the first user message of a conversation. */
export function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const text = firstUser?.content.trim().replace(/\s+/g, " ") ?? "";
  if (!text) return "New chat";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/**
 * Generates a short, descriptive title using the AI model.
 * Falls back to deriveTitle() if the model is unavailable or the request fails.
 */
export async function generateTitle(
  messages: ChatMessage[],
  provider: ChatProvider,
  model: string,
): Promise<string> {
  if (messages.length === 0) return "New chat";

  try {
    const conversation = messages
      .slice(0, 5) // Use first 5 messages for context
      .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : '[image]'}`)
      .join("\n");

    const prompt = `Generate a very short title (max 8 words) for this conversation. Only output the title, nothing else. Be specific and descriptive.

${conversation}`;

    const response = await provider.chat(
      model,
      [{ role: "user", content: prompt }],
      [],
      { temperature: 0.3, numCtx: 4096, signal: AbortSignal.timeout(10_000) },
    );
    const raw = response.content.trim();
    if (raw) {
      // Strip common prefixes / suffixes models emit even when told not to
      const cleaned = raw
        .replace(/^\s*(?:title|label|heading)[:\s-]+/i, "")
        .replace(/[""「」'']/g, "")
        .replace(/^\n+|\n+$/g, "")
        .replace(/\n.*/s, "") // take only the first line
        .trim();
      if (cleaned.length >= 3 && cleaned.length < 80) {
        return cleaned;
      }
      // Even if validation fails, return the cleaned title rather than
      // falling back to the raw user-message dump.
      if (cleaned.length > 0) return cleaned;
    }
  } catch (err) {
    console.error("generateTitle failed:", err);
  }

  return deriveTitle(messages);
}
