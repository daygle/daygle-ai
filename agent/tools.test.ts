/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCommand, isReviewSafeCommand, runTool } from "./tools";

describe("space-separated tool paths", () => {
  const root = mkdtempSync(join(tmpdir(), "daygle-tools-"));
  const globRoot = mkdtempSync(join(tmpdir(), "daygle-tools-glob-"));
  mkdirSync(join(root, "a"), { recursive: true });
  mkdirSync(join(root, "b"), { recursive: true });
  mkdirSync(join(root, "modules", "src"), { recursive: true });
  mkdirSync(join(globRoot, "api", "src", "nested"), { recursive: true });
  writeFileSync(join(globRoot, "api", "src", "one.ts"), "alpha needle\n");
  writeFileSync(join(globRoot, "api", "src", "nested", "two.ts"), "beta needle\n");
  writeFileSync(join(root, "a", "one.txt"), "alpha needle\n");
  writeFileSync(join(root, "b", "two.txt"), "beta needle\n");
  writeFileSync(join(root, "modules", "src", "nested.txt"), "nested needle\n");

  test("search accepts several space-separated paths in one call", async () => {
    const result = await runTool(root, "search", { pattern: "needle", path: "a/one.txt b/two.txt" });
    expect(result).toContain("one.txt");
    expect(result).toContain("two.txt");
  });

  test("search accepts absolute and relative paths without joining them", async () => {
    const result = await runTool(root, "search", {
      pattern: "needle",
      path: `${join(root, "a", "one.txt")} b/two.txt`,
    });
    expect(result).toContain("one.txt");
    expect(result).toContain("two.txt");
  });

  test("semantic search finds lines by related words without regex syntax", async () => {
    const result = await runTool(root, "search", { pattern: "alpha needle", semantic: true, path: "a" });
    expect(result).toContain("one.txt");
  });

  test("semantic search uses local embeddings when Ollama is available", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (..._args: Parameters<typeof fetch>) =>
      new Response(JSON.stringify({ embeddings: [[1, 0], [0.99, 0.01]] }), { status: 200 })) as typeof fetch;
    try {
      const result = await runTool(root, "search", { pattern: "unrelated wording", semantic: true, path: "a" });
      expect(result).toContain("one.txt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("list_files accepts several space-separated paths in one call", async () => {
    const result = await runTool(root, "list_files", { path: "a b" });
    expect(result).toContain("a/one.txt");
    expect(result).toContain("b/two.txt");
  });

  test("search and list_files normalize Windows separators from model output", async () => {
    const result = await runTool(root, "search", { pattern: "needle", path: "a\\\\" });
    expect(result).toContain("one.txt");
    const listing = await runTool(root, "list_files", { path: "a\\\\" });
    expect(listing).toContain("a/one.txt");
  });

  test("recovers a uniquely nested directory when the model drops its parent", async () => {
    const result = await runTool(root, "search", { pattern: "nested", path: "src" });
    expect(result).toContain("modules/src/nested.txt");
    expect(result).toContain("resolved src to modules/src");
  });

  test("search falls back to the whole workspace when every path is missing", async () => {
    const result = await runTool(root, "search", { pattern: "needle", path: "does-not-exist" });
    expect(result).toContain("one.txt");
    expect(result).toContain("path not found: does-not-exist");
  });

  test("search skips missing paths when at least one target exists", async () => {
    const result = await runTool(root, "search", { pattern: "needle", path: "a ghost.txt" });
    expect(result).toContain("one.txt");
  });

  test("search and list_files expand recursive directory globs", async () => {
    const searchResult = await runTool(globRoot, "search", { pattern: "needle", path: "api/src/**/*.ts" });
    expect(searchResult).toContain("api/src/one.ts");
    expect(searchResult).toContain("api/src/nested/two.ts");

    const listing = await runTool(globRoot, "list_files", { path: "api/src/**/*.ts" });
    expect(listing).toContain("api/src/one.ts");
    expect(listing).toContain("api/src/nested/two.ts");
  });
});

