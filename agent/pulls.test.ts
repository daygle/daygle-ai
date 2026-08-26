/// <reference types="bun" />
import { afterEach, describe, expect, test } from "bun:test";
import {
  _resetPullsForTest,
  getPull,
  listPulls,
  startPull,
  subscribePull,
  type PullEvent,
} from "./pulls";

const enc = new TextEncoder();
const line = (obj: unknown) => enc.encode(JSON.stringify(obj) + "\n");

const OLLAMA = "http://127.0.0.1:11434";
const realFetch = globalThis.fetch;

// Script the mocked Ollama /api/pull response per request attempt. Building the
// Response from a stream we control lets us surface a real mid-stream reader
// error (a dropped connection), which a live HTTP hop would deliver as EOF.
let attempts = 0;
let script: (attempt: number, controller: ReadableStreamDefaultController) => void | Promise<void>;

function installFetch() {
  attempts = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/pull")) {
      attempts++;
      const thisAttempt = attempts;
      const stream = new ReadableStream({
        start(controller) {
          return script(thisAttempt, controller);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      });
    }
    return new Response("nf", { status: 404 });
  }) as typeof fetch;
}

/** Resolve once the pull reaches a terminal state, collecting all events. */
function waitForTerminal(name: string): Promise<PullEvent[]> {
  return new Promise((resolve) => {
    const events: PullEvent[] = [];
    subscribePull(name, (event) => {
      events.push(event);
      if (event.type === "done" || event.type === "error") resolve(events);
    });
  });
}

afterEach(() => {
  _resetPullsForTest();
  globalThis.fetch = realFetch;
});

describe("server-side pulls", () => {
  test("resumes after a dropped stream and completes", async () => {
    installFetch();
    script = async (attempt, controller) => {
      controller.enqueue(line({ status: "downloading", digest: "d", completed: 1, total: 3 }));
      if (attempt === 1) {
        await Bun.sleep(30); // let the reader consume the first chunk...
        controller.error(new TypeError("network error")); // ...then drop mid-stream
        return;
      }
      controller.enqueue(line({ status: "downloading", digest: "d", completed: 3, total: 3 }));
      controller.enqueue(line({ status: "success" }));
      controller.close();
    };
    startPull(OLLAMA, "llama3.2");
    const events = await waitForTerminal("llama3.2");
    expect(events.at(-1)?.type).toBe("done");
    expect(attempts).toBe(2); // one drop, then a resumed pull
    expect(getPull("llama3.2")?.status).toBe("done");
  }, 20_000);

  test("continues to completion even with no listener attached mid-download", async () => {
    installFetch();
    script = async (_attempt, controller) => {
      controller.enqueue(line({ status: "downloading", digest: "d", completed: 1, total: 2 }));
      await Bun.sleep(150);
      controller.enqueue(line({ status: "downloading", digest: "d", completed: 2, total: 2 }));
      controller.enqueue(line({ status: "success" }));
      controller.close();
    };
    startPull(OLLAMA, "gemma3:4b");
    // Do not subscribe until the download is well underway - it must still finish.
    await Bun.sleep(80);
    const events = await waitForTerminal("gemma3:4b");
    expect(events.at(-1)?.type).toBe("done");
    expect(getPull("gemma3:4b")?.status).toBe("done");
  }, 20_000);

  test("reports a genuine Ollama error without retrying", async () => {
    installFetch();
    script = (_attempt, controller) => {
      controller.enqueue(line({ error: "pull model manifest: file does not exist" }));
      controller.close();
    };
    startPull(OLLAMA, "nope:404");
    const events = await waitForTerminal("nope:404");
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect(last && "message" in last ? last.message : "").toContain("file does not exist");
    expect(attempts).toBe(1); // no resume for a real error
  }, 20_000);

  test("startPull is idempotent for a running model and listPulls reflects state", async () => {
    installFetch();
    script = async (_attempt, controller) => {
      controller.enqueue(line({ status: "downloading", digest: "d", completed: 1, total: 2 }));
      await Bun.sleep(120);
      controller.enqueue(line({ status: "success" }));
      controller.close();
    };
    startPull(OLLAMA, "mistral");
    startPull(OLLAMA, "mistral"); // should attach, not start a second download
    expect(listPulls().filter((p) => p.name === "mistral")).toHaveLength(1);
    await waitForTerminal("mistral");
    expect(attempts).toBe(1);
  }, 20_000);
});
