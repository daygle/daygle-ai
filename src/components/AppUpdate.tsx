import { useState, useEffect } from "react";
import { Download, Check, Loader2, ExternalLink, RefreshCw, GitPullRequest, Package, Hammer, RotateCcw } from "lucide-react";
import { checkAppUpdate, applyAppUpdate, type AppUpdateInfo } from "../lib/agent";

interface AppUpdateProgress {
  status: string;
  message: string;
  elapsed: number;
}

interface AppUpdateProps {
  serverUrl: string;
}

export function AppUpdate({ serverUrl }: AppUpdateProps) {
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<AppUpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  // Check for updates on mount
  useEffect(() => {
    checkForUpdates();
  }, [serverUrl]);

  async function checkForUpdates() {
    if (checking) return;
    setChecking(true);
    setError(null);
    try {
      const info = await checkAppUpdate(serverUrl);
      setUpdateInfo(info);
      setLastChecked(new Date());
      if (info.error) setError(info.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to check for updates");
    } finally {
      setChecking(false);
    }
  }

  async function handleUpdate() {
    if (updating) return;
    setUpdating(true);
    setUpdateMessage(null);
    setProgress(null);
    setError(null);
    try {
      const result = await applyAppUpdate(serverUrl);
      setUpdateMessage(result.message);

      // Poll for progress updates. The process that reports "complete" is
      // about to be replaced, so a restarted server may instead return no
      // in-memory progress and an up-to-date version.
      const baseUrl = serverUrl.replace(/\/$/, "");
      const pollInterval = setInterval(async () => {
        try {
          const statusRes = await fetch(`${baseUrl}/api/app-update/status`);
          if (!statusRes.ok) return;
          const statusData = await statusRes.json() as {
            progress?: AppUpdateProgress | null;
            updateAvailable?: boolean;
          };

          if (statusData.progress?.status === "complete") {
            clearInterval(pollInterval);
            setUpdateMessage("Update complete! Server is restarting...");
            waitForRestart(baseUrl);
            return;
          }

          if (statusData.progress?.status === "failed") {
            clearInterval(pollInterval);
            setError(statusData.progress.message);
            setUpdating(false);
            setProgress(null);
            return;
          }

          if (statusData.progress) {
            setProgress(statusData.progress);
          } else if (!statusData.updateAvailable) {
            // A fresh server loses the old process's in-memory progress. Once
            // it reports the new version, wait for health and reload the UI.
            clearInterval(pollInterval);
            setUpdateMessage("Update complete! Server is restarting...");
            waitForRestart(baseUrl);
          }
        } catch {
          // Server is likely restarting, keep polling.
        }
      }, 2000);

      // Stop polling after 10 minutes and leave the user with a retryable UI.
      setTimeout(() => {
        clearInterval(pollInterval);
        setUpdating(false);
        setProgress(null);
      }, 10 * 60 * 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start update");
      setUpdating(false);
    }
  }

  function waitForRestart(baseUrl: string): void {
    // Give the detached helper time to stop the old process before accepting a
    // health response. Otherwise the browser can reload against the old server.
    const reconnectInterval = setInterval(async () => {
      try {
        const healthRes = await fetch(`${baseUrl}/api/health`, { cache: "no-store" });
        if (!healthRes.ok) return;
        clearInterval(reconnectInterval);
        window.location.reload();
      } catch {
        // Server still restarting, keep waiting.
      }
    }, 2500);
    setTimeout(() => {
      clearInterval(reconnectInterval);
      setError("The agent server did not come back after the update. Start it again and refresh the page.");
      setUpdating(false);
      setProgress(null);
    }, 30000);
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-foreground">Application Updates</h3>
        <button
          onClick={checkForUpdates}
          disabled={checking || updating}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
          {checking ? "Checking..." : "Check for updates"}
        </button>
      </div>
      {lastChecked && !checking && (
        <p className="text-[10px] text-muted-foreground mb-2">
          Last checked: {lastChecked.toLocaleTimeString()}
        </p>
      )}

      {error && (
        <div className="text-sm text-red-500 mb-3">{error}</div>
      )}

      {updateInfo && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">Current version:</span>
            <span className="font-mono">{updateInfo.currentVersion}</span>
          </div>

          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">Latest version:</span>
            <span className="font-mono">{updateInfo.latestVersion}</span>
            {updateInfo.updateAvailable && (
              <span className="px-2 py-0.5 text-xs bg-green-500/10 text-green-500 rounded">
                Update available
              </span>
            )}
            {!updateInfo.updateAvailable && (
              <span className="px-2 py-0.5 text-xs bg-muted text-muted-foreground rounded">
                Up to date
              </span>
            )}
          </div>

          {updateInfo.updateAvailable && (
            <div className="pt-2 space-y-3">
              {updateInfo.releaseNotes && (
                <div className="text-sm text-muted-foreground bg-muted rounded p-3 max-h-40 overflow-y-auto">
                  <div className="font-medium text-foreground mb-1">Release Notes</div>
                  <div className="whitespace-pre-wrap">{updateInfo.releaseNotes}</div>
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  onClick={handleUpdate}
                  disabled={updating}
                  className="flex items-center gap-2 px-4 py-2 bg-accent text-accent-foreground rounded-md hover:bg-accent/90 disabled:opacity-50"
                >
                  {updating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  {updating ? "Updating..." : "Update Now"}
                </button>

                {updateInfo.releaseUrl && !updating && (
                  <a
                    href={updateInfo.releaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="h-4 w-4" />
                    View on GitHub
                  </a>
                )}
              </div>
            </div>
          )}

          {/* Step-by-step progress log */}
          {updating && progress && (
            <UpdateProgressLog progress={progress} />
          )}

          {updateMessage && (
            <div className="flex items-center gap-2 text-sm text-green-500">
              <Check className="h-4 w-4" />
              {updateMessage}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Step-by-step progress log shown during an update. */
function UpdateProgressLog({ progress }: { progress: AppUpdateProgress }) {
  const steps = [
    { key: "pulling", label: "Pulling latest changes", icon: GitPullRequest },
    { key: "installing", label: "Installing dependencies", icon: Package },
    { key: "building", label: "Building application", icon: Hammer },
    { key: "restarting", label: "Restarting server", icon: RotateCcw },
  ] as const;

  const statusOrder = ["started", "pulling", "installing", "building", "restarting", "complete"];
  const currentIdx = statusOrder.indexOf(progress.status);

  return (
    <div className="mt-3 rounded-lg border border-border bg-background/50 p-3">
      <div className="flex items-center gap-2 mb-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
        <span className="text-xs font-medium text-foreground">Updating...</span>
        <span className="text-[10px] text-muted-foreground ml-auto">
          {Math.round(progress.elapsed / 1000)}s
        </span>
      </div>
      <div className="space-y-1.5">
        {steps.map((step) => {
          const stepStatus = statusOrder.indexOf(step.key);
          const isDone = currentIdx > stepStatus;
          const isActive = progress.status === step.key;
          const isPending = currentIdx < stepStatus;

          return (
            <div
              key={step.key}
              className={`flex items-center gap-2 text-xs transition-colors ${
                isPending ? "text-muted-foreground/50" : "text-foreground"
              }`}
            >
              {isDone ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-green-500" />
              ) : isActive ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
              ) : (
                <step.icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
              )}
              <span className={isDone ? "text-muted-foreground line-through" : ""}>
                {step.label}
              </span>
              {isActive && (
                <span className="text-[10px] text-accent ml-auto">in progress...</span>
              )}
              {isDone && (
                <span className="text-[10px] text-green-500 ml-auto">done</span>
              )}
            </div>
          );
        })}
      </div>
      {progress.status === "failed" && (
        <div className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {progress.message}
        </div>
      )}
    </div>
  );
}
