import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const REPO_OWNER = "daygle";
const REPO_NAME = "daygle-ai";

export interface AppUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseNotes?: string;
  releaseUrl?: string;
  publishedAt?: string;
}

/**
 * Get the current version from package.json.
 */
export function getCurrentVersion(): string {
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
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
export async function checkForAppUpdate(): Promise<AppUpdateInfo> {
  const currentVersion = getCurrentVersion();

  try {
    // Try using Octokit (GitHub App auth) first, fall back to unauthenticated
    let latestRelease: any = null;

    // Use GitHub API (unauthenticated for public repos)
    const response = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "daygle-ai-updater",
        },
      }
    );

    if (response.ok) {
      latestRelease = await response.json();
    }

    if (!latestRelease) {
      return {
        currentVersion,
        latestVersion: currentVersion,
        updateAvailable: false,
      };
    }

    const latestVersion = normalizeVersion(latestRelease.tag_name || latestRelease.name || currentVersion);
    const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;

    return {
      currentVersion,
      latestVersion,
      updateAvailable,
      releaseNotes: latestRelease.body || "",
      releaseUrl: latestRelease.html_url || "",
      publishedAt: latestRelease.published_at || "",
    };
  } catch (error) {
    console.error("Failed to check for app update:", error);
    return {
      currentVersion,
      latestVersion: currentVersion,
      updateAvailable: false,
    };
  }
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
      execSync("git stash", { cwd: appDir, stdio: "pipe" });
    } catch {
      // Ignore stash errors (might be nothing to stash)
    }

    // Pull latest changes
    execSync("git pull origin main", { cwd: appDir, stdio: "pipe" });

    updateProgress = { status: "installing", message: "Installing dependencies...", startedAt: updateProgress?.startedAt ?? Date.now() };
    emit({ type: "update_progress", message: "Installing dependencies..." });

    // Detect package manager and install
    const hasBunLock = fs.existsSync(path.join(appDir, "bun.lockb"));
    const hasPnpmLock = fs.existsSync(path.join(appDir, "pnpm-lock.yaml"));
    const hasYarnLock = fs.existsSync(path.join(appDir, "yarn.lock"));

    if (hasBunLock) {
      execSync("bun install", { cwd: appDir, stdio: "pipe" });
    } else if (hasPnpmLock) {
      execSync("pnpm install", { cwd: appDir, stdio: "pipe" });
    } else if (hasYarnLock) {
      execSync("yarn install", { cwd: appDir, stdio: "pipe" });
    } else {
      execSync("npm install", { cwd: appDir, stdio: "pipe" });
    }

    updateProgress = { status: "building", message: "Building application...", startedAt: updateProgress?.startedAt ?? Date.now() };
    emit({ type: "update_progress", message: "Building application..." });

    // Build the project
    execSync("npm run build", { cwd: appDir, stdio: "pipe" });

    updateProgress = { status: "complete", message: "Update complete! Restart the application to use the new version.", startedAt: updateProgress?.startedAt ?? Date.now() };
    emit({
      type: "update_complete",
      message: "Update complete! Restart the application to use the new version.",
      success: true,
    });
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
