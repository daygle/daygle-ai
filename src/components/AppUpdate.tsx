import { useState, useEffect } from "react";
import { Download, Check, Loader2, ExternalLink, RefreshCw } from "lucide-react";
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

      // Poll for progress updates
      const pollInterval = setInterval(async () => {
        try {
          const statusRes = await fetch(`${serverUrl.replace(/\/$/, '')}/api/app-update/status`);
          if (statusRes.ok) {
            const statusData = await statusRes.json() as { progress?: AppUpdateProgress | null; updateAvailable?: boolean };

            if (statusData.progress) {
              setProgress(statusData.progress);

              if (statusData.progress.status === "complete") {
                clearInterval(pollInterval);
                setUpdateMessage("Update complete! Server is restarting...");
                // Start polling for server to come back up
                const reconnectInterval = setInterval(async () => {
                  try {
                    await fetch(`${serverUrl.replace(/\/$/, '')}/api/health`);
                    // Server is back up, reload the page
                    clearInterval(reconnectInterval);
                    window.location.reload();
                  } catch {
                    // Server still restarting, keep waiting
                  }
                }, 1000);
                // Stop trying after 30 seconds
                setTimeout(() => clearInterval(reconnectInterval), 30000);
              } else if (statusData.progress.status === "failed") {
                clearInterval(pollInterval);
                setError(statusData.progress.message);
                setUpdating(false);
                setProgress(null);
              }
            } else if (!statusData.updateAvailable) {
              // No progress and no update available means we're already up to date
              clearInterval(pollInterval);
              setUpdateMessage("Update complete! Refresh the page to use the new version.");
              setUpdating(false);
              setProgress(null);
            }
          }
        } catch {
          // Server is likely restarting, keep polling
        }
      }, 2000); // Poll every 2 seconds for better responsiveness

      // Stop polling after 10 minutes
      setTimeout(() => {
        clearInterval(pollInterval);
        if (updating) {
          setProgress(null);
        }
      }, 10 * 60 * 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start update");
      setUpdating(false);
    }
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

          {/* Progress indicator */}
          {updating && progress && (
            <div className="mt-3 p-3 bg-muted/50 rounded-md">
              <div className="flex items-center gap-2 text-sm mb-2">
                <Loader2 className="h-4 w-4 animate-spin text-accent" />
                <span className="font-medium text-foreground">
                  {progress.status === "restarting" ? "Restarting..." : "Updating..."}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {progress.message}
              </div>
              <div className="mt-2 h-1.5 bg-background rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent transition-all duration-500"
                  style={{
                    width: progress.status === "pulling" ? "25%" :
                           progress.status === "installing" ? "50%" :
                           progress.status === "building" ? "75%" : "100%"
                  }}
                />
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">
                {Math.round(progress.elapsed / 1000)}s elapsed
              </div>
            </div>
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
