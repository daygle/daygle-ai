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
  const depth = process.env.DAYGLE_CLONE_DEPTH ?? "50";
  await runWithToken("git", ["clone", "--depth", depth, "--", target, dir], token);
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

interface IndexEntry {
  mode: string;
  hash: string;
  path: string;
}

export interface WorkingTreeCheckpoint {
  head: string;
  directory: string;
  /** Ignored files present before the task, used to remove generated ignored files on restore. */
  ignored: string[];
  /** Separate patches preserve staged/index state instead of flattening everything into HEAD. */
  stagedPatchPath?: string;
  unstagedPatchPath?: string;
  ignoredSnapshotDirectory?: string;
  /** Exact worktree bytes for changed tracked files, preserving platform line endings. */
  trackedSnapshotDirectory?: string;
  trackedFiles?: string[];
  trackedDeletedFiles?: string[];
  trackedSnapshotComplete?: boolean;
  /** Staged index entries and deletions for patch-free index restore. */
  indexModifications?: IndexEntry[];
  indexDeletions?: string[];
}

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
    .map((line) => {
      const entry = line.slice(3).trim();
      // Rename entries look like "old -> new"; the new path is what matters.
      const arrow = entry.indexOf(" -> ");
      return arrow >= 0 ? entry.slice(arrow + 4) : entry;
    })
    .filter(Boolean);
}

/** Maximum snapshot size for a single checkpoint, including ignored-file copies. */
const CHECKPOINT_PATCH_LIMIT = 5 * 1024 * 1024;
const CHECKPOINT_IGNORED_COPY_LIMIT = 50 * 1024 * 1024;
const IGNORED_COPY_EXCLUSIONS = new Set(["node_modules", ".git", "dist", "build", ".ollama"]);

