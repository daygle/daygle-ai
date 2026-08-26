/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ModelPullEvent, ModelPullState } from "./agent";

// Mutable hooks the mocked ./agent delegates to, so each test can steer the
// server-side path without re-registering the module mock.
let startImpl: (name: string) => Promise<ModelPullState>;
let eventsImpl: (name: string, cb: (e: ModelPullEvent) => void) => () => void;
let listImpl: () => Promise<ModelPullState[]>;

mock.module("./agent", () => ({
  DEFAULT_AGENT_URL: "http://agent.test/api/agent",
  startModelPull: (_url: string, name: string) => startImpl(name),
  openModelPullEvents: (_url: string, name: string, cb: (e: ModelPullEvent) => void) =>
    eventsImpl(name, cb),
  listModelPulls: () => listImpl(),
  cancelModelPull: async () => {},
}));

const actualOllama = await import("./ollama");
let pullModelImpl: typeof actualOllama.pullModel;
mock.module("./ollama", () => ({
  ...actualOllama,
  pullModel: (b: string, n: string, p: (progress: unknown) => void) => pullModelImpl(b, n, p as never),
}));

const { startPull, reattachServerPull, getPullState } = await import("./pullManager");

// Defaults: agent unreachable, so tests opt into the server-side path explicitly.
function resetHooks() {
  startImpl = async () => {
    throw new Error("agent down");
  };
  eventsImpl = () => () => {};
  listImpl = async () => [];
  pullModelImpl = async () => {};
}

afterEach(() => {
  resetHooks();
});
resetHooks();

describe("startPull server-side", () => {
  it("reattaches to a pull already running on the agent", async () => {
    listImpl = async () => [{ name: "qwen3:latest", status: "running", progress: { status: "downloading", percent: 42 } }];
    let done: ((e: ModelPullEvent) => void) | undefined;
    eventsImpl = (_name, cb) => {
      done = cb;
      return () => {};
    };
    let completed = 0;
    await reattachServerPull("http://agent.test/api/agent", () => {
      completed++;
    });
    expect(getPullState().name).toBe("qwen3:latest");
    expect(getPullState().serverSide).toBe(true);
    expect(getPullState().progress?.percent).toBe(42);
    // Finish the download from the agent side.
    done?.({ type: "done" });
    await Promise.resolve();
    expect(completed).toBe(1);
    expect(getPullState().progress?.status).toBe("done");
  });

  it("runs the download on the agent and completes over SSE", async () => {
    startImpl = async () => ({ name: "llama3.2", status: "running", progress: null });
    eventsImpl = (_name, cb) => {
      cb({ type: "progress", progress: { status: "downloading", percent: 50 } });
      cb({ type: "done" });
      return () => {};
    };
    let completed = 0;
    await startPull("http://x/api/ollama", "llama3.2", () => {
      completed++;
    });
    expect(getPullState().serverSide).toBe(true);
    expect(completed).toBe(1);
    expect(getPullState().error).toBeNull();
    expect(getPullState().progress?.status).toBe("done");
  });

  it("surfaces a server-side pull error", async () => {
    startImpl = async () => ({ name: "bad", status: "running", progress: null });
    eventsImpl = (_name, cb) => {
      cb({ type: "error", message: "pull model manifest: file does not exist" });
      return () => {};
    };
    await startPull("http://x/api/ollama", "bad", () => {});
    expect(getPullState().error).toContain("file does not exist");
    expect(getPullState().pulling).toBe(false);
  });
});

describe("startPull browser fallback", () => {
  it("reconnects and resumes after an interrupted stream, then completes", async () => {
    let calls = 0;
    pullModelImpl = async (_baseUrl, _name, onProgress) => {
      calls++;
      onProgress({ status: "downloading", percent: calls * 10 });
      if (calls < 3) throw new actualOllama.OllamaConnectionInterrupted();
    };
    let completed = 0;
    await startPull("http://x/api/ollama", "llama3.2", () => {
      completed++;
    });
    expect(calls).toBe(3);
    expect(completed).toBe(1);
    expect(getPullState().error).toBeNull();
    expect(getPullState().progress?.status).toBe("done");
  }, 20_000);

  it("does not retry a genuine Ollama error (e.g. unknown model)", async () => {
    let calls = 0;
    pullModelImpl = async () => {
      calls++;
      throw new actualOllama.OllamaError("pull model manifest: file does not exist");
    };
    await startPull("http://x/api/ollama", "nope:404", () => {});
    expect(calls).toBe(1);
    expect(getPullState().error).toContain("file does not exist");
  });
});
