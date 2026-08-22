import fs from "node:fs";
import path from "node:path";
import type { AgentEvent } from "./agent";

export type RunStatus = "running" | "done" | "error" | "cancelled";

export interface StoredJob {
  id: string;
  repoUrl: string;
  task: string;
  model: string;
  baseBranch: string;
  ollamaUrl: string;
  status: RunStatus;
  events: AgentEvent[];
  approved: string[];
  denied: string[];
  prUrl?: string;
  summary?: string;
  createdAt: number;
  finishedAt?: number;
  /** Retained isolated checkpoint metadata for recovery after restart. */
  checkpointId?: string;
}

export class HistoryStore {
  constructor(private readonly dir: string) {}

  save(job: StoredJob): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, `${job.id}.json`), JSON.stringify(job), "utf8");
    } catch {
      // history is best-effort; never break a run because of a write failure
    }
  }

  load(id: string): StoredJob | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), "utf8")) as StoredJob;
    } catch {
      return null;
    }
  }

  loadAll(): StoredJob[] {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((file) => file.endsWith(".json"));
    } catch {
      return [];
    }
    const jobs: StoredJob[] = [];
    for (const file of files) {
      try {
        jobs.push(JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8")) as StoredJob);
      } catch {
        // skip unreadable files
      }
    }
    return jobs;
  }
}