function checkpointRelativePath(root: string, relative: string): string {
  const normalized = relative.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Invalid checkpoint path: ${relative}`);
  }
  return path.join(root, ...normalized.split("/"));
}

function expandIgnoredPath(root: string, relative: string, output: string[]): void {
  const normalized = relative.replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalized || IGNORED_COPY_EXCLUSIONS.has(normalized.split("/")[0])) return;
  const absolute = checkpointRelativePath(root, normalized);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(absolute); } catch { return; }
  if (!stat.isDirectory()) {
    output.push(normalized);
    return;
  }
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(absolute, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    expandIgnoredPath(root, `${normalized}/${entry.name}`, output);
  }
}

async function ignoredFiles(dir: string): Promise<string[]> {
  const entries = (await runRaw("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"], dir))
    .split("\0")
    .filter(Boolean);
  const files: string[] = [];
  for (const entry of entries) expandIgnoredPath(dir, entry, files);
  return [...new Set(files)];
}

async function changedTrackedFiles(dir: string): Promise<string[]> {
  const [staged, unstaged] = await Promise.all([
    runRaw("git", ["diff", "--cached", "--name-only", "-z"], dir),
    runRaw("git", ["diff", "--name-only", "-z"], dir),
  ]);
  return [...new Set([staged, unstaged]
    .flatMap((output) => output.split("\0"))
    .filter(Boolean)
    .map((entry) => entry.replaceAll("\\", "/")))];
}

/**
 * Capture the exact working tree before a task starts. Staged and unstaged
 * patches are stored separately, and ignored files are snapshotted by file
 * rather than by directory so generated files under an existing ignored
 * directory can be removed without deleting the baseline cache itself.
 */
export async function createCheckpoint(dir: string, directory: string): Promise<WorkingTreeCheckpoint> {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const head = await run("git", ["rev-parse", "HEAD"], dir);
  const staged = await run("git", ["diff", "--cached", "--binary"], dir);
  const unstaged = await run("git", ["diff", "--binary"], dir);
  if (Buffer.byteLength(staged, "utf8") + Buffer.byteLength(unstaged, "utf8") > CHECKPOINT_PATCH_LIMIT) {
    throw new Error("Checkpoint is too large (working diff exceeds 5 MB).");
  }
  const stagedPatchPath = path.join(directory, "staged.patch");
  const unstagedPatchPath = path.join(directory, "unstaged.patch");
  fs.writeFileSync(stagedPatchPath, staged, "utf8");
  fs.writeFileSync(unstagedPatchPath, unstaged, "utf8");

  const untracked = await runRaw("git", ["ls-files", "-z", "--others", "--exclude-standard"], dir);
  const untrackedDir = path.join(directory, "untracked");
  for (const relative of untracked.split("\0").filter(Boolean)) {
    const source = checkpointRelativePath(dir, relative);
    const destination = checkpointRelativePath(untrackedDir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
  }

  const tracked = await changedTrackedFiles(dir);
  const trackedSnapshotDirectory = path.join(directory, "tracked");
  let trackedBytes = 0;
  let trackedSnapshotComplete = true;
  const trackedFiles: string[] = [];
  const trackedDeletedFiles: string[] = [];
  for (const relative of tracked) {
    const source = checkpointRelativePath(dir, relative);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(source); } catch {
      // Preserve deletions separately when restoring from exact worktree bytes.
      trackedDeletedFiles.push(relative);
      continue;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      trackedSnapshotComplete = false;
      continue;
    }
    if (trackedBytes + stat.size > CHECKPOINT_IGNORED_COPY_LIMIT) {
      trackedSnapshotComplete = false;
      continue;
    }
    const destination = checkpointRelativePath(trackedSnapshotDirectory, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { verbatimSymlinks: true, force: true });
    trackedBytes += stat.size;
    trackedFiles.push(relative);
  }

  const ignored = await ignoredFiles(dir);
  const ignoredSnapshotDirectory = path.join(directory, "ignored");
  let ignoredBytes = 0;
  for (const relative of ignored) {
    const firstSegment = relative.split("/")[0];
    if (IGNORED_COPY_EXCLUSIONS.has(firstSegment)) continue;
    const source = checkpointRelativePath(dir, relative);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(source); } catch { continue; }
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    if (ignoredBytes + stat.size > CHECKPOINT_IGNORED_COPY_LIMIT) continue;
    const destination = checkpointRelativePath(ignoredSnapshotDirectory, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { verbatimSymlinks: true, force: true });
    ignoredBytes += stat.size;
  }
  // Capture staged index state for patch-free restore.
  const rawStaged = await runRaw("git", ["diff", "--cached", "--raw", "--no-abbrev"], dir);
  const indexModifications: IndexEntry[] = [];
  const indexDeletions: string[] = [];
  // Format per line: :old_mode new_mode old_hash new_hash status_score\tpath
  for (const line of rawStaged.split("\n")) {
    if (!line.startsWith(":")) continue;
    const tabIdx = line.lastIndexOf("\t");
    const meta = tabIdx >= 0 ? line.slice(1, tabIdx) : line.slice(1);
    const filePath = tabIdx >= 0 ? line.slice(tabIdx + 1) : "";
    const parts = meta.split(/\s+/);
    // parts: [old_mode, new_mode, old_hash, new_hash, status_score]
    const newHash = parts[3] ?? "";
    const status = parts[4] ?? "";
    const code = status.charAt(0);
    if (code === "D") {
      indexDeletions.push(filePath.replaceAll("\\", "/"));
    } else if (newHash && newHash !== "0000000000000000000000000000000000000000") {
      const mode = parts[1] ?? "100644";
      indexModifications.push({ mode, hash: newHash, path: filePath.replaceAll("\\", "/") });
    }
  }
  fs.writeFileSync(path.join(directory, "ignored.json"), JSON.stringify(ignored), "utf8");
  fs.writeFileSync(path.join(directory, "index.json"), JSON.stringify({ modifications: indexModifications, deletions: indexDeletions }), "utf8");
  return {
    head,
    directory,
    ignored,
    stagedPatchPath,
    unstagedPatchPath,
    ignoredSnapshotDirectory,
    trackedSnapshotDirectory,
    trackedFiles,
    trackedDeletedFiles,
    trackedSnapshotComplete,
    indexModifications,
    indexDeletions,
  };
}

/** Restore a checkout to a previously captured working-tree checkpoint. */
export async function restoreCheckpoint(dir: string, checkpoint: WorkingTreeCheckpoint): Promise<void> {
  await run("git", ["reset", "--hard", checkpoint.head], dir);
  await run("git", ["clean", "-fd"], dir);

  const currentIgnored = await ignoredFiles(dir);
  const baselineIgnored = new Set(checkpoint.ignored ?? []);
  for (const relative of currentIgnored) {
    if (!baselineIgnored.has(relative)) {
      try { fs.rmSync(checkpointRelativePath(dir, relative), { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  const ignoredSnapshotDirectory = checkpoint.ignoredSnapshotDirectory ?? path.join(checkpoint.directory, "ignored");
  if (fs.existsSync(ignoredSnapshotDirectory)) {
    for (const relative of baselineIgnored) {
      const source = checkpointRelativePath(ignoredSnapshotDirectory, relative);
      if (!fs.existsSync(source)) continue; // excluded/too-large baseline cache
      const destination = checkpointRelativePath(dir, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(source, destination, { verbatimSymlinks: true, force: true });
    }
  }

  const exactWorktree = checkpoint.trackedSnapshotComplete === true;
  const trackedSnapshotDirectory = checkpoint.trackedSnapshotDirectory ?? path.join(checkpoint.directory, "tracked");
  const trackedFiles = checkpoint.trackedFiles ?? [];
  const trackedDeletedFiles = checkpoint.trackedDeletedFiles ?? [];

  // Restore index state - prefer patch-free index-info when available.
  const indexData = checkpoint.indexModifications
    ? { modifications: checkpoint.indexModifications, deletions: checkpoint.indexDeletions ?? [] }
    : JSON.parse(fs.readFileSync(path.join(checkpoint.directory, "index.json"), "utf8") ?? "null") as { modifications: IndexEntry[]; deletions: string[] } | null;
  if (indexData) {
    for (const filePath of indexData.deletions) {
      await run("git", ["rm", "--cached", "--quiet", "--", filePath], dir).catch(() => {});
    }
    for (const entry of indexData.modifications) {
      await run("git", ["update-index", "--cacheinfo", `${entry.mode},${entry.hash},${entry.path}`], dir);
    }
  } else {
    // Legacy checkpoint: fall back to binary patches.
    const stagedPatch = checkpoint.stagedPatchPath ?? path.join(checkpoint.directory, "staged.patch");
    const unstagedPatch = checkpoint.unstagedPatchPath ?? path.join(checkpoint.directory, "unstaged.patch");
    if (fs.existsSync(stagedPatch) && fs.statSync(stagedPatch).size > 0) {
      await run("git", ["apply", "--binary", "--cached", stagedPatch], dir);
      await run("git", ["apply", "--binary", stagedPatch], dir);
    } else {
      const legacyPatch = path.join(checkpoint.directory, "working.patch");
      if (fs.existsSync(legacyPatch) && fs.statSync(legacyPatch).size > 0) {
        await run("git", ["apply", "--binary", legacyPatch], dir);
      }
    }
    if (fs.existsSync(unstagedPatch) && fs.statSync(unstagedPatch).size > 0) {
      await run("git", ["apply", "--binary", unstagedPatch], dir);
    }
  }
  // Apply exact worktree snapshot after any index restore.
  if (exactWorktree) {
    for (const relative of trackedDeletedFiles) {
      fs.rmSync(checkpointRelativePath(dir, relative), { recursive: true, force: true });
    }
    for (const relative of trackedFiles) {
      const source = checkpointRelativePath(trackedSnapshotDirectory, relative);
      if (!fs.existsSync(source)) continue;
      const destination = checkpointRelativePath(dir, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(source, destination, { verbatimSymlinks: true, force: true });
    }
  } else {
    const unstagedPatch = checkpoint.unstagedPatchPath ?? path.join(checkpoint.directory, "unstaged.patch");
    if (fs.existsSync(unstagedPatch) && fs.statSync(unstagedPatch).size > 0) {
      await run("git", ["apply", "--binary", unstagedPatch], dir);
    }
  }
  const untrackedDir = path.join(checkpoint.directory, "untracked");
  if (fs.existsSync(untrackedDir)) {
    fs.cpSync(untrackedDir, dir, { recursive: true, verbatimSymlinks: true, force: true });
  }
}

export function deleteCheckpoint(checkpoint: WorkingTreeCheckpoint): void {
  fs.rmSync(checkpoint.directory, { recursive: true, force: true });
}

export async function commitAll(dir: string, message: string): Promise<void> {
  await run("git", ["config", "user.name", "daygle"], dir).catch(() => {});
  await run("git", ["config", "user.email", "daygle@local"], dir).catch(() => {});
  await run("git", ["add", "-A"], dir);
  await run("git", ["commit", "-m", message], dir);
}

export async function pushBranch(dir: string, branch: string, token?: string): Promise<void> {
  // The origin remote embeds the access token in its URL (see tokenUrl), and git
  // echoes that URL in push failures. Scrub the token so a failed push can't leak
  // the credential into job events, the UI, or the audit log.
  try {
    await run("git", ["push", "-u", "origin", branch], dir);
  } catch (err) {
    throw new Error(redactToken(err instanceof Error ? err.message : String(err), token));
  }
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
