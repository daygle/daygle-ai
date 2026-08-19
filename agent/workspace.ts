import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRepo } from "./github";
import { changedFiles, run, workingDiff } from "./git";

export interface WorkspaceStatus {
  connected: boolean;
  repoUrl?: string;
  owner?: string;
  repo?: string;
  dir?: string;
  branch?: string;
  changedFiles?: string[];
  diffStat?: string;
  diff?: string;
  lastCommit?: { hash: string; message: string; date: string } | null;
}

export function workspaceDir(owner: string, repo: string): string {
  return path.join(os.homedir(), ".daygle", "workspaces", `${owner}-${repo}`);
}

export async function currentBranch(dir: string): Promise<string> {
  return run("git", ["branch", "--show-current"], dir).catch(() => "");
}

/**
 * Connects a repo as the persistent workspace: clones it into
 * ~/.daygle/workspaces/ if needed (preferring `gh repo clone` for auth on
 * private repos, falling back to plain git), otherwise reuses the checkout.
 */
export async function connectWorkspace(repoUrl: string): Promise<WorkspaceStatus> {
  const { owner, repo } = parseRepo(repoUrl);
  const dir = workspaceDir(owner, repo);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (!fs.existsSync(path.join(dir, ".git"))) {
    try {
      await run("gh", ["repo", "clone", `${owner}/${repo}`, dir]);
    } catch {
      await run("git", ["clone", repoUrl, dir]);
    }
  }
  return buildStatus(repoUrl, dir);
}

async function buildStatus(repoUrl: string, dir: string): Promise<WorkspaceStatus> {
  const [branch, changed, diffData] = await Promise.all([
    currentBranch(dir),
    changedFiles(dir).catch(() => []),
    workingDiff(dir).catch(() => ({ stat: "", diff: "" })),
  ]);
  let lastCommit: WorkspaceStatus["lastCommit"] = null;
  try {
    const log = await run("git", ["log", "-1", "--format=%H%x09%ad%x09%s", "--date=iso"], dir);
    const [hash, date, ...rest] = log.split("\t");
    lastCommit = { hash: hash.slice(0, 12), date, message: rest.join("\t") };
  } catch {
    // no commits yet
  }
  return {
    connected: true,
    repoUrl,
    owner: parseRepo(repoUrl).owner,
    repo: parseRepo(repoUrl).repo,
    branch,
    changedFiles: changed,
    diffStat: diffData.stat,
    diff: diffData.diff,
    lastCommit,
  };
}

export async function statusWorkspace(repoUrl: string, dir: string): Promise<WorkspaceStatus> {
  return buildStatus(repoUrl, dir);
}

export async function pullWorkspace(dir: string): Promise<string> {
  return run("git", ["pull"], dir);
}

export async function commitWorkspace(dir: string, message: string): Promise<string> {
  await run("git", ["config", "user.name", "daygle"], dir).catch(() => {});
  await run("git", ["config", "user.email", "daygle@local"], dir).catch(() => {});
  await run("git", ["add", "-A"], dir);
  return run("git", ["commit", "-m", message], dir);
}

export async function pushWorkspace(dir: string): Promise<string> {
  const branch = (await currentBranch(dir)) || "main";
  return run("git", ["push", "-u", "origin", branch], dir);
}

export async function openWorkspacePr(
  dir: string,
  title: string,
  body?: string,
): Promise<string> {
  const branch = (await currentBranch(dir)) || "main";
  let base = "main";
  try {
    const ref = await run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir);
    base = ref.replace(/^origin\//, "");
  } catch {
    // default to main
  }
  const bodyFile = path.join(dir, ".daygle-pr-body.md");
  fs.writeFileSync(bodyFile, body || title, "utf8");
  try {
    const out = await run(
      "gh",
      ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body-file", bodyFile],
      dir,
    );
    const match = out.match(/https:\/\/github\.com\/[^\s]+/);
    return match ? match[0] : out;
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
}