describe("tool hardening", () => {
  const root = mkdtempSync(join(tmpdir(), "daygle-tools-hardening-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "code.txt"), "hello world\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test", deploy: "rm -rf /" } }));
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
    expect(isReviewSafeCommand("npm test", root)).toBe(true);
    expect(isReviewSafeCommand("npm run deploy", root)).toBe(false);
    expect(isReviewSafeCommand("npm run test --prefix ../other", root)).toBe(false);
  });

  test("requires a sandbox for create_pr instead of using host execution", async () => {
    await expect(
      runTool(root, "create_pr", { title: "Test", body: "Body", base: "main" }, async () => "approve"),
    ).rejects.toThrow(/requires a command sandbox/);
  });

  test("denies host command execution unless explicitly opted in", async () => {
    const previous = process.env.DAYGLE_ALLOW_HOST_COMMANDS;
    delete process.env.DAYGLE_ALLOW_HOST_COMMANDS;
    try {
      const result = await runTool(root, "run_command", { command: "true" });
      expect(result).toContain("no command sandbox is available");
    } finally {
      if (previous === undefined) delete process.env.DAYGLE_ALLOW_HOST_COMMANDS;
      else process.env.DAYGLE_ALLOW_HOST_COMMANDS = previous;
    }
  });

  test("read-only command execution uses the sandbox's immutable path", async () => {
    let mode = "";
    const sandbox = {
      name: "test",
      run: async () => "writable",
      runReadOnly: async () => { mode = "readonly"; return "readonly"; },
      runCapture: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, overflow: false }),
    };
    const result = await runTool(root, "run_command", { command: "true" }, undefined, sandbox, undefined, true);
    expect(result).toBe("readonly");
    expect(mode).toBe("readonly");
  });
});

