import fs from "node:fs";
import path from "node:path";
import type { ChatMessage, GenOptions } from "./chat";

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
  providerConfig?: { kind: "ollama" | "openai"; baseUrl: string; apiKey?: string };
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
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, `${chat.id}.json`), JSON.stringify(chat), { encoding: "utf8", mode: 0o600 });
    } catch {
      // history is best-effort; never break a chat because of a write failure
    }
  }

  load(id: string): StoredChat | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), "utf8")) as StoredChat;
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
      fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
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
  ollamaUrl: string,
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

    const response = await fetch(`${ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        options: { temperature: 0.3, num_predict: 20 },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      const data: any = await response.json();
      const raw = data.message?.content?.trim();
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
    }
  } catch (err) {
    console.error("generateTitle failed:", err);
  }

  return deriveTitle(messages);
}
