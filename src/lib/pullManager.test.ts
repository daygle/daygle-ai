/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";

// Replace only pullModel; keep the real error classes and helpers the manager
// imports from the same module.
const actualOllama = await import("./ollama");

function installPullModel(impl: typeof actualOllama.pullModel) {
  mock.module("./ollama", () => ({ ...actualOllama, pullModel: impl }));
}

afterEach(() => {
  mock.restore();
});

describe("startPull resume", () => {
  it("reconnects and resumes after an interrupted stream, then completes", async () => {
    let calls = 0;
    installPullModel(async (_baseUrl, _name, onProgress) => {
      calls++;
      onProgress({ status: "downloading", percent: calls * 10 });
      if (calls < 3) throw new actualOllama.OllamaConnectionInterrupted();
      // Third attempt succeeds.
    });

    const { startPull, getPullState } = await import("./pullManager");
    let completed = 0;
    await startPull("http://x/api/ollama", "llama3.2", () => {
      completed++;
    });

    expect(calls).toBe(3); // two interruptions, then success
    expect(completed).toBe(1); // onComplete ran exactly once
    expect(getPullState().error).toBeNull();
    expect(getPullState().progress?.status).toBe("done");
  }, 20_000);

  it("does not retry a genuine Ollama error (e.g. unknown model)", async () => {
    let calls = 0;
    installPullModel(async () => {
      calls++;
      throw new actualOllama.OllamaError("pull model manifest: file does not exist");
    });

    const { startPull, getPullState } = await import("./pullManager");
    let completed = 0;
    await startPull("http://x/api/ollama", "nope:404", () => {
      completed++;
    });

    expect(calls).toBe(1); // failed immediately, no resume attempts
    expect(completed).toBe(0);
    expect(getPullState().error).toContain("file does not exist");
  });
});
