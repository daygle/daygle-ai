import { useEffect, useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  GitBranch,
  History,
  Play,
  ShieldCheck,
  StopCircle,
  TerminalSquare,
} from "lucide-react";
import { useOllama } from "../context/OllamaProvider";
import {
  agentHealth,
  cancelAgentJob,
  DEFAULT_AGENT_URL,
  getAgentJob,
  listAgentHistory,
  openAgentEvents,
  resolveApproval,
  startAgentJob,
  type AgentEvent,
  type AgentRunSummary,
} from "../lib/agent";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Select } from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";

const STORAGE_KEY = "daygle.agentUrl";

const PRESETS = [
  "Review the codebase for bugs and fix the most important ones.",
  "Add unit tests for the core modules.",
  "Fix any type errors and failing tests.",
  "Refactor for readability without changing behavior.",
];

export function AgentPage() {
  const { models, baseUrl: ollamaUrl } = useOllama();

  const [serverUrl, setServerUrl] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_AGENT_URL;
    } catch {
      return DEFAULT_AGENT_URL;
    }
  });
  const [health, setHealth] = useState<{ ok: boolean; gh: boolean; app: boolean; sandbox: string | null } | null>(null);

  const [repoUrl, setRepoUrl] = useState("");
  const [task, setTask] = useState(PRESETS[0]);
  const [baseBranch, setBaseBranch] = useState("");
  const [model, setModel] = useState("");

  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [history, setHistory] = useState<AgentRunSummary[]>([]);
  const [viewingHistoryId, setViewingHistoryId] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const effectiveModel = model && models.some((m) => m.name === model) ? model : (models[0]?.name ?? "");

  useEffect(() => {
    let cancelled = false;
    agentHealth(serverUrl)
      .then((value) => {
        if (!cancelled) setHealth(value);
      })
      .catch(() => {
        if (!cancelled) setHealth(null);
      });
    return () => {
      cancelled = true;
    };
  }, [serverUrl]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [events]);

  async function refreshHistory() {
    try {
      setHistory(await listAgentHistory(serverUrl));
    } catch {
      // agent server may be offline; keep the existing list
    }
  }

  useEffect(() => {
    void refreshHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl]);

  function persistServerUrl(value: string) {
    setServerUrl(value);
    try {
      localStorage.setItem(STORAGE_KEY, value.trim());
    } catch {
      // ignore
    }
  }

  async function handleStart() {
    if (!repoUrl.trim() || !task.trim() || !effectiveModel || running) return;
    setRunning(true);
    setEvents([]);
    setStartError(null);
    setViewingHistoryId(null);
    try {
      const { id } = await startAgentJob(serverUrl, {
        repoUrl: repoUrl.trim(),
        task: task.trim(),
        model: effectiveModel,
        baseBranch: baseBranch.trim(),
        ollamaUrl,
      });
      setJobId(id);
      openAgentEvents(serverUrl, id, (event) => {
        setEvents((prev) => [...prev, event]);
        if (event.type === "done" || event.type === "error" || event.type === "cancelled") {
          setRunning(false);
          setJobId(null);
          void refreshHistory();
        }
      });
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  }

  async function handleStop() {
    if (!jobId) return;
    try {
      await cancelAgentJob(serverUrl, jobId);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleViewRun(id: string) {
    if (id === viewingHistoryId) return;
    setViewingHistoryId(id);
    setEvents([]);
    try {
      const job = await getAgentJob(serverUrl, id);
      setEvents(job.events ?? []);
      setRunning(false);
      setJobId(null);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Bot className="h-5 w-5 text-accent" />
          Agent
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Point it at a GitHub repo, describe the job, and daygle scans, edits, and opens a pull request.
        </p>
      </header>

      {/* Server status */}
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-sm">
            <span
              className={
                health === null ? "h-2 w-2 rounded-full bg-destructive" : "h-2 w-2 rounded-full bg-accent"
              }
            />
            <span className="font-medium">
              {health === null ? "Agent server not running" : "Agent server running"}
            </span>
            {health !== null && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                {health.app ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-accent" /> GitHub App (repo-scoped token)
                  </>
                ) : health.gh ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-accent" /> GitHub CLI authenticated
                  </>
                ) : (
                  <>
                    <CircleAlert className="h-3.5 w-3.5 text-amber-400" /> run{" "}
                    <code className="font-mono">gh auth login</code> or configure a GitHub App
                  </>
                )}
              </span>
            )}
            {health !== null && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                {health.sandbox ? (
                  <>
                    <ShieldCheck className="h-3.5 w-3.5 text-accent" /> sandbox: {health.sandbox}
                  </>
                ) : (
                  <>
                    <CircleAlert className="h-3.5 w-3.5 text-amber-400" /> no container sandbox
                  </>
                )}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={serverUrl}
              onChange={(event) => persistServerUrl(event.target.value)}
              className="h-8 w-56 font-mono text-xs"
              placeholder="http://localhost:8787"
              aria-label="Agent server URL"
            />
          </div>
        </div>
        {health === null && (
          <p className="mt-3 text-xs text-muted-foreground">
            Start it in a terminal with <code className="font-mono text-accent">bun run agent</code>, then it will
            appear here.
          </p>
        )}
      </section>

      {/* Job form */}
      <section className="space-y-4 rounded-xl border border-border bg-card p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="repo-url" className="text-xs font-medium text-muted-foreground">
              Repository URL
            </label>
            <Input
              id="repo-url"
              value={repoUrl}
              onChange={(event) => setRepoUrl(event.target.value)}
              placeholder="https://github.com/you/your-repo"
              className="mt-1.5 font-mono"
            />
          </div>

          <div>
            <label htmlFor="model" className="text-xs font-medium text-muted-foreground">
              Model
            </label>
            <Select
              id="model"
              value={effectiveModel}
              onChange={(event) => setModel(event.target.value)}
              className="mt-1.5"
            >
              {models.length === 0 && <option value="">No models — pull one first</option>}
              {models.map((m) => (
                <option key={m.digest} value={m.name}>
                  {m.name}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label htmlFor="base-branch" className="text-xs font-medium text-muted-foreground">
              Base branch <span className="text-muted-foreground/60">(optional)</span>
            </label>
            <Input
              id="base-branch"
              value={baseBranch}
              onChange={(event) => setBaseBranch(event.target.value)}
              placeholder="auto-detect (usually main)"
              className="mt-1.5 font-mono"
            />
          </div>

          <div className="sm:col-span-2">
            <label htmlFor="task" className="text-xs font-medium text-muted-foreground">
              Task
            </label>
            <Textarea
              id="task"
              value={task}
              onChange={(event) => setTask(event.target.value)}
              className="mt-1.5"
              rows={3}
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {PRESETS.map((preset) => (
                <button
                  key={preset}
                  onClick={() => setTask(preset)}
                  className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-accent/50 hover:text-foreground"
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={handleStart} disabled={running || !repoUrl.trim() || !task.trim() || !effectiveModel}>
            {running ? <Spinner /> : <Play className="h-4 w-4" />}
            {running ? "Running…" : "Run agent"}
          </Button>
          {running && (
            <Button variant="outline" onClick={() => void handleStop()}>
              <StopCircle className="h-4 w-4" />
              Stop
            </Button>
          )}
        </div>

        {startError && <p className="text-xs text-destructive">{startError}</p>}
      </section>

      {/* History */}
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <History className="h-4 w-4 text-accent" />
            Run history
          </div>
          <Button size="sm" variant="ghost" onClick={() => void refreshHistory()}>
            Refresh
          </Button>
        </div>
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No runs yet. History is stored in <code className="font-mono">~/.daygle/history</code>.
          </p>
        ) : (
          <div className="space-y-1.5">
            {history.map((run) => (
              <button
                key={run.id}
                onClick={() => void handleViewRun(run.id)}
                className={`flex w-full items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2 text-left text-sm transition-colors hover:border-accent/40 ${
                  run.id === viewingHistoryId ? "border-accent/50" : ""
                }`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${statusColor(run.status)}`} />
                <span className="min-w-0 flex-1 truncate text-foreground/90">{run.task}</span>
                <span className="hidden font-mono text-xs text-muted-foreground sm:inline">{run.model}</span>
                <span className="hidden text-xs text-muted-foreground md:inline">
                  {formatTime(run.createdAt)}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Log */}
      {events.length > 0 && (
        <section>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <TerminalSquare className="h-4 w-4 text-accent" />
            {viewingHistoryId ? "Saved run" : "Run log"}
          </div>
          <div
            ref={logRef}
            className="max-h-[28rem] space-y-2 overflow-y-auto rounded-xl border border-border bg-[#050507] p-4 scrollbar-thin"
          >
            {events.map((event, index) => (
              <EventLine
                key={index}
                event={event}
                serverUrl={serverUrl}
                interactive={viewingHistoryId === null}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function statusColor(status: AgentRunSummary["status"]): string {
  switch (status) {
    case "done":
      return "bg-accent";
    case "running":
      return "bg-sky-400";
    case "error":
      return "bg-destructive";
    case "cancelled":
      return "bg-amber-400";
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

function EventLine({
  event,
  serverUrl,
  interactive = true,
}: {
  event: AgentEvent;
  serverUrl: string;
  interactive?: boolean;
}) {
  switch (event.type) {
    case "status":
      return <div className="py-0.5 font-mono text-xs text-muted-foreground">· {event.message}</div>;
    case "model":
      return (
        <div className="whitespace-pre-wrap rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm leading-relaxed text-foreground/90">
          {event.content}
        </div>
      );
    case "tool_start": {
      const args = JSON.stringify(event.args);
      return (
        <div className="py-0.5 font-mono text-xs text-accent">
          ▸ {event.name}({args === "{}" ? "" : args})
        </div>
      );
    }
    case "tool_result":
      return (
        <details className="py-0.5">
          <summary className="cursor-pointer font-mono text-xs text-muted-foreground hover:text-foreground">
            ↩ {event.name} · {event.result.split("\n")[0]?.slice(0, 80) ?? ""}
          </summary>
          <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-background p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {event.result}
          </pre>
        </details>
      );
    case "approval_requested":
      return interactive ? (
        <ApprovalCard serverUrl={serverUrl} requestId={event.requestId} command={event.command} />
      ) : (
        <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 p-2.5">
          <div className="text-xs font-semibold text-amber-300">⚠ Command needed approval</div>
          <pre className="mt-1.5 overflow-x-auto rounded-md border border-border bg-background p-2.5 font-mono text-[11px] text-foreground">
            {event.command}
          </pre>
        </div>
      );
    case "cancelled":
      return (
        <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-300">
          ⏹ {event.message}
        </div>
      );
    case "error":
      return <div className="py-1 text-sm text-destructive">✗ {event.message}</div>;
    case "done":
      return (
        <div className="rounded-lg border border-accent/30 bg-accent/10 p-3">
          <div className="flex items-center gap-1.5 text-sm font-medium text-accent">
            <CheckCircle2 className="h-4 w-4" />
            Done{event.branch ? (
              <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
                <GitBranch className="h-3 w-3" /> {event.branch}
              </span>
            ) : null}
          </div>
          {event.changedFiles && event.changedFiles.length > 0 && (
            <div className="mt-1 text-xs text-muted-foreground">
              {event.changedFiles.length} file(s) changed{event.prUrl ? "" : " — no pull request opened"}
            </div>
          )}
          {event.prUrl && (
            <a
              href={event.prUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-accent underline underline-offset-2"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open pull request
            </a>
          )}
          {event.summary && (
            <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/90">{event.summary}</p>
          )}
        </div>
      );
  }
}

function ApprovalCard({
  serverUrl,
  requestId,
  command,
}: {
  serverUrl: string;
  requestId: string;
  command: string;
}) {
  const [state, setState] = useState<"pending" | "resolving" | "approved" | "denied">("pending");

  async function decide(decision: "approve" | "deny") {
    setState("resolving");
    try {
      await resolveApproval(serverUrl, requestId, decision);
      setState(decision === "approve" ? "approved" : "denied");
    } catch {
      setState("pending");
    }
  }

  return (
    <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 p-3">
      <div className="text-xs font-semibold text-amber-300">⚠ Command needs your approval</div>
      <pre className="mt-1.5 overflow-x-auto rounded-md border border-border bg-background p-2.5 font-mono text-[11px] text-foreground">
        {command}
      </pre>
      <div className="mt-2.5 flex items-center gap-2">
        {state === "pending" && (
          <>
            <Button size="sm" onClick={() => decide("approve")}>
              Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => decide("deny")}>
              Deny
            </Button>
          </>
        )}
        {state === "resolving" && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner /> resolving…
          </span>
        )}
        {state === "approved" && <span className="text-xs font-medium text-accent">✓ Approved</span>}
        {state === "denied" && <span className="text-xs font-medium text-destructive">✗ Denied</span>}
      </div>
    </div>
  );
}
