/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { classifyCommand, isReviewSafeCommand } from "./tools";

describe("classifyCommand", () => {
  test("auto-allows read-only inspection commands", () => {
    expect(classifyCommand("")).toBe("allow");
    expect(classifyCommand("ls")).toBe("allow");
    expect(classifyCommand("cat README.md")).toBe("allow");
    expect(classifyCommand("git status")).toBe("allow");
    expect(classifyCommand("git diff")).toBe("allow");
  });

  test("requires approval for anything that mutates or runs code", () => {
    expect(classifyCommand("npm test")).toBe("approve");
    expect(classifyCommand("bun run build")).toBe("approve");
    expect(classifyCommand("cd web && vite")).toBe("approve");
    expect(classifyCommand("npm test | grep foo")).toBe("approve");
  });

  test("hard-blocks destructive, privileged, networked, and secret-accessing commands", () => {
    expect(classifyCommand("rm -rf /")).toBe("block");
    expect(classifyCommand("sudo apt-get install x")).toBe("block");
    expect(classifyCommand("cat .env")).toBe("block");
    expect(classifyCommand("git push")).toBe("block");
    expect(classifyCommand("git remote add origin https://x")).toBe("block");
    expect(classifyCommand("curl http://example.com")).toBe("block");
    expect(classifyCommand("env")).toBe("block");
  });
});

describe("isReviewSafeCommand", () => {
  test("accepts chains of verification runners", () => {
    expect(isReviewSafeCommand("npm test")).toBe(true);
    expect(isReviewSafeCommand("npm run build && bun test")).toBe(true);
    expect(isReviewSafeCommand("cd src && npm test")).toBe(true);
  });

  test("accepts read-only inspection commands", () => {
    expect(isReviewSafeCommand("cat package.json")).toBe(true);
    expect(isReviewSafeCommand("git status")).toBe(true);
  });

  test("rejects shell plumbing and anything outside the allowlist", () => {
    expect(isReviewSafeCommand("npm test | grep foo")).toBe(false);
    expect(isReviewSafeCommand("rm -rf node_modules")).toBe(false);
    expect(isReviewSafeCommand("npm run deploy")).toBe(true); // npm is allowlisted; policy still applies
  });
});
