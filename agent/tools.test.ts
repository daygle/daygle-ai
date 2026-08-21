/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCommand, isReviewSafeCommand, runTool } from "./tools";

describe("space-separated tool paths", () => {
  const root = mkdtempSync(join(tmpdir(), "daygle-tools-"));
  mkdirSync(join(root, "a"), { recursive: true });
  mkdirSync(join(root, "b"), { recursive: true });
  writeFileSync(join(root, "a", "one.txt"), "alpha needle\n");
  writeFileSync(join(root, "b", "two.txt"), "beta needle\n");

  test("search accepts several space-separated paths in one call", async () => {
    const result = await runTool(root, "search", { pattern: "needle", path: "a one.txt b/two.txt" });
    expect(result).toContain("one.txt");
    expect(result).toContain("two.txt");
  });

  test("list_files accepts several space-separated paths in one call", async () => {
    const result = await runTool(root, "list_files", { path: "a b" });
    expect(result).toContain("a/one.txt");
    expect(result).toContain("b/two.txt");
  });

  test("search reports missing paths instead of crashing on ENOENT", async () => {
    await expect(
      runTool(root, "search", { pattern: "needle", path: "does-not-exist" }),
    ).rejects.toThrow(/No such file or directory/);
  });

  test("search skips missing paths when at least one target exists", async () => {
    const result = await runTool(root, "search", { pattern: "needle", path: "a ghost.txt" });
    expect(result).toContain("one.txt");
  });
});

describe("tool hardening", () => {
  const root = mkdtempSync(join(tmpdir(), "daygle-tools-hardening-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "code.txt"), "hello world\n");
  writeFileSync(join(root, "blob.bin"), "text\u0000binary");
  // A symlink inside the repo that points outside it.
  symlinkSync(tmpdir(), join(root, "escape"));

  test("read_file refuses paths that escape the repo through a symlink", async () => {
    await expect(runTool(root, "read_file", { path: "escape" })).rejects.toThrow(/outside the repository/);
  });

  test("list_files survives one missing path in a multi-path call", async () => {
    const result = await runTool(root, "list_files", { path: "src ghost.txt" });
    expect(result).toContain("src/code.txt");
    expect(result).toContain("(not found: ghost.txt)");
  });

  test("list_files reports a clear error when every path is missing", async () => {
    await expect(runTool(root, "list_files", { path: "nope also-missing" })).rejects.toThrow(
      /No such file or directory/,
    );
  });

  test("search rejects an empty pattern instead of matching everything", async () => {
    await expect(runTool(root, "search", { pattern: "" })).rejects.toThrow(/Missing search pattern/);
  });

  test("read_file flags binary files instead of returning garbage", async () => {
    await expect(runTool(root, "read_file", { path: "blob.bin" })).rejects.toThrow(/binary/);
  });

  test("reviewer cannot execute inline code through runners", () => {
    const evil = 'node -e \'require("fs").rmSync("x")\'';
    expect(isReviewSafeCommand(evil)).toBe(false);
    expect(isReviewSafeCommand("python -m pip install requests")).toBe(false);
    expect(isReviewSafeCommand("bun --eval 'console.log(1)'")).toBe(false);
    expect(isReviewSafeCommand("node --version")).toBe(true);
    expect(isReviewSafeCommand("npm test")).toBe(true);
  });
});

describe("str_replace", () => {
  const root = mkdtempSync(join(tmpdir(), "daygle-tools-strreplace-"));
  const file = join(root, "code.txt");
  const reset = () => writeFileSync(file, "line one — dash\nline two — dash\nline three\n");

  test("replaces a unique match in place, preserving the rest of the file", async () => {
    reset();
    const result = await runTool(root, "str_replace", {
      path: "code.txt",
      old_string: "line two — dash",
      new_string: "line two - dash",
    });
    expect(result).toContain("Replaced 1 occurrence");
    expect(readFileSync(file, "utf8")).toBe("line one — dash\nline two - dash\nline three\n");
  });

  test("replaces every occurrence with replace_all", async () => {
    reset();
    const result = await runTool(root, "str_replace", {
      path: "code.txt",
      old_string: "—",
      new_string: "-",
      replace_all: true,
    });
    expect(result).toContain("Replaced 2 occurrences");
    expect(readFileSync(file, "utf8")).toBe("line one - dash\nline two - dash\nline three\n");
  });

  test("rejects an ambiguous match unless replace_all is set", async () => {
    reset();
    await expect(
      runTool(root, "str_replace", { path: "code.txt", old_string: "—", new_string: "-" }),
    ).rejects.toThrow(/appears 2 times/);
  });

  test("errors clearly when old_string is not found", async () => {
    reset();
    await expect(
      runTool(root, "str_replace", { path: "code.txt", old_string: "not here", new_string: "x" }),
    ).rejects.toThrow(/was not found/);
  });

  test("refuses paths outside the repo", async () => {
    reset();
    await expect(
      runTool(root, "str_replace", { path: "../outside.txt", old_string: "a", new_string: "b" }),
    ).rejects.toThrow(/outside the repository/);
  });
});

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
