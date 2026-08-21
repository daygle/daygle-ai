/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { getAllowedUiOrigins, isAllowedUiOrigin, isLoopbackUrl, LOOPBACK_HOST } from "./security";

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
    expect(isLoopbackUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isLoopbackUrl("http://localhost:11434")).toBe(true);
    expect(isLoopbackUrl("https://127.0.0.1:11434")).toBe(false);
    expect(isLoopbackUrl("http://192.168.1.20:11434")).toBe(false);
    expect(isLoopbackUrl("http://127.0.0.1:11434@evil.example")).toBe(false);
  });

  test("supports explicit comma-separated origins", () => {
    const allowed = getAllowedUiOrigins("https://ui.example, http://127.0.0.1:5173");
    expect(isAllowedUiOrigin("https://ui.example", allowed)).toBe(true);
    expect(isAllowedUiOrigin("http://localhost:5173", allowed)).toBe(false);
  });
});
