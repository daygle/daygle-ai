import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseRepo } from "./github";

function runInner(cmd: string, args: string[], cwd: string | undefined, trim: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || error.message).toString().trim();
        reject(new Error(detail || `${cmd} ${args.join(" ")} failed`));
      } else {
        resolve(trim ? stdout.toString().trim() : stdout.toString());
      }
    });
  });
}

/** Runs a command and trims surrounding whitespace from stdout. */
export function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return runInner(cmd, args, cwd, true);
}

/** Runs a command without trimming stdout (needed for `git status --porcelain`). */
export function runRaw(cmd: string, args: string[], cwd?: string): Promise<string> {
  return runInner(cmd, args, cwd, false);
}

function tokenUrl(url: string, token: string): string {
  const { owner, repo } = parseRepo(url);
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git`;
}

/**
 * Git embeds the full remote URL (credential included) in its error output
 * (e.g. "unable to access 'https://x-access-token:TOKEN@github.com/...'").
 * Scrub both the raw and URL-encoded token so failures can't leak the
 * credential into job events or the UI.
 */
function redactToken(message: string, token?: string): string {
  if (!token) return message;
  return message.replaceAll(token, "[credential redacted]").replaceAll(encodeURIComponent(token), "[credential redacted]");
}

async function runWithToken(cmd: string, args: string[], token: string | undefined): Promise<string> {
  try {
    return await run(cmd, args);
  } catch (err) {
    throw new Error(redactToken(err instanceof Error ? err.message : String(err), token));
  }
}

/**
 * Only allow real remote URLs (https/http with a resolvable host, the SSH
 * `git@github.com:` form, or a bare `github.com/` shorthand). Anything
 * starting with `-` is rejected so user-controlled input can't be parsed as
 * a git option (e.g. `--upload-pack=...`), and local paths / other schemes
 * are blocked.
 */
function isSafeGitRemote(target: string): boolean {
  if (!target || target.startsWith("-")) return false;
  if (target.startsWith("https://") || target.startsWith("http://")) {
    try {
      const url = new URL(target);
      return url.hostname.length > 0;
    } catch {
      return false;
    }
  }
  if (target.startsWith("git@github.com:")) return true;
  if (target.startsWith("github.com/")) return true;
  return false;
}

export async function cloneRepo(url: string, dir: string, token?: string): Promise<void> {
  const target = token ? tokenUrl(url, token) : url;
  if (!isSafeGitRemote(target)) {
    throw new Error(`Refusing to clone an unsafe repository URL.`);
  }
  await runWithToken("git", ["clone", "--depth", "1", "--", target, dir], token);
}

export async function detectDefaultBranch(url: string, token?: string): Promise<string> {
  const target = token ? tokenUrl(url, token) : url;
  if (!isSafeGitRemote(target)) {
    throw new Error(`Refusing to inspect an unsafe repository URL.`);
  }
  const out = await runWithToken("git", ["ls-remote", "--symref", "--", target, "HEAD"], token);
  const match = out.match(/ref: refs\/heads\/(\S+)/);
  return match?.[1] ?? "main";
}

export async function createBranch(dir: string, branch: string): Promise<void> {
  await run("git", ["checkout", "-b", branch], dir);
}

const MAX_STAT = 4_000;
const MAX_DIFF = 100_000;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

export async function workingDiff(dir: string): Promise<{ stat: string; diff: string }> {
  // Mark untracked files as intent-to-add so they appear in `git diff` (without staging content).
  await run("git", ["add", "-N", "."], dir).catch(() => {});
  const [stat, diff] = await Promise.all([
    run("git", ["diff", "--stat"], dir),
    run("git", ["diff"], dir),
  ]);
  return { stat: truncate(stat, MAX_STAT), diff: truncate(diff, MAX_DIFF) };
}

export async function changedFiles(dir: string): Promise<string[]> {
  const out = await runRaw("git", ["status", "--porcelain"], dir);
  return out
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

export async function commitAll(dir: string, message: string): Promise<void> {
  await run("git", ["config", "user.name", "daygle"], dir).catch(() => {});
  await run("git", ["config", "user.email", "daygle@local"], dir).catch(() => {});
  await run("git", ["add", "-A"], dir);
  await run("git", ["commit", "-m", message], dir);
}

export async function pushBranch(dir: string, branch: string): Promise<void> {
  await run("git", ["push", "-u", "origin", branch], dir);
}

export async function openPullRequest(
  dir: string,
  base: string,
  head: string,
  title: string,
  body: string,
): Promise<string> {
  const bodyFile = path.join(dir, ".daygle-pr-body.md");
  fs.writeFileSync(bodyFile, body, "utf8");
  try {
    const out = await run(
      "gh",
      ["pr", "create", "--base", base, "--head", head, "--title", title, "--body-file", bodyFile],
      dir,
    );
    const match = out.match(/https:\/\/github\.com\/[^\s]+/);
    return match ? match[0] : out;
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
}

export async function ghAuthenticated(): Promise<boolean> {
  try {
    await run("gh", ["auth", "status"]);
    return true;
  } catch {
    return false;
  }
}
