/// <reference types="bun" />
import { afterEach, describe, expect, it } from "bun:test";
import {
  isAllowedOllamaUrl,
  isProxyOllamaUrl,
  ollamaProxyUrl,
  toBrowserOllamaUrl,
} from "./utils";

// The browser-facing helpers depend on `window.location.origin`. Node/bun test
// has no DOM, so stub a window for the cases that need one.
function withWindow(origin: string, fn: () => void) {
  (globalThis as unknown as { window?: unknown }).window = {
    location: { origin },
  };
  try {
    fn();
  } finally {
    delete (globalThis as unknown as { window?: unknown }).window;
  }
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("isAllowedOllamaUrl", () => {
  it("accepts direct loopback URLs", () => {
    expect(isAllowedOllamaUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isAllowedOllamaUrl("http://localhost:11434")).toBe(true);
  });

  it("rejects non-loopback hosts and non-http schemes", () => {
    expect(isAllowedOllamaUrl("http://192.168.1.5:11434")).toBe(false);
    expect(isAllowedOllamaUrl("https://127.0.0.1:11434")).toBe(false);
    expect(isAllowedOllamaUrl("http://user:pass@127.0.0.1:11434")).toBe(false);
  });

  it("accepts the same-origin proxy path", () => {
    withWindow("http://192.168.1.5:5173", () => {
      expect(isAllowedOllamaUrl("http://192.168.1.5:5173/api/ollama")).toBe(true);
      expect(isProxyOllamaUrl("http://192.168.1.5:5173/api/ollama")).toBe(true);
    });
  });
});

describe("toBrowserOllamaUrl", () => {
  it("migrates a direct loopback URL to the same-origin proxy", () => {
    withWindow("http://192.168.1.5:5173", () => {
      expect(toBrowserOllamaUrl("http://127.0.0.1:11434")).toBe(
        "http://192.168.1.5:5173/api/ollama",
      );
      expect(toBrowserOllamaUrl("http://localhost:11434")).toBe(
        "http://192.168.1.5:5173/api/ollama",
      );
    });
  });

  it("leaves an already-proxied URL unchanged", () => {
    withWindow("http://localhost:5173", () => {
      const proxy = ollamaProxyUrl();
      expect(proxy).toBe("http://localhost:5173/api/ollama");
      expect(toBrowserOllamaUrl(proxy)).toBe(proxy);
    });
  });

  it("returns the input unchanged when there is no window (SSR/tests)", () => {
    expect(toBrowserOllamaUrl("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
  });
});
