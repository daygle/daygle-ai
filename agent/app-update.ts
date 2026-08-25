import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const REPO_OWNER = "daygle";
const REPO_NAME = "daygle-ai";
const VERSION_STATE = path.join(os.homedir(), ".daygle", "current-version");
const RESTART_HELPER = `
const { spawn, spawnSync } = require("node:child_process");
const pid = Number(process.env.DAYGLE_RESTART_PID);
const cwd = process.env.DAYGLE_RESTART_DIR;
const executable = process.env.DAYGLE_RESTART_EXECUTABLE;
setTimeout(() => {
  if (!cwd || !executable || !Number.isInteger(pid) || pid <= 0) process.exit(1);
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/f"], { stdio: "ignore" });
  } else {
    try { process.kill(pid, "SIGKILL"); } catch { /* process already exited */ }
  }
  const child = spawn(executable, ["run", "agent/server.ts"], {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.on("error", () => process.exit(1));
  child.unref();
}, 2000);
`;

/**
 * Get the installed version. Prefers the state file written by the updater
 * after a successful update, then git tags, then package.json.
 */
export function getCurrentVersion(): string {
  try {
    return fs.readFileSync(VERSION_STATE, "utf8").trim();
  } catch { /* not yet installed by updater */ }

  try {
    const tag = execFileSync("git", ["describe", "--tags", "--abbrev=0"], { stdio: "pipe" }).toString().trim();
    return tag.replace(/^v/i, "");
  } catch { /* no git repo or no tags */ }

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Write the installed version after a successful update. */
function writeCurrentVersion(version: string): void {
  try {
    fs.mkdirSync(path.dirname(VERSION_STATE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(VERSION_STATE, version, { encoding: "utf8", mode: 0o600 });
  } catch { /* best effort */ }
}

/** Returns true if bun is available on PATH. */
function packageManagerExecutable(pm: string): string {
  switch (pm) {
    case "bun": return "bun";
    case "pnpm": return "pnpm";
    case "yarn": return "yarn";
    default: return "npm";
  }
}

function runPackageManager(pm: string, args: string[], cwd: string): void {
  execFileSync(packageManagerExecutable(pm), args, { cwd, stdio: "pipe" });
}

function whichBun(): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", ["bun"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export interface AppUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseNotes?: string;
  releaseUrl?: string;
  publishedAt?: string;
  /** Non-null when the update check itself failed (e.g. rate-limited). */
  error?: string;
}

/**
 * Compare semantic version strings. Returns:
 * - 1 if a > b
 * - -1 if a < b
 * - 0 if equal
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * Strip leading 'v' from version tag if present.
 */
function normalizeVersion(tag: string): string {
  return tag.replace(/^v/i, "");
}

/**
 * Check GitHub for the latest release of the application.
 */
function ghHeaders(githubToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "daygle-ai-updater",
  };
  if (githubToken) h.Authorization = `Bearer ${githubToken}`;
  return h;
}

async function ghFetch<T>(url: string, githubToken?: string): Promise<{ data: T | null; error?: string }> {
  try {
    const res = await fetch(url, { headers: ghHeaders(githubToken) });
    if (!res.ok) {
      const label = res.status === 403 ? "GitHub API rate-limited" : `GitHub API ${res.status}`;
      console.error(label, url);
      return { data: null, error: label };
    }
    return { data: (await res.json()) as T };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("GitHub API fetch failed:", msg);
    return { data: null, error: msg };
  }
}

export async function checkForAppUpdate(githubToken?: string): Promise<AppUpdateInfo> {
  const currentVersion = getCurrentVersion();
  const base = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;

  try {
    // 1. Try /releases/latest (non-draft, non-prerelease).
    const latest = await ghFetch<any>(`${base}/releases/latest`, githubToken);
    if (latest.data) {
      return buildReleaseInfo(currentVersion, latest.data);
    }

    // 2. Fall back to the full releases list and pick the newest
    //    non-draft, non-prerelease entry.
    const relList = await ghFetch<any[]>(`${base}/releases?per_page=10`, githubToken);
    if (relList.data) {
      const stable = relList.data.find((r: any) => !r.draft && !r.prerelease);
      if (stable) {
        return buildReleaseInfo(currentVersion, stable);
      }
      // If every release is a prerelease/draft, still surface the newest
      // so the user knows something exists.
      if (relList.data.length > 0) {
        return buildReleaseInfo(currentVersion, relList.data[0]);
      }
    }

    // 3. Fall back to tags – the user may have pushed a version tag
    //    without creating a formal release.
    const tags = await ghFetch<Array<{ name: string }>>(`${base}/tags?per_page=10`, githubToken);
    if (tags.data && tags.data.length > 0) {
      // Find the newest tag whose name looks like a semver version.
      for (const tag of tags.data) {
        const ver = normalizeVersion(tag.name);
        if (/^\d+\.\d+/.test(ver) && compareVersions(ver, currentVersion) > 0) {
          return {
            currentVersion,
            latestVersion: ver,
            updateAvailable: true,
            releaseUrl: `${base}/releases/tag/${encodeURIComponent(tag.name)}`,
          };
        }
      }
    }

    // Nothing newer found – but report any transient error.
    const errMsg = latest.error ?? relList.error ?? tags.error;
    return {
      currentVersion,
      latestVersion: currentVersion,
      updateAvailable: false,
      ...(errMsg ? { error: errMsg } : {}),
    };
  } catch (error) {
    console.error("Failed to check for app update:", error);
    return {
      currentVersion,
      latestVersion: currentVersion,
      updateAvailable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildReleaseInfo(currentVersion: string, release: any): AppUpdateInfo {
  const latestVersion = normalizeVersion(release.tag_name || release.name || currentVersion);
  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
    releaseNotes: release.body || "",
    releaseUrl: release.html_url || "",
    publishedAt: release.published_at || "",
  };
}

// Cached update check result so status polling doesn't re-hit GitHub API every 2s.
let lastCheckResult: AppUpdateInfo | null = null;
let lastCheckAt = 0;
const CHECK_CACHE_TTL_MS = 60_000; // 1 minute

/** Cached version of checkForAppUpdate used by the status endpoint. */
export async function checkForAppUpdateCached(githubToken?: string): Promise<AppUpdateInfo> {
  if (lastCheckResult && Date.now() - lastCheckAt < CHECK_CACHE_TTL_MS) {
    return lastCheckResult;
  }
  lastCheckResult = await checkForAppUpdate(githubToken);
  lastCheckAt = Date.now();
  return lastCheckResult;
}

// Update progress tracking
let updateProgress: { status: string; message: string; startedAt: number } | null = null;

/** Get the current update progress. */
export function getUpdateProgress() {
  return updateProgress;
}

/**
 * Perform the actual update by pulling latest changes and rebuilding.
 * This runs in the background and emits progress via callback.
 */
export async function performAppUpdate(
  emit: (event: { type: string; message: string; success?: boolean }) => void,
): Promise<void> {
  const appDir = process.cwd();
  updateProgress = { status: "started", message: "Starting update...", startedAt: Date.now() };

  try {
    updateProgress = { status: "pulling", message: "Pulling latest changes...", startedAt: updateProgress?.startedAt ?? Date.now() };
    emit({ type: "update_progress", message: "Pulling latest changes..." });

    // Check if it's a git repo
    const isGitRepo = fs.existsSync(path.join(appDir, ".git"));
    if (!isGitRepo) {
      throw new Error("Not a git repository. Cannot auto-update.");
    }

    // Stash any local changes
    try {
      execFileSync("git", ["stash"], { cwd: appDir, stdio: "pipe" });
    } catch {
      // Ignore stash errors (might be nothing to stash)
    }

    // Detect the default branch (main, master, etc.)
    let defaultBranch = "main";
    try {
      const ref = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: appDir, stdio: "pipe" })
        .toString().trim().replace("refs/remotes/origin/", "");
      if (/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) && !ref.includes("..")) defaultBranch = ref;
    } catch {
      // Fallback: check common branch names
      for (const candidate of ["main", "master", "develop"]) {
        try {
          execFileSync("git", ["rev-parse", "--verify", `origin/${candidate}`], { cwd: appDir, stdio: "pipe" });
          defaultBranch = candidate;
          break;
        } catch { /* try next */ }
      }
    }

    // Pull latest changes including tags
    try {
      execFileSync("git", ["pull", "origin", defaultBranch, "--tags"], { cwd: appDir, stdio: "pipe" });
    } catch (err) {
      throw new Error(`git pull failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    updateProgress = { status: "installing", message: "Installing dependencies...", startedAt: updateProgress?.startedAt ?? Date.now() };
    emit({ type: "update_progress", message: "Installing dependencies..." });

    // Detect package manager (check lock files first, then try bun, then npm)
    const hasBunLock = fs.existsSync(path.join(appDir, "bun.lockb")) || fs.existsSync(path.join(appDir, "bun.lock"));
    const hasPnpmLock = fs.existsSync(path.join(appDir, "pnpm-lock.yaml"));
    const hasYarnLock = fs.existsSync(path.join(appDir, "yarn.lock"));
    const pm = hasBunLock ? "bun" : hasPnpmLock ? "pnpm" : hasYarnLock ? "yarn" : whichBun() ? "bun" : "npm";

    runPackageManager(pm, ["install"], appDir);

    updateProgress = { status: "building", message: "Building application...", startedAt: updateProgress?.startedAt ?? Date.now() };
    emit({ type: "update_progress", message: "Building application..." });

    runPackageManager(pm, ["run", "build"], appDir);

    // Record the newly installed version after a successful build
    try {
      const tag = execFileSync("git", ["describe", "--tags", "--abbrev=0"], { cwd: appDir, stdio: "pipe" }).toString().trim();
      writeCurrentVersion(tag.replace(/^v/i, ""));
    } catch { /* best effort */ }

    updateProgress = { status: "restarting", message: "Restarting agent server...", startedAt: updateProgress?.startedAt ?? Date.now() };
    emit({ type: "update_progress", message: "Restarting agent server..." });

    // Restart the agent server
    await restartAgentServer(appDir);

    updateProgress = { status: "complete", message: "Update complete! Server is restarting.", startedAt: updateProgress?.startedAt ?? Date.now() };
    emit({
      type: "update_complete",
      message: "Update complete! Server is restarting. The page will reload automatically.",
      success: true,});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateProgress = { status: "failed", message: `Update failed: ${message}`, startedAt: updateProgress?.startedAt ?? Date.now() };
    emit({
      type: "update_error",
      message: `Update failed: ${message}`,
      success: false,
    });
  }
}

/** Restart the server through a shell-free detached Bun helper. */
async function restartAgentServer(appDir: string): Promise<void> {
  const safeDir = path.resolve(appDir);
  const executable = process.execPath;
  const safePid = Number.isInteger(process.pid) && process.pid > 0 ? process.pid : 1;
  const child = spawn(executable, ["-e", RESTART_HELPER], {
    cwd: safeDir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      DAYGLE_RESTART_PID: String(safePid),
      DAYGLE_RESTART_DIR: safeDir,
      DAYGLE_RESTART_EXECUTABLE: executable,
    },
  });
  child.unref();
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
