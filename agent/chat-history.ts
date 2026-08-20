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
      fs.writeFileSync(path.join(this.dir, `${chat.id}.json`), JSON.stringify(chat), "utf8");
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
