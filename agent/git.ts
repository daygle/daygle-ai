import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseRepo } from "./github";

function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || error.message).toString().trim();
        reject(new Error(detail || `${cmd} ${args.join(" ")} failed`));
      } else {
        resolve(stdout.toString().trim());
      }
    });
  });
}

function tokenUrl(url: string, token: string): string {
  const { owner, repo } = parseRepo(url);
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git`;
}

export async function cloneRepo(url: string, dir: string, token?: string): Promise<void> {
  const target = token ? tokenUrl(url, token) : url;
  await run("git", ["clone", "--depth", "1", target, dir]);
}

export async function detectDefaultBranch(url: string, token?: string): Promise<string> {
  const target = token ? tokenUrl(url, token) : url;
  const out = await run("git", ["ls-remote", "--symref", target, "HEAD"]);
  const match = out.match(/ref: refs\/heads\/(\S+)/);
  return match?.[1] ?? "main";
}

export async function createBranch(dir: string, branch: string): Promise<void> {
  await run("git", ["checkout", "-b", branch], dir);
}

export async function changedFiles(dir: string): Promise<string[]> {
  const out = await run("git", ["status", "--porcelain"], dir);
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
