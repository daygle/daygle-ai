/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpoint, restoreCheckpoint } from "./git";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

describe("working-tree checkpoints", () => {
  test("restore staged and unstaged edits plus ignored-file additions", async () => {
    const root = mkdtempSync(join(tmpdir(), "daygle-git-checkpoint-"));
    git(root, "init", "-q");
    git(root, "config", "user.name", "test");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(join(root, ".gitignore"), "cache/\n");
    writeFileSync(join(root, "tracked.txt"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "base");

    mkdirSync(join(root, "cache"));
    writeFileSync(join(root, "cache", "baseline.txt"), "keep this baseline\n");
    writeFileSync(join(root, "tracked.txt"), "staged\n");
    git(root, "add", "tracked.txt");
    writeFileSync(join(root, "tracked.txt"), "staged then unstaged\n");
    writeFileSync(join(root, "baseline-untracked.txt"), "untracked baseline\n");

    const checkpointDir = mkdtempSync(join(tmpdir(), "daygle-checkpoint-data-"));
    const checkpoint = await createCheckpoint(root, checkpointDir);

    writeFileSync(join(root, "tracked.txt"), "destructive replacement\n");
    writeFileSync(join(root, "generated.txt"), "remove me\n");
    writeFileSync(join(root, "cache", "baseline.txt"), "modified cache\n");
    writeFileSync(join(root, "cache", "generated.txt"), "remove ignored file\n");

    await restoreCheckpoint(root, checkpoint);

    expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("staged then unstaged\n");
    expect(git(root, "status", "--porcelain")).toContain("MM tracked.txt");
    expect(readFileSync(join(root, "baseline-untracked.txt"), "utf8")).toBe("untracked baseline\n");
    expect(existsSync(join(root, "generated.txt"))).toBe(false);
    expect(readFileSync(join(root, "cache", "baseline.txt"), "utf8")).toBe("keep this baseline\n");
    expect(existsSync(join(root, "cache", "generated.txt"))).toBe(false);
  });
});
