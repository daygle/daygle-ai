import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  PlugZap,
  RefreshCw,
  Upload,
} from "lucide-react";
import {
  commitWorkspace,
  connectWorkspace,
  openWorkspacePr,
  pullWorkspace,
  pushWorkspace,
  workspaceStatus,
  type WorkspaceStatus,
} from "../lib/agent";
import { parseDiff } from "../lib/diff";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { cn } from "../lib/utils";

export function WorkspacePanel({ serverUrl, refreshKey }: { serverUrl: string; refreshKey: number }) {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [action, setAction] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  const diffFiles = useMemo(() => (status?.diff ? parseDiff(status.diff) : []), [status?.diff]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setStatus(await workspaceStatus(serverUrl));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl, refreshKey]);

  async function handleConnect() {
    if (!repoUrl.trim() || connecting) return;
    setConnecting(true);
    setError(null);
    try {
      const next = await connectWorkspace(serverUrl, repoUrl.trim());
      setStatus(next);
      setRepoUrl("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }

  async function runAction(name: "pull" | "commit" | "push" | "pr") {
    if (action) return;
    if (name === "commit" && !commitMessage.trim()) {
      setError("Enter a commit message first.");
      return;
    }
    setAction(name);
    setError(null);
    setPrUrl(null);
    try {
      if (name === "pull") {
        setStatus(await pullWorkspace(serverUrl));
      } else if (name === "commit") {
        setStatus(await commitWorkspace(serverUrl, commitMessage.trim()));
        setCommitMessage("");
      } else if (name === "push") {
        setStatus(await pushWorkspace(serverUrl));
      } else {
        const result = await openWorkspacePr(serverUrl, commitMessage.trim() || "daygle: workspace changes");
        setPrUrl(result.prUrl);
        setStatus(await workspaceStatus(serverUrl));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAction(null);
    }
  }

  const connected = status?.connected;

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <GitBranch className="h-4 w-4 text-accent" />
          Workspace
        </div>
        <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {error && (
        <p className="mb-3 flex items-start gap-1.5 text-xs text-destructive">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}

      {!connected ? (
        <div>
          <p className="text-xs text-muted-foreground">
            Connect a repository to pull, commit, push, and open PRs from here. Runs the agent server on your machine
            with your <code className="font-mono">gh</code> auth.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input
              value={repoUrl}
              onChange={(event) => setRepoUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleConnect();
              }}
              placeholder="https://github.com/you/your-repo"
              className="font-mono"
            />
            <Button onClick={() => void handleConnect()} disabled={connecting || !repoUrl.trim()} className="shrink-0">
              {connecting ? <Spinner /> : <PlugZap className="h-4 w-4" />}
              Connect
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="font-mono text-foreground/90">{status.repoUrl}</span>
            {status.branch && (
              <span className="inline-flex items-center gap-1 font-mono text-muted-foreground">
                <GitBranch className="h-3 w-3" /> {status.branch}
              </span>
            )}
            <span
              className={
                (status.changedFiles?.length ?? 0) > 0
                  ? "font-medium text-amber-300"
                  : "text-muted-foreground"
              }
            >
              {(status.changedFiles?.length ?? 0) > 0
                ? `${status.changedFiles?.length} changed file(s)`
                : "clean working tree"}
            </span>
          </div>

          {status.lastCommit && (
            <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
              <GitCommitHorizontal className="h-3.5 w-3.5" />
              {status.lastCommit.hash} · {status.lastCommit.message}
            </div>
          )}

          {status.diffStat && status.diffStat.trim() !== "" && (
            <button
              onClick={() => setShowDiff((value) => !value)}
              className="flex items-center gap-1.5 text-xs font-medium text-accent hover:underline"
            >
              <FileDiff className="h-3.5 w-3.5" />
              {showDiff ? "Hide diff" : "Show diff"}
            </button>
          )}

          {showDiff && diffFiles.length > 0 && (
            <div className="space-y-1.5 rounded-lg border border-border bg-[#050507] p-2">
              {diffFiles.map((file) => (
                <details key={file.path} open={diffFiles.length <= 3} className="rounded-lg border border-border bg-background">
                  <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 font-mono text-xs text-foreground/90 hover:text-foreground">
                    <span className="min-w-0 flex-1 truncate">{file.path}</span>
                    <span className="text-accent">+{file.additions}</span>
                    <span className="text-destructive">-{file.deletions}</span>
                  </summary>
                  <pre className="max-h-64 overflow-auto border-t border-border p-3 font-mono text-[11px] leading-relaxed">
                    {file.content.split("\n").map((line, index) => (
                      <div
                        key={index}
                        className={
                          line.startsWith("+") && !line.startsWith("+++")
                            ? "text-accent"
                            : line.startsWith("-") && !line.startsWith("---")
                              ? "text-destructive/90"
                              : "text-muted-foreground"
                        }
                      >
                        {line || " "}
                      </div>
                    ))}
                  </pre>
                </details>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button size="sm" variant="outline" onClick={() => void runAction("pull")} disabled={!!action}>
              {action === "pull" ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />}
              Pull
            </Button>
            <Input
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void runAction("commit");
              }}
              placeholder="Commit message…"
              className="h-8 min-w-52 flex-1 font-mono text-xs"
            />
            <Button size="sm" onClick={() => void runAction("commit")} disabled={!!action || !commitMessage.trim()}>
              {action === "commit" ? <Spinner /> : <GitCommitHorizontal className="h-3.5 w-3.5" />}
              Commit
            </Button>
            <Button size="sm" variant="outline" onClick={() => void runAction("push")} disabled={!!action}>
              {action === "push" ? <Spinner /> : <Upload className="h-3.5 w-3.5" />}
              Push
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void runAction("pr")}
              disabled={!!action || !commitMessage.trim()}
              title="Opens a PR from the current branch"
            >
              {action === "pr" ? <Spinner /> : <GitPullRequest className="h-3.5 w-3.5" />}
              Open PR
            </Button>
          </div>

          {prUrl && (
            <a
              href={prUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-accent underline underline-offset-2"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open pull request
            </a>
          )}

          {action === null && (status.changedFiles?.length ?? 0) === 0 && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5 text-accent" />
              Working tree is clean.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