describe("str_replace", () => {
  const root = mkdtempSync(join(tmpdir(), "daygle-tools-strreplace-"));
  const file = join(root, "code.txt");
  const apiSrc = join(root, "api", "src");
  mkdirSync(apiSrc, { recursive: true });
  writeFileSync(join(apiSrc, "one.ts"), "needle one\n");
  writeFileSync(join(apiSrc, "two.ts"), "needle two\n");
  const reset = () => writeFileSync(file, "line one - dash\nline two - dash\nline three\n");

  test("replaces a unique match in place, preserving the rest of the file", async () => {
    reset();
    const result = await runTool(root, "str_replace", {
      path: "code.txt",
      old_string: "line two - dash",
      new_string: "line two - dash",
    });
    expect(result).toContain("Replaced 1 occurrence");
    expect(readFileSync(file, "utf8")).toBe("line one - dash\nline two - dash\nline three\n");
  });

  test("replaces every occurrence with replace_all", async () => {
    reset();
    const result = await runTool(root, "str_replace", {
      path: "code.txt",
      old_string: "-",
      new_string: "-",
      replace_all: true,
    });
    expect(result).toContain("Replaced 2 occurrences");
    expect(readFileSync(file, "utf8")).toBe("line one - dash\nline two - dash\nline three\n");
  });

  test("rejects an ambiguous match unless replace_all is set", async () => {
    reset();
    await expect(
      runTool(root, "str_replace", { path: "code.txt", old_string: "-", new_string: "-" }),
    ).rejects.toThrow(/appears 2 times/);
  });

  test("replaces matching files under a directory with approval", async () => {
    const result = await runTool(root, "str_replace", {
      path: "api/src",
      old_string: "needle",
      new_string: "found",
    }, async () => "approve");
    expect(result).toContain("across 2 files");
    expect(readFileSync(join(apiSrc, "one.ts"), "utf8")).toBe("found one\n");
    expect(readFileSync(join(apiSrc, "two.ts"), "utf8")).toBe("found two\n");
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

  test("splits a comma-separated grep-style path list and strips line suffixes", async () => {
    const result = await runTool(root, "str_replace", {
      path: "api/src/one.ts:1, api/src/two.ts:1",
      old_string: "found",
      new_string: "fixed",
    }, async () => "approve");
    expect(result).toContain("across 2 files");
    expect(readFileSync(join(apiSrc, "one.ts"), "utf8")).toBe("fixed one\n");
    expect(readFileSync(join(apiSrc, "two.ts"), "utf8")).toBe("fixed two\n");
  });

  test("strips a trailing line suffix from a single path", async () => {
    reset();
    const result = await runTool(root, "str_replace", {
      path: "code.txt:2",
      old_string: "line two - dash",
      new_string: "line two - em dash",
    });
    expect(result).toContain("Replaced 1 occurrence");
    expect(readFileSync(file, "utf8")).toContain("line two - em dash");
  });

  test("diagnoses a near match that differs only in dash character", async () => {
    const dashed = join(root, "dashed.txt");
    writeFileSync(dashed, "first\nvalue \u2013 value\nlast\n"); // en dash in file
    await expect(
      runTool(root, "str_replace", {
        path: "dashed.txt",
        old_string: "value \u2014 value", // em dash from the model
        new_string: "value - value",
      }),
    ).rejects.toThrow(/near match exists at line 2.*en dash.*em dash/s);
  });
});

describe("paths with spaces", () => {
  const root = mkdtempSync(join(tmpdir(), "daygle-tools-spaces-"));
  writeFileSync(join(root, "my notes.txt"), "alpha needle\n");

  test("search treats a literal path with spaces as one path", async () => {
    const result = await runTool(root, "search", { pattern: "needle", path: "my notes.txt" });
    expect(result).toContain("my notes.txt:1:");
  });

  test("search parses a quoted path with spaces", async () => {
    const result = await runTool(root, "search", { pattern: "needle", path: '"my notes.txt"' });
    expect(result).toContain("my notes.txt:1:");
  });

  test("list_files treats a literal path with spaces as one path", async () => {
    const result = await runTool(root, "list_files", { path: "my notes.txt" });
    expect(result).toContain("my notes.txt");
  });
});

describe("write_file truncation warning", () => {
  const root = mkdtempSync(join(tmpdir(), "daygle-tools-writefile-"));
  const file = join(root, "big.txt");

  test("blocks an unapproved rewrite that would remove most of a file", async () => {
    writeFileSync(file, Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));
    await expect(runTool(root, "write_file", { path: "big.txt", content: "one line\n" })).rejects.toThrow(/Refusing to overwrite/);
  });

  test("allows an explicitly approved full rewrite", async () => {
    writeFileSync(file, Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));
    const result = await runTool(
      root,
      "write_file",
      { path: "big.txt", content: "one line\n" },
      async () => "approve",
    );
    expect(result).toContain("Approved full rewrite");
  });

  test("does not warn for similar-sized rewrites or new files", async () => {
    writeFileSync(file, "a\nb\nc\n");
    const result = await runTool(root, "write_file", { path: "big.txt", content: "a\nb\nc\nd\n" });
    expect(result).not.toContain("WARNING");
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

  test("requires approval for read-only programs that can write files", () => {
    expect(classifyCommand("sort -o out.txt in.txt")).toBe("approve");
    expect(classifyCommand("sort --output=out.txt in.txt")).toBe("approve");
    expect(classifyCommand("sort in.txt")).toBe("allow");
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
    expect(isReviewSafeCommand("cd ../../outside && npm test")).toBe(false);
    expect(isReviewSafeCommand("cd /tmp && npm test")).toBe(false);
    expect(isReviewSafeCommand("npm run deploy")).toBe(false);
  });

  test("rejects read-only programs that can write files", () => {
    expect(isReviewSafeCommand("sort -o out.txt in.txt")).toBe(false);
    expect(isReviewSafeCommand("sort in.txt")).toBe(true);
  });
});
