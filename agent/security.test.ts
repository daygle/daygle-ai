/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { getAllowedUiOrigins, isAllowedUiOrigin, isLocalOllamaUrl, isAllowedOllamaUrl, isSafeExternalUrl, LOOPBACK_HOST } from "./security";

describe("agent security defaults", () => {
  test("uses IPv4 loopback", () => {
    expect(LOOPBACK_HOST).toBe("127.0.0.1");
  });

  test("allows only the local UI origins by default", () => {
    const allowed = getAllowedUiOrigins();
    expect(isAllowedUiOrigin("http://127.0.0.1:5173", allowed)).toBe(true);
    expect(isAllowedUiOrigin("http://localhost:5173", allowed)).toBe(true);
    expect(isAllowedUiOrigin("http://192.168.1.20:5173", allowed)).toBe(false);
    expect(isAllowedUiOrigin("https://evil.example", allowed)).toBe(false);
  });

  test("accepts only HTTP loopback Ollama URLs", () => {
    expect(isLocalOllamaUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isLocalOllamaUrl("http://localhost:11434")).toBe(true);
    expect(isLocalOllamaUrl("https://127.0.0.1:11434")).toBe(false);
    expect(isLocalOllamaUrl("http://192.168.1.20:11434")).toBe(false);
    expect(isLocalOllamaUrl("http://127.0.0.1:11434@evil.example")).toBe(false);
  });

  test("allows private LAN Ollama only when explicitly enabled", () => {
    const previous = process.env.DAYGLE_ALLOW_REMOTE_OLLAMA;
    delete process.env.DAYGLE_ALLOW_REMOTE_OLLAMA;
    expect(isAllowedOllamaUrl("http://192.168.1.20:11434")).toBe(false);
    process.env.DAYGLE_ALLOW_REMOTE_OLLAMA = "1";
    expect(isAllowedOllamaUrl("http://192.168.1.20:11434")).toBe(true);
    expect(isAllowedOllamaUrl("http://8.8.8.8:11434")).toBe(false);
    if (previous === undefined) delete process.env.DAYGLE_ALLOW_REMOTE_OLLAMA;
    else process.env.DAYGLE_ALLOW_REMOTE_OLLAMA = previous;
  });

  test("accepts public DNS names without treating them as IPv4", () => {
    // Cloud provider hosts commonly contain dots but are not IPv4 literals.
    expect(isSafeExternalUrl("https://api.example.com/v1")).toBe(true);
    expect(isSafeExternalUrl("https://192.168.1.20/v1")).toBe(false);
  });

  test("supports explicit comma-separated origins", () => {
    const allowed = getAllowedUiOrigins("https://ui.example, http://127.0.0.1:5173");
    expect(isAllowedUiOrigin("https://ui.example", allowed)).toBe(true);
    expect(isAllowedUiOrigin("http://localhost:5173", allowed)).toBe(false);
  });
});
