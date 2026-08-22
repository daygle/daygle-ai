import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Bot, Check, ClipboardList, ChevronDown, ChevronRight, ChevronUp, CircleAlert, Copy, Eye, ExternalLink, FileEdit, Files, Folder, GitBranch, GitCompare, GripVertical, ImagePlus, ListTodo, Loader2, MessageSquarePlus, PanelRightClose, PanelRightOpen, RefreshCw, RotateCcw, Rocket, Search, Send, ShieldCheck, Square, Terminal, Trash2, User, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  DEFAULT_AGENT_URL,
  cancelAgentJob,
  cancelChat,
  createChatSession,
  deleteChatSession,
  getChatSession,
  getAuditLog,
  getChatWorkspace,
  listChatSessions,
  openAgentEvents,
  resolveApproval,
  rollbackChat,
  sendChatMessage,
  updateChatModel,
  verifyChat,
  startAgentJob,
  type AgentEvent,
  type AuditEntry,
  type ChatEvent,
  type ChatImage,
  type ChatSummary,
  type ChatWorkspace,
  type StoredChatMessage,
} from "../lib/agent";
import { useOllama } from "../context/OllamaProvider";
import { listModels } from "../lib/ollama";
import { loadGenOptions, loadModelPreference } from "../lib/genOptions";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Modal } from "../components/ui/modal";
import { LOCAL_OLLAMA_URL } from "../lib/utils";
import { parseDiff } from "../lib/diff";

/** Human-readable "working" label for the running-indicator, per tool. */
function toolStatus(name: string): string {
  switch (name) {
    case "search": return "Searching the code…";
    case "read_file": return "Reading files…";
    case "list_files": return "Exploring the repo…";
    case "write_file": return "Writing changes…";
    case "str_replace": return "Editing a file…";
    case "run_command": return "Running a command…";
    default: return "Working…";
  }
}

interface ChatBubble {
  id: number | string;
  role: "user" | "assistant" | "tool" | "approval" | "clarification" | "qa" | "review";
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolDiff?: string;
  streaming?: boolean;
  // approval bubbles
  requestId?: string;
  command?: string;
  decision?: "approve" | "deny";
  // clarification bubbles
  question?: string;
  options?: Array<{ label: string; description?: string }>;
  selectedOption?: string;
  imageData?: string;
  imageMimeType?: string;
  // qa bubbles
  qaCommand?: string;
  qaOutput?: string;
  qaPassed?: boolean;
  qaSkipped?: boolean;
  // review bubbles
  reviewVerdict?: "approved" | "changes_requested";
  reviewText?: string;
}

let nextId = 0;
function uid() { return ++nextId; }

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function loadPanelWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  } catch {
    return fallback;
  }
}

function savePanelWidth(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Ignore storage errors; resizing still works for this session.
  }
}

function messageTitle(messages: ChatBubble[]): string {
  const userMessage = messages.find((message) => message.role === "user")?.content.trim().replace(/\s+/g, " ");
  if (!userMessage) return "New chat";
  return userMessage.length > 48 ? `${userMessage.slice(0, 48)}…` : userMessage;
}

/**
 * Remove raw tool-call JSON that some models emit as plain text instead of
 * using the structured tool_calls format. The backend still executes these
 * (they show up as tool cards), so they must never leak into the chat bubble.
 * Handles complete objects, multi-line/nested arguments, ```json fences, and
 * a trailing *incomplete* object mid-stream (so partial JSON never flashes).
 */
function stripToolJson(text: string): string {
  return text
    // drop code fences that models wrap tool calls in
    .replace(/```(?:json|tool_code)?/gi, "")
    // drop complete { "name": ..., "arguments": {...} } objects (non-greedy, multi-line)
    .replace(/\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g, "")
    // drop example output objects like { "file": "...", "line": 12 }
    .replace(/\{\s*"file"\s*:\s*"[^"]+"\s*,\s*"line"\s*:\s*\d+\s*\}/g, "")
    // drop bash-style tool calls like: bash list_files("src") or list_files()
    .replace(/(?:bash\s+)?(?:list_files|read_file|search|write_file|str_replace|run_command)\s*\([^)]*\)/gi, "")
    // drop bash cd patterns like: bash cd web vite
    .replace(/(?:bash\s+)?cd\s+\S+\s+.+/gi, "")
    // drop a trailing, not-yet-closed tool-call object still streaming in
    .replace(/\{\s*"name"\s*:[\s\S]*$/g, "")
    .trim();
}

/** Renders a colored +/- unified diff (lines prefixed with " ", "+", "-"). */
function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="max-h-72 overflow-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-relaxed">
      {diff.split("\n").map((line, i) => (
        <div
          key={i}
          className={
            line.startsWith("+")
              ? "text-accent"
              : line.startsWith("-")
                ? "text-destructive/90"
                : "text-muted-foreground"
          }
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

/**
 * GitHub-style "files changed" list: one row per file with +N/−N counts, and
 * an expandable unified diff underneath. Replaces the raw stat line + full
 * diff dump so the change set can be scanned at a glance.
 */
function ChangesView({ diff }: { diff: string }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }

  if (files.length === 0) return <DiffView diff={diff} />;

  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // The row already shows the path, so drop git's per-file preamble lines and
  // show just the hunks (`@@ ... @@` plus +/- context), like GitHub's view.
  const hunks = (content: string) =>
    content
      .split("\n")
      .filter((line) => !line.startsWith("diff --git ") && !line.startsWith("index ") && !line.startsWith("--- ") && !line.startsWith("+++ "))
      .join("\n");

  return (
    <div className="space-y-1">
      <p className="mb-2 text-[11px] text-muted-foreground">
        {files.length} file{files.length === 1 ? "" : "s"} changed
        <span className="text-accent"> · +{additions}</span>
        <span className="text-destructive/90"> · −{deletions}</span>
      </p>
      {files.map((file) => {
        const expanded = open.has(file.path);
        return (
          <div key={file.path} className="overflow-hidden rounded-lg border border-border bg-background">
            <button
              type="button"
              onClick={() => toggle(file.path)}
              className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-muted/50"
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">{file.path}</span>
              <span className="shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums">
                {file.additions > 0 && <span className="text-accent">+{file.additions}</span>}
                {file.additions > 0 && file.deletions > 0 && <span className="text-muted-foreground/40"> </span>}
                {file.deletions > 0 && <span className="text-destructive/90">−{file.deletions}</span>}
                {file.additions === 0 && file.deletions === 0 && <span className="text-muted-foreground">±0</span>}
              </span>
            </button>
            {expanded && <DiffView diff={hunks(file.content)} />}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Only allow genuine image mime types in data: URLs. A user-controlled mime
 * (e.g. `text/html`) would let the data URL carry HTML, and a non-image
 * payload must never be reinterpreted that way.
 */
function imageMime(mime: string | undefined): string {
  return mime && /^image\/[a-z0-9.+-]+$/i.test(mime) ? mime : "image/*";
}

/** Lightweight markdown for assistant messages - headings, lists, code, links. */
function Markdown({ children }: { children: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed [&_a]:text-accent [&_a]:underline [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_p]:my-0 [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ node: _node, className, children, ...props }) {
            const inline = !className;
            return inline ? (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]" {...props}>
                {children}
              </code>
            ) : (
              <code className={`${className ?? ""} font-mono`} {...props}>
                {children}
              </code>
            );
          },
          pre({ children }) {
            return (
              <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-[12px] leading-relaxed">
                {children}
              </pre>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** Rebuilds display bubbles from a stored transcript when resuming a chat. */
function bubblesFromMessages(messages: StoredChatMessage[]): ChatBubble[] {
  const bubbles: ChatBubble[] = [];
  const toolQueue: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const m of messages) {
    if (m.role === "user") {
      bubbles.push({
        id: uid(),
        role: "user",
        content: m.content,
        imageData: m.images?.[0],
        imageMimeType: m.imageMimeTypes?.[0],
      });
    } else if (m.role === "assistant") {
      const text = stripToolJson(m.content);
      if (text) bubbles.push({ id: uid(), role: "assistant", content: text });
      for (const call of m.tool_calls ?? []) {
        toolQueue.push({ name: call.function.name, args: call.function.arguments ?? {} });
      }
    } else if (m.role === "tool") {
      const meta = toolQueue.shift();
      bubbles.push({
        id: uid(),
        role: "tool",
        content: "",
        toolName: m.tool_name ?? meta?.name ?? "tool",
        toolArgs: meta?.args ?? {},
        toolResult: m.content,
      });
    }
    // system messages are internal and not displayed
  }
  return bubbles;
}

function ToolCall({ name, args, result, diff }: { name: string; args: Record<string, unknown>; result?: string; diff?: string }) {
  const [expanded, setExpanded] = useState(false);

  const icon = name === "run_command"
    ? <Terminal className="h-3.5 w-3.5 text-amber-400" />
    : name === "search"
      ? <Search className="h-3.5 w-3.5 text-blue-400" />
      : <FileEdit className="h-3.5 w-3.5 text-emerald-400" />;

  const label = name === "read_file" && args.path ? `Read ${args.path}`
    : name === "list_files" && args.path ? `List ${args.path}`
    : name === "search" && args.pattern ? `Search "${args.pattern}"`
    : name === "write_file" && args.path ? `Write ${args.path}`
    : name === "str_replace" && args.path ? `Edit ${args.path}`
    : name === "run_command" && args.command ? `${args.command}`
    : name;

  const hasDetail = diff !== undefined || result !== undefined;

  return (
    <div className="my-1 rounded-lg border border-border bg-background">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
      >
        {icon}
        <span className="font-medium text-muted-foreground">{label}</span>
        {hasDetail && (
          expanded
            ? <ChevronDown className="ml-auto h-3 w-3 text-muted-foreground" />
            : <ChevronRight className="ml-auto h-3 w-3 text-muted-foreground" />
        )}
      </button>
      {expanded && diff !== undefined && <DiffView diff={diff} />}
      {expanded && diff === undefined && result && (
        <pre className="max-h-60 overflow-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {result}
        </pre>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API may be blocked (non-secure context, permissions, etc.).
      // Fall back to the legacy execCommand approach.
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button
      onClick={handleCopy}
      className="ml-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      title="Copy"
    >
      <Copy className="h-3 w-3" />
      {copied && <span className="ml-1 text-[10px] text-accent">copied</span>}
    </button>
  );
}

/** Result card for the on-demand QA gate (typecheck / test / build). */
function QaCard({ command, output, passed, skipped }: { command: string; output: string; passed: boolean; skipped?: boolean }) {
  const [expanded, setExpanded] = useState(!passed && !skipped);
  const tone = skipped
    ? { border: "border-border", bg: "bg-muted/30", icon: <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />, label: "No checks to run" }
    : passed
      ? { border: "border-emerald-500/40", bg: "bg-emerald-500/5", icon: <Check className="h-3.5 w-3.5 text-emerald-400" />, label: "QA passed" }
      : { border: "border-destructive/40", bg: "bg-destructive/5", icon: <CircleAlert className="h-3.5 w-3.5 text-destructive" />, label: "QA failed" };

  return (
    <div className={`my-1 rounded-lg border ${tone.border} ${tone.bg}`}>
      <button onClick={() => setExpanded((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs">
        {tone.icon}
        <span className="font-medium text-foreground">{tone.label}</span>
        {command && <span className="truncate font-mono text-[11px] text-muted-foreground">{command}</span>}
        {output && (expanded
          ? <ChevronDown className="ml-auto h-3 w-3 text-muted-foreground" />
          : <ChevronRight className="ml-auto h-3 w-3 text-muted-foreground" />)}
      </button>
      {expanded && output && (
        <pre className="max-h-72 overflow-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {output}
        </pre>
      )}
    </div>
  );
}

/** Result card for the second-model AI review of the working diff. */
function ReviewCard({ verdict, text }: { verdict: "approved" | "changes_requested"; text: string }) {
  const approved = verdict === "approved";
  const tone = approved
    ? { border: "border-emerald-500/40", bg: "bg-emerald-500/5", icon: <Check className="h-3.5 w-3.5 text-emerald-400" />, label: "AI review: approved" }
    : { border: "border-amber-500/40", bg: "bg-amber-500/5", icon: <CircleAlert className="h-3.5 w-3.5 text-amber-400" />, label: "AI review: changes requested" };

  return (
    <div className={`my-1 rounded-lg border ${tone.border} ${tone.bg} p-3`}>
      <div className="mb-2 flex items-center gap-2 text-xs">
        {tone.icon}
        <span className="font-medium text-foreground">{tone.label}</span>
      </div>
      <div className="text-xs leading-relaxed text-muted-foreground">
        <Markdown>{text}</Markdown>
      </div>
    </div>
  );
}

type WorkspaceTab = "queue" | "files" | "changes" | "preview" | "terminal" | "audit";

// ── File tree helpers ───────────────────────────────────────────────────────

interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileNode[];
}

/** Build a nested tree from the flat, globally-sorted file list. */
function buildFileTree(files: string[]): FileNode[] {
  const root: FileNode[] = [];
  for (const file of files) {
    const isDir = file.endsWith("/");
    const parts = file.replace(/\/$/, "").split("/");
    let parent = root;
    let currentPath = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const fullPath = isLast && isDir ? `${currentPath}/` : currentPath;
      const nodeIsDir = !isLast || isDir;

      let node = parent.find((n) => n.name === part);
      if (!node) {
        node = { name: part, path: fullPath, isDir: nodeIsDir, children: [] };
        parent.push(node);
      }
      if (nodeIsDir) parent = node.children;
    }
  }
  return root;
}

function FileTreeRow({
  node,
  depth,
  collapsed,
  onToggle,
}: {
  node: FileNode;
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
}) {
  const isCollapsed = node.isDir && collapsed.has(node.path);
  const indent = depth * 12 + 8;

  return (
    <>
      <div
        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        style={{ paddingLeft: `${indent}px` }}
      >
        {node.isDir ? (
          <button
            onClick={() => onToggle(node.path)}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-muted-foreground/20"
            aria-label={isCollapsed ? `Expand ${node.name}` : `Collapse ${node.name}`}
          >
            {isCollapsed ? (
              <ChevronRight className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        {node.isDir ? (
          <Folder className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        ) : (
          <FileEdit className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
        )}
        <span className="truncate font-mono">{node.name}{node.isDir ? "/" : ""}</span>
      </div>
      {node.isDir && !isCollapsed &&
        node.children.map((child) => (
          <FileTreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            collapsed={collapsed}
            onToggle={onToggle}
          />
        ))}
    </>
  );
}

function FileTree({ files }: { files: string[] }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = useRef<FileNode[]>([]);
  tree.current = buildFileTree(files);

  const toggleDir = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  if (tree.current.length === 0) {
    return <div className="py-8 text-center text-xs text-muted-foreground">No files to show yet - try refreshing.</div>;
  }

  return (
    <div>
      {tree.current.map((node) => (
        <FileTreeRow key={node.path} node={node} depth={0} collapsed={collapsed} onToggle={toggleDir} />
      ))}
      {tree.current.length > 600 && (
        <p className="px-2 pt-2 text-[11px] text-muted-foreground">Showing the first 600 files.</p>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

interface QueuedMessage {
  id: number;
  text: string;
  image?: ChatImage;
  imageName?: string;
}

function AuditView({ entries }: { entries: AuditEntry[] }) {
  const [filter, setFilter] = useState("");
  const visible = entries.filter((entry) => !filter.trim() || JSON.stringify(entry).toLowerCase().includes(filter.trim().toLowerCase()));
  if (entries.length === 0) return <div className="py-8 text-center text-xs text-muted-foreground">No audit entries yet.</div>;
  return (
    <div className="space-y-2">
      <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter tool, file, session…" className="font-mono text-[11px]" />
      {visible.slice().reverse().map((entry, index) => (
        <details key={`${entry.timestamp ?? "entry"}-${index}`} className="rounded-lg border border-border bg-background p-2 text-[11px]">
          <summary className="cursor-pointer font-mono text-muted-foreground">
            {entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : ""} {entry.scope ?? ""} {entry.name ?? entry.type ?? "event"}
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-muted-foreground">{JSON.stringify(entry, null, 2)}</pre>
        </details>
      ))}
    </div>
  );
}

function WorkspacePanel({
  tab,
  onTabChange,
  hasRepo,
  queue,
  onRemoveQueueItem,
  onClearQueue,
  onReorderQueue,
  workspace,
  messages,
  onRefresh,
  refreshing,
  auditEntries,
}: {
  auditEntries: AuditEntry[];
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  hasRepo: boolean;
  queue: QueuedMessage[];
  onRemoveQueueItem: (index: number) => void;
  onClearQueue: () => void;
  onReorderQueue: (from: number, to: number) => void;
  workspace: ChatWorkspace;
  messages: ChatBubble[];
  onRefresh: () => void;
  refreshing: boolean;
}) {
  // Files / Changes / Preview / Terminal only make sense with a checkout; a
  // repo-less chat gets just Queue.
  const repoOnly = new Set<WorkspaceTab>(["files", "changes", "preview", "terminal"]);
  const allTabs: Array<{ id: WorkspaceTab; label: string; icon: typeof ListTodo; count?: number }> = [
    { id: "queue", label: "Queue", icon: ListTodo, count: queue.length },
    { id: "files", label: "Files", icon: Files, count: workspace.files.length || undefined },
    { id: "changes", label: "Changes", icon: GitCompare, count: workspace.changedFiles.length || undefined },
    { id: "preview", label: "Preview", icon: Eye },
    { id: "terminal", label: "Terminal", icon: Terminal },
    { id: "audit", label: "Audit", icon: ClipboardList },
  ];
  const tabs = hasRepo ? allTabs : allTabs.filter((item) => !repoOnly.has(item.id));
  // Fall back to Queue if the selected tab isn't available (e.g. repo tabs on a
  // plain chat) so the body never renders a hidden tab's content.
  const activeTab: WorkspaceTab = tabs.some((item) => item.id === tab) ? tab : "queue";
  const terminalEntries = messages.filter((message) => message.role === "tool" && message.toolName === "run_command");
  const showRefresh = activeTab === "files" || activeTab === "changes";
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  return (
    <aside className="flex h-full w-full min-w-0 flex-col border-l border-border bg-card">
      <div role="tablist" className="scrollbar-thin flex overflow-x-auto border-b border-border px-1">
        {tabs.map(({ id, label, icon: Icon, count }) => (
          <button
            key={id}
            role="tab"
            aria-selected={activeTab === id}
            onClick={() => onTabChange(id)}
            className={`flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-3 text-[11px] transition-colors ${
              activeTab === id ? "border-accent bg-muted text-foreground" : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{label}</span>
            {count !== undefined && count > 0 && <span className="rounded-full bg-muted px-1.5 text-[10px]">{count}</span>}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{tabs.find((item) => item.id === activeTab)?.label}</span>
        {showRefresh && (
          <button onClick={onRefresh} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="Refresh from the workspace">
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        )}
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3">
        {activeTab === "queue" && (
          queue.length === 0 ? (
            <div className="flex h-full min-h-40 flex-col items-center justify-center text-center text-xs text-muted-foreground">
              <ListTodo className="mb-2 h-7 w-7 opacity-40" />
              <p>No queued messages</p>
              <p className="mt-1 max-w-[220px] text-[11px] opacity-70">Messages sent while the agent is working will run here in order.</p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{queue.length} message{queue.length === 1 ? "" : "s"} waiting</span>
                <button onClick={onClearQueue} className="text-destructive hover:underline">Clear all</button>
              </div>
              {queue.map((message, index) => {
                const isDragging = dragIndex === index;
                const isDropTarget = dragOverIndex === index && dragIndex !== null && dragIndex !== index;
                return (
                  <div
                    key={message.id}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", String(message.id));
                      setDragIndex(index);
                    }}
                    onDragEnter={() => {
                      if (dragIndex === null || dragIndex === index) return;
                      setDragOverIndex(index);
                    }}
                    onDragOver={(event) => {
                      if (dragIndex === null || dragIndex === index) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (dragIndex === null || dragIndex === index) {
                        setDragIndex(null);
                        setDragOverIndex(null);
                        return;
                      }
                      onReorderQueue(dragIndex, index);
                      setDragIndex(null);
                      setDragOverIndex(null);
                    }}
                    onDragEnd={() => {
                      setDragIndex(null);
                      setDragOverIndex(null);
                    }}
                    className={`group rounded-lg border bg-background p-2.5 transition-colors ${isDropTarget ? "border-accent bg-accent/5" : "border-border"} ${isDragging ? "opacity-50" : ""}`}
                  >
                    <div className="flex items-start gap-2">
                      <button
                        type="button"
                        aria-label="Drag to reorder"
                        className="flex h-5 w-4 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/60 transition-opacity hover:text-foreground active:cursor-grabbing"
                      >
                        <GripVertical className="h-3.5 w-3.5" />
                      </button>
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[10px] text-accent">{index + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className="whitespace-pre-wrap text-xs leading-relaxed">{message.text}</p>
                        {message.image && <p className="mt-1 flex items-center gap-1 text-[10px] text-accent"><ImagePlus className="h-3 w-3" /> {message.imageName || "Image attachment"}</p>}
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          onClick={() => index > 0 && onReorderQueue(index, index - 1)}
                          disabled={index === 0}
                          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
                          title="Move up"
                          aria-label="Move up"
                        >
                          <ChevronUp className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => index < queue.length - 1 && onReorderQueue(index, index + 1)}
                          disabled={index === queue.length - 1}
                          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
                          title="Move down"
                          aria-label="Move down"
                        >
                          <ChevronDown className="h-3 w-3" />
                        </button>
                        <button onClick={() => onRemoveQueueItem(index)} className="rounded p-0.5 text-muted-foreground hover:text-destructive" title="Remove from queue" aria-label="Remove from queue">
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}

        {activeTab === "files" && (
          workspace.files.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              {hasRepo ? "No files to show yet - try refreshing." : "Connect a repository to browse files."}
            </div>
          ) : (
            <FileTree files={workspace.files.slice(0, 600)} />
          )
        )}

        {activeTab === "changes" && (
          workspace.diff ? (
            <ChangesView diff={workspace.diff} />
          ) : <div className="py-8 text-center text-xs text-muted-foreground">No working directory changes.</div>
        )}

        {activeTab === "preview" && (
          <div className="flex h-full min-h-48 flex-col items-center justify-center text-center text-xs text-muted-foreground">
            <Eye className="mb-2 h-7 w-7 opacity-40" />
            <p>Preview</p>
            <p className="mt-1 max-w-[230px] text-[11px] opacity-70">Start the project’s dev server with a tool command, then open its local URL here when preview support is connected.</p>
          </div>
        )}

        {activeTab === "audit" && <AuditView entries={auditEntries} />}

        {activeTab === "terminal" && (
          terminalEntries.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">Command output will appear here.</div>
          ) : (
            <div className="space-y-2">
              {terminalEntries.map((entry) => (
                <div key={entry.id} className="overflow-hidden rounded-lg border border-border bg-background">
                  <div className="flex items-center gap-2 border-b border-border px-2.5 py-2 font-mono text-[11px] text-amber-300">
                    <Terminal className="h-3 w-3" />
                    <span className="truncate">{String(entry.toolArgs?.command ?? "command")}</span>
                  </div>
                  <pre className="max-h-48 overflow-auto px-2.5 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground">{entry.toolResult || "Running…"}</pre>
                </div>
              ))}
            </div>
          )
        )}

      </div>
    </aside>
  );
}

export function AgentPage() {
  const { baseUrl: ollamaUrl } = useOllama();
  // The agent holds GitHub credentials; never let a persisted LAN URL override
  // the loopback-only default.
  const [agentUrl] = useState(DEFAULT_AGENT_URL);

  const [repoUrl, setRepoUrl] = useState("");
  const [sessionRepo, setSessionRepo] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatBubble[]>([]);
  const [input, setInput] = useState("");
  const [imageAttachment, setImageAttachment] = useState<ChatImage | null>(null);
  const [imageAttachmentName, setImageAttachmentName] = useState("");
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [connected, setConnected] = useState(false);
  const [history, setHistory] = useState<ChatSummary[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [workspace, setWorkspace] = useState<ChatWorkspace>({ files: [], changedFiles: [], stat: "", diff: "", checkpoints: [] });
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<string>("");
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("queue");
  // On small screens the chat list and workspace become overlay drawers (closed
  // by default) so the conversation gets the full width; on desktop they stay
  // inline side panels as before.
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  const [workspaceOpen, setWorkspaceOpen] = useState(() => !isMobile);
  const [workspaceWidth, setWorkspaceWidth] = useState(() => loadPanelWidth("daygle.agent.workspaceWidth", 360, 280, 620));
  const [workspaceRefreshing, setWorkspaceRefreshing] = useState(false);
  const [autoSendQueued, setAutoSendQueued] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [confirmDeleteChat, setConfirmDeleteChat] = useState<string | null>(null);
  const [chatsSidebarOpen, setChatsSidebarOpen] = useState(() => !isMobile);
  const [chatsSidebarWidth, setChatsSidebarWidth] = useState(() => loadPanelWidth("daygle.agent.chatsWidth", 256, 220, 420));
  const [verifying, setVerifying] = useState(false);
  const resizeRef = useRef<{ side: "chats" | "workspace"; startX: number; startWidth: number } | null>(null);
  const verifyAbortRef = useRef<(() => void) | undefined>(undefined);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const abortRef = useRef<(() => void) | undefined>(undefined);
  const toolResultsRef = useRef<Map<string, string>>(new Map());
  const busyPollRef = useRef<number | null>(null);

  // Track viewport width so the side panels can switch between inline (desktop)
  // and overlay-drawer (mobile) layouts. Collapse drawers when crossing into
  // mobile so the conversation is never hidden behind a full-width panel.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => {
      const small = mq.matches;
      setIsMobile(small);
      if (small) {
        setChatsSidebarOpen(false);
        setWorkspaceOpen(false);
      }
    };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const onPointerMove = (event: globalThis.PointerEvent) => {
      const resize = resizeRef.current;
      if (!resize) return;
      const delta = resize.side === "chats" ? event.clientX - resize.startX : resize.startX - event.clientX;
      if (resize.side === "chats") {
        const width = Math.min(420, Math.max(220, resize.startWidth + delta));
        setChatsSidebarWidth(width);
        savePanelWidth("daygle.agent.chatsWidth", width);
      } else {
        const width = Math.min(620, Math.max(280, resize.startWidth + delta));
        setWorkspaceWidth(width);
        savePanelWidth("daygle.agent.workspaceWidth", width);
      }
    };
    const stopResize = () => {
      resizeRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResize);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopResize);
      stopResize();
    };
  }, []);

  function startResize(side: "chats" | "workspace", event: ReactPointerEvent) {
    event.preventDefault();
    resizeRef.current = {
      side,
      startX: event.clientX,
      startWidth: side === "chats" ? chatsSidebarWidth : workspaceWidth,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  const refreshWorkspace = useCallback(async () => {
    if (!sessionId) {
      setWorkspace({ files: [], changedFiles: [], stat: "", diff: "", checkpoints: [] });
      setAuditEntries([]);
      return;
    }
    setWorkspaceRefreshing(true);
    try {
      const [nextWorkspace, nextAudit] = await Promise.all([
        getChatWorkspace(agentUrl, sessionId),
        getAuditLog(agentUrl),
      ]);
      setWorkspace(nextWorkspace);
      setAuditEntries(nextAudit);
    } catch {
      // A chat-only session has no workspace; keep the empty state.
    } finally {
      setWorkspaceRefreshing(false);
    }
  }, [agentUrl, sessionId]);

  useEffect(() => {
    const latest = workspace.checkpoints[workspace.checkpoints.length - 1]?.id ?? "";
    if (!selectedCheckpoint || !workspace.checkpoints.some((checkpoint) => checkpoint.id === selectedCheckpoint)) {
      setSelectedCheckpoint(latest);
    }
  }, [selectedCheckpoint, workspace.checkpoints]);

  useEffect(() => {
    if (!sessionId) return;
    void refreshWorkspace();
    // Only poll when the panel is actually open and there's a repo to inspect -
    // a repo-less chat has no workspace, and a closed panel shows nothing.
    if (!workspaceOpen || !sessionRepo) return;
    const timer = window.setInterval(() => void refreshWorkspace(), 4000);
    return () => window.clearInterval(timer);
  }, [refreshWorkspace, sessionId, workspaceOpen, sessionRepo]);

  // Default the workspace panel open for repo sessions (Files/Changes/Terminal
  // are useful) and closed for plain chats (only Queue applies), once per
  // session. Manual toggles and the queue auto-open still take over afterward.
  const panelDefaultedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId || panelDefaultedRef.current === sessionId) return;
    panelDefaultedRef.current = sessionId;
    setWorkspaceOpen(Boolean(sessionRepo) && !isMobile);
  }, [sessionId, sessionRepo, isMobile]);

  // Only auto-scroll when the user is already near the bottom, so scrolling up
  // to read earlier output isn't yanked back down on every streamed token.
  useEffect(() => {
    if (stickToBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  const [searchParams] = useSearchParams();
  const paramModel = searchParams.get("model");

  useEffect(() => {
    listModels(ollamaUrl)
      .then((m) => {
        const names = m.map((model) => model.name);
        setModels(names);
        // Only pick an initial model when the current one is unset/unavailable -
        // never override a selection the user (or a resumed chat) already made,
        // otherwise changing the model just snaps back to the default.
        setModel((current) => {
          if (current && names.includes(current)) return current;
          const preferredModel = loadModelPreference();
          if (paramModel && names.includes(paramModel)) return paramModel;
          if (preferredModel && names.includes(preferredModel)) return preferredModel;
          return names.length > 0 ? names[0] : current;
        });
      })
      .catch(() => {});
  }, [ollamaUrl, paramModel]);

  const refreshHistory = useCallback(() => {
    listChatSessions(agentUrl).then(setHistory).catch(() => {});
  }, [agentUrl]);

  useEffect(() => {
    if (!connected) return;
    const timer = window.setInterval(refreshHistory, 5000);
    return () => window.clearInterval(timer);
  }, [connected, refreshHistory]);

  // Load the conversation list, and auto-resume the last open chat on refresh.
  useEffect(() => {
    refreshHistory();
    let lastId: string | null = null;
    try {
      lastId = localStorage.getItem("daygle.chatSessionId");
    } catch {
      lastId = null;
    }
    if (lastId) void resumeChat(lastId, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function rememberSession(id: string | null) {
    try {
      if (id) localStorage.setItem("daygle.chatSessionId", id);
      else localStorage.removeItem("daygle.chatSessionId");
    } catch {
      // ignore storage errors
    }
  }

  async function handleConnect() {
    if (!model) return;
    const repo = repoUrl.trim();
    setLoading(true);
    try {
      const session = await createChatSession(agentUrl, repo, model, LOCAL_OLLAMA_URL, loadGenOptions());
      setSessionId(session.id);
      setSessionRepo(repo);
      rememberSession(session.id);
      setConnected(true);
      setMessages([
        {
          id: uid(),
          role: "assistant",
          content: repo
            ? `Connected to **${repo}**. I've cloned the repo and I'm ready to help. What would you like me to do?`
            : `Hi - I'm ready to chat. Ask me anything, or connect a repository to have me read and edit code.`,
        },
      ]);
    } catch (err) {
      setMessages([{ id: uid(), role: "assistant", content: `Failed to connect: ${err instanceof Error ? err.message : String(err)}` }]);
      setConnected(true);
    } finally {
      setLoading(false);
    }
  }

  function stopBusyPoll() {
    if (busyPollRef.current !== null) {
      window.clearInterval(busyPollRef.current);
      busyPollRef.current = null;
    }
  }

  // Reconnect to a generation that's still running server-side (e.g. after the
  // user navigated away mid-answer and came back): the live SSE stream is gone,
  // so poll the transcript until the session is no longer busy.
  function startBusyPoll(id: string) {
    stopBusyPoll();
    setStreaming(true);
    setStatusText("Working…");
    busyPollRef.current = window.setInterval(async () => {
      try {
        const chat = await getChatSession(agentUrl, id);
        setMessages(bubblesFromMessages(chat.messages));
        if (!chat.busy) {
          stopBusyPoll();
          setStreaming(false);
          setStatusText("");
          void refreshWorkspace();
        }
      } catch {
        stopBusyPoll();
        setStreaming(false);
        setStatusText("");
      }
    }, 1500);
  }

  async function resumeChat(id: string, opts?: { silent?: boolean }) {
    stopBusyPoll();
    setQueuedMessages([]);
    setAutoSendQueued(false);
    removeImageAttachment();
    setLoading(true);
    try {
      const chat = await getChatSession(agentUrl, id);
      setSessionId(chat.id);
      setSessionRepo(chat.repoUrl ?? "");
      rememberSession(chat.id);
      setRepoUrl(chat.repoUrl ?? "");
      if (chat.model) setModel(chat.model);
      setMessages(bubblesFromMessages(chat.messages));
      setConnected(true);
      // If a reply is still streaming server-side, resume showing progress.
      if (chat.busy) startBusyPoll(chat.id);
    } catch (err) {
      if (!opts?.silent) {
        setMessages([{ id: uid(), role: "assistant", content: `Failed to open chat: ${err instanceof Error ? err.message : String(err)}` }]);
        setConnected(true);
      } else {
        rememberSession(null); // stale id from a pruned chat
      }
    } finally {
      setLoading(false);
    }
  }

  function switchChat(id: string) {
    if (id === sessionId) return;
    abortRef.current?.();
    verifyAbortRef.current?.();
    setStreaming(false);
    setStatusText("");
    if (isMobile) setChatsSidebarOpen(false);
    void resumeChat(id);
  }

  async function handleModelChange(next: string) {
    if (!next || next === model) return;
    setModel(next);
    if (!sessionId) return; // connect screen handles its own picker
    try {
      await updateChatModel(agentUrl, sessionId, next);
      setHistory((prev) =>
        prev.map((chat) => (chat.id === sessionId ? { ...chat, model: next } : chat)),
      );
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: "assistant", content: `Failed to update model: ${err instanceof Error ? err.message : String(err)}` },
      ]);
    }
  }

  function startNewChat() {
    abortRef.current?.();
    verifyAbortRef.current?.();
    stopBusyPoll();
    setConnected(false);
    setSessionId(null);
    setSessionRepo("");
    setMessages([]);
    setInput("");
    removeImageAttachment();
    setQueuedMessages([]);
    setWorkspace({ files: [], changedFiles: [], stat: "", diff: "", checkpoints: [] });
    setStreaming(false);
    rememberSession(null);
    refreshHistory();
  }

  async function removeChat(id: string) {
    // Optimistically drop it so the list updates instantly…
    setHistory((prev) => prev.filter((c) => c.id !== id));
    try {
      await deleteChatSession(agentUrl, id);
    } catch {
      // …and restore it if the delete didn't take.
      refreshHistory();
      return;
    }
    if (id === sessionId) startNewChat();
    else refreshHistory();
  }

  function handleImageSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setMessages((prev) => [...prev, { id: uid(), role: "assistant", content: "Please choose an image file." }]);
      return;
    }
    if (file.size > 6 * 1024 * 1024) {
      setMessages((prev) => [...prev, { id: uid(), role: "assistant", content: "That image is too large. Please choose an image under 6 MB." }]);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) return;
      setImageAttachment({ data: result.slice(comma + 1), mimeType: file.type });
      setImageAttachmentName(file.name);
    };
    reader.readAsDataURL(file);
  }

  function removeImageAttachment() {
    setImageAttachment(null);
    setImageAttachmentName("");
  }

  const handleSend = useCallback(() => {
    if ((!input.trim() && !imageAttachment) || !sessionId) return;

    const userMsg = input.trim() || "Please describe this image.";
    const userImage = imageAttachment;
    const userImageName = imageAttachmentName;
    setInput("");
    removeImageAttachment();
    if (streaming) {
      setQueuedMessages((prev) => [...prev, { id: uid(), text: userMsg, image: userImage ?? undefined, imageName: userImageName || undefined }]);
      setWorkspaceTab("queue");
      setWorkspaceOpen(true);
      return;
    }
    setMessages((prev) => [...prev, {
      id: uid(),
      role: "user",
      content: userMsg,
      imageData: userImage?.data,
      imageMimeType: userImage?.mimeType,
    }]);
    setStreaming(true);
    setStatusText("Thinking…");
    toolResultsRef.current.clear();

    let assistantId = uid();
    let assistantContent = "";
    const pendingTools = new Map<string, { name: string; args: Record<string, unknown>; result?: string }>();

    const cancel = sendChatMessage(agentUrl, sessionId, userMsg, (event: ChatEvent) => {
      switch (event.type) {
        case "status":
          setStatusText(event.message);
          break;

        case "model_delta": {
          assistantContent += event.content;
          const cleaned = stripToolJson(assistantContent);
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            const hasBubble = last?.id === assistantId && last.role === "assistant";
            // Nothing displayable yet (pure tool-call JSON) - don't spawn an empty bubble.
            if (!cleaned) {
              return hasBubble ? [...prev.slice(0, -1), { ...last, content: cleaned, streaming: true }] : prev;
            }
            if (hasBubble) {
              return [...prev.slice(0, -1), { ...last, content: cleaned, streaming: true }];
            }
            return [...prev, { id: assistantId, role: "assistant", content: cleaned, streaming: true }];
          });
          break;
        }

        case "model_done": {
          const finalCleaned = stripToolJson(assistantContent) || event.content.trim();
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            const hasBubble = last?.id === assistantId && last.role === "assistant";
            if (hasBubble) {
              // Drop the bubble entirely if it ended up with no real content.
              if (!finalCleaned) return prev.slice(0, -1);
              return [...prev.slice(0, -1), { ...last, content: finalCleaned, streaming: false }];
            }
            if (finalCleaned) {
              return [...prev, { id: assistantId, role: "assistant", content: finalCleaned, streaming: false }];
            }
            return prev;
          });
          setStreaming(false);
          setStatusText("");
          break;
        }

        case "tool_start": {
          const toolId = `${assistantId}-tool-${event.name}-${Date.now()}`;
          pendingTools.set(toolId, { name: event.name, args: event.args });
          setMessages((prev) => {
            // Freeze any still-streaming assistant bubble before the tool card,
            // and drop it if it only held tool-call JSON (now empty).
            const finalized = prev
              .map((m) => (m.role === "assistant" && m.streaming ? { ...m, streaming: false } : m))
              .filter((m) => !(m.role === "assistant" && !m.content));
            return [...finalized, { id: toolId, role: "tool", content: "", toolName: event.name, toolArgs: event.args }];
          });
          setStatusText(toolStatus(event.name));
          // Subsequent model text belongs to a fresh turn (a new bubble after the tool).
          assistantId = uid();
          assistantContent = "";
          break;
        }

        case "tool_result":
          setMessages((prev) => {
            // Find the last tool message without a result
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].role === "tool" && prev[i].toolName === event.name && !prev[i].toolResult) {
                const updated = [...prev];
                updated[i] = { ...updated[i], toolResult: event.result, toolDiff: event.diff };
                return updated;
              }
            }
            return prev;
          });
          setStatusText("Thinking…");
          break;

        case "approval_requested":
          setMessages((prev) => [
            ...prev,
            { id: `approval-${event.requestId}`, role: "approval", content: "", requestId: event.requestId, command: event.command },
          ]);
          break;

        case "approval_resolved":
          setMessages((prev) =>
            prev.map((m) =>
              m.role === "approval" && m.requestId === event.requestId
                ? { ...m, decision: event.decision }
                : m,
            ),
          );
          break;

        case "clarification_requested":
          setMessages((prev) => [
            ...prev,
            {
              id: `clarification-${event.requestId}`,
              role: "clarification",
              content: "",
              requestId: event.requestId,
              question: event.question,
              options: event.options,
            },
          ]);
          setStreaming(false);
          setStatusText("");
          break;

        case "error":
          setMessages((prev) => [...prev, { id: uid(), role: "assistant", content: `Error: ${event.message}` }]);
          setStreaming(false);
          setStatusText("");
          break;
      }
    }, userImage ?? undefined);

    abortRef.current = cancel;
  }, [imageAttachment, imageAttachmentName, input, sessionId, streaming, agentUrl]);

  // Once the active response finishes, move the next queued message into the
  // composer and submit it through the same normal send path.
  useEffect(() => {
    if (streaming || !sessionId || queuedMessages.length === 0 || autoSendQueued) return;
    const next = queuedMessages[0];
    setInput(next.text);
    setImageAttachment(next.image ?? null);
    setImageAttachmentName(next.imageName ?? "");
    setQueuedMessages((prev) => prev.slice(1));
    setAutoSendQueued(true);
  }, [autoSendQueued, queuedMessages, sessionId, streaming]);

  useEffect(() => {
    if (!autoSendQueued || streaming || !input.trim()) return;
    setAutoSendQueued(false);
    handleSend();
  }, [autoSendQueued, handleSend, input, streaming]);

  function handleStop() {
    // Abort our own stream if we own it, and ask the server to stop the run -
    // the latter also covers a generation we only reconnected to (busy-poll),
    // where we no longer hold the original stream handle.
    abortRef.current?.();
    if (sessionId) void cancelChat(agentUrl, sessionId);
    stopBusyPoll();
    setStreaming(false);
    setStatusText("");
    // Clear the blinking cursor on whatever bubble was mid-stream.
    setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
  }

  // Stop polling on unmount (navigating away) - this only detaches the UI; it
  // never aborts the generation, which keeps running and persisting so it can
  // be picked back up when the chat is reopened.
  useEffect(() => () => stopBusyPoll(), []);

  // On-demand verification of the chat's working tree: runs the QA gate
  // (typecheck / test / build) and a second-model review of the diff, then
  // drops the results into the transcript as qa/review bubbles.
  function handleVerify() {
    if (!sessionId || !sessionRepo || verifying) return;
    setVerifying(true);
    setStatusText("Verifying…");
    setMessages((prev) => [
      ...prev,
      { id: uid(), role: "assistant", content: "Running verification - QA checks and an AI review of the current changes…" },
    ]);
    const finish = () => {
      setVerifying(false);
      setStatusText("");
      void refreshWorkspace();
    };
    const cancel = verifyChat(agentUrl, sessionId, (event: ChatEvent) => {
      switch (event.type) {
        case "status":
          setStatusText(event.message);
          break;
        case "tool_start":
          setMessages((prev) => [
            ...prev,
            { id: uid(), role: "tool", content: "", toolName: event.name, toolArgs: event.args },
          ]);
          break;
        case "tool_result":
          setMessages((prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].role === "tool" && prev[i].toolName === event.name && !prev[i].toolResult) {
                const updated = [...prev];
                updated[i] = { ...updated[i], toolResult: event.result, toolDiff: event.diff };
                return updated;
              }
            }
            return prev;
          });
          break;
        case "qa":
          setMessages((prev) => [
            ...prev,
            { id: uid(), role: "qa", content: "", qaCommand: event.command, qaOutput: event.output, qaPassed: event.passed, qaSkipped: event.skipped },
          ]);
          break;
        case "review":
          setMessages((prev) => [
            ...prev,
            { id: uid(), role: "review", content: "", reviewVerdict: event.verdict, reviewText: event.text },
          ]);
          break;
        case "error":
          setMessages((prev) => [...prev, { id: uid(), role: "assistant", content: `Verification error: ${event.message}` }]);
          break;
        case "verify_done":
          finish();
          break;
      }
    });
    verifyAbortRef.current = () => {
      cancel();
      finish();
    };
  }

  async function handleRollback() {
    if (!sessionId || !sessionRepo || streaming || verifying || !selectedCheckpoint) return;
    if (!window.confirm("Revert the workspace to the selected checkpoint? This discards later edits.")) return;
    try {
      await rollbackChat(agentUrl, sessionId, selectedCheckpoint);
      setMessages((prev) => [...prev, { id: uid(), role: "assistant", content: "Reverted the workspace to the checkpoint from before the latest task." }]);
      await refreshWorkspace();
    } catch (err) {
      setMessages((prev) => [...prev, { id: uid(), role: "assistant", content: `Could not revert the workspace: ${err instanceof Error ? err.message : String(err)}` }]);
    }
  }

  const handleApproval = useCallback(
    (bubble: ChatBubble, decision: "approve" | "deny") => {
      if (!bubble.requestId) return;
      // Optimistically reflect the choice; the server also emits approval_resolved.
      setMessages((prev) => prev.map((m) => (m.id === bubble.id ? { ...m, decision } : m)));
      resolveApproval(agentUrl, bubble.requestId, decision).catch(() => {});
    },
    [agentUrl],
  );

  const handleClarification = useCallback(
    (bubble: ChatBubble, selectedLabel: string) => {
      if (!bubble.requestId) return;
      // Update the bubble to show the selected option
      setMessages((prev) => prev.map((m) => (m.id === bubble.id ? { ...m, selectedOption: selectedLabel } : m)));
      // Send the user's choice as a new message
      setInput(selectedLabel);
      // Trigger send after a brief delay to ensure state updates
      setTimeout(() => {
        const userMsg = selectedLabel;
        if (!sessionId) return;
        setMessages((prev) => [...prev, { id: uid(), role: "user", content: userMsg }]);
        setStreaming(true);
        setStatusText("Thinking…");
        toolResultsRef.current.clear();

        let assistantId = uid();
        let assistantContent = "";

        const cancel = sendChatMessage(agentUrl, sessionId, userMsg, (event: ChatEvent) => {
          switch (event.type) {
            case "status":
              setStatusText(event.message);
              break;
            case "model_delta": {
              assistantContent += event.content;
              const cleaned = stripToolJson(assistantContent);
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                const hasBubble = last?.id === assistantId && last.role === "assistant";
                if (!cleaned) {
                  return hasBubble ? [...prev.slice(0, -1), { ...last, content: cleaned, streaming: true }] : prev;
                }
                if (hasBubble) {
                  return [...prev.slice(0, -1), { ...last, content: cleaned, streaming: true }];
                }
                return [...prev, { id: assistantId, role: "assistant", content: cleaned, streaming: true }];
              });
              break;
            }
            case "model_done": {
              const finalCleaned = stripToolJson(assistantContent) || event.content.trim();
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                const hasBubble = last?.id === assistantId && last.role === "assistant";
                if (hasBubble) {
                  if (!finalCleaned) return prev.slice(0, -1);
                  return [...prev.slice(0, -1), { ...last, content: finalCleaned, streaming: false }];
                }
                if (finalCleaned) {
                  return [...prev, { id: assistantId, role: "assistant", content: finalCleaned, streaming: false }];
                }
                return prev;
              });
              setStreaming(false);
              setStatusText("");
              break;
            }
            case "tool_start": {
              const toolId = `${assistantId}-tool-${event.name}-${Date.now()}`;
              setMessages((prev) => {
                const finalized = prev
                  .map((m) => (m.role === "assistant" && m.streaming ? { ...m, streaming: false } : m))
                  .filter((m) => !(m.role === "assistant" && !m.content));
                return [...finalized, { id: toolId, role: "tool", content: "", toolName: event.name, toolArgs: event.args }];
              });
              setStatusText(toolStatus(event.name));
              assistantId = uid();
              assistantContent = "";
              break;
            }
            case "tool_result":
              setMessages((prev) => {
                for (let i = prev.length - 1; i >= 0; i--) {
                  if (prev[i].role === "tool" && prev[i].toolName === event.name && !prev[i].toolResult) {
                    const updated = [...prev];
                    updated[i] = { ...updated[i], toolResult: event.result, toolDiff: event.diff };
                    return updated;
                  }
                }
                return prev;
              });
              setStatusText("Thinking…");
              break;
            case "clarification_requested":
              setMessages((prev) => [
                ...prev,
                {
                  id: `clarification-${event.requestId}`,
                  role: "clarification",
                  content: "",
                  requestId: event.requestId,
                  question: event.question,
                  options: event.options,
                },
              ]);
              setStreaming(false);
              setStatusText("");
              break;
            case "error":
              setMessages((prev) => [...prev, { id: uid(), role: "assistant", content: `Error: ${event.message}` }]);
              setStreaming(false);
              setStatusText("");
              break;
          }
        });
        abortRef.current = cancel;
      }, 100);
    },
    [agentUrl, sessionId],
  );

  const activeChatTitle = history.find((chat) => chat.id === sessionId)?.title ?? messageTitle(messages);
  const chatItems: ChatSummary[] = sessionId && !history.some((chat) => chat.id === sessionId)
    ? [{
        id: sessionId,
        repoUrl: sessionRepo,
        model,
        title: activeChatTitle,
        messageCount: messages.filter((message) => message.role === "user" || message.role === "assistant").length,
        createdAt: Date.now(),
        lastActivity: Date.now(),
      }, ...history]
    : history;

  // --- Connect screen ---
  if (!connected) {
    const noModels = models.length === 0;
    return (
      <div className="flex min-h-full items-center justify-center py-10">
        <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
          {/* Header */}
          <div className="border-b border-border bg-gradient-to-b from-accent/10 to-transparent px-6 pb-5 pt-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
                <Bot className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-lg font-semibold tracking-tight">Agent</h1>
                <p className="text-xs text-muted-foreground">Powered by your local Ollama models</p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] text-muted-foreground">
                <MessageSquarePlus className="h-3 w-3" /> Chat
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] text-muted-foreground">
                <GitBranch className="h-3 w-3" /> Read &amp; edit a repo
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] text-muted-foreground">
                <Rocket className="h-3 w-3" /> Run a task → PR
              </span>
            </div>
          </div>

          {/* Form */}
          <div className="space-y-4 px-6 py-5">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Repository <span className="font-normal opacity-70">(Optional)</span></label>
              <div className="relative">
                <GitBranch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo"
                  className="pl-9 font-mono"
                  onKeyDown={(e) => e.key === "Enter" && handleConnect()}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">Leave blank to just chat with the model.</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Model</label>
              <div className="flex gap-2">
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={noModels}
                  className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm disabled:opacity-60"
                >
                  {noModels && <option value="">No models found</option>}
                  {models.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <Button onClick={handleConnect} disabled={loading || !model} className="shrink-0">
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : repoUrl.trim() ? <GitBranch className="h-4 w-4" /> : <MessageSquarePlus className="h-4 w-4" />}
                  {loading ? "Starting…" : repoUrl.trim() ? "Connect" : "Start chat"}
                </Button>
              </div>
              {noModels && (
                <p className="text-[11px] text-amber-400/90">
                  No models detected. Pull one on the{" "}
                  <Link to="/models" className="underline">Models</Link> page, or check the server in{" "}
                  <Link to="/settings" className="underline">Settings</Link>.
                </p>
              )}
            </div>
          </div>

          {/* Recent chats */}
          {history.length > 0 && (
            <div className="border-t border-border px-6 py-5">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent chats</p>
              <div className="max-h-72 space-y-1.5 overflow-y-auto">
                {history.map((chat) => (
                  <div
                    key={chat.id}
                    className="group flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2.5 transition-colors hover:border-accent/50"
                  >
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      {chat.repoUrl ? <GitBranch className="h-3.5 w-3.5" /> : <MessageSquarePlus className="h-3.5 w-3.5" />}
                    </div>
                    <button onClick={() => resumeChat(chat.id)} className="min-w-0 flex-1 text-left">
                      <p className="truncate text-sm">{chat.title}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {(chat.repoUrl ? chat.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "") : "Chat")} · {chat.messageCount} msgs · {relativeTime(chat.lastActivity)}
                      </p>
                    </button>
                    {confirmDeleteChat === chat.id ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          onClick={() => { removeChat(chat.id); setConfirmDeleteChat(null); }}
                          className="rounded p-1 text-destructive hover:bg-destructive/10"
                          title="Confirm delete"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setConfirmDeleteChat(null)}
                          className="rounded p-1 text-muted-foreground hover:bg-muted"
                          title="Cancel"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteChat(chat.id)}
                        className="shrink-0 rounded p-1 text-muted-foreground opacity-60 transition hover:bg-muted hover:text-destructive hover:opacity-100"
                        title="Delete chat"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- Chat screen ---
  return (
    <div className="relative flex h-full min-w-0 overflow-hidden">
      {/* Mobile backdrop - closes any open overlay drawer when tapped. */}
      {isMobile && (chatsSidebarOpen || workspaceOpen) && (
        <button
          type="button"
          aria-label="Close panel"
          onClick={() => {
            setChatsSidebarOpen(false);
            setWorkspaceOpen(false);
          }}
          className="absolute inset-0 z-30 bg-black/50"
        />
      )}

      {/* Left: chat list sidebar */}
      {chatsSidebarOpen && (
        <aside
          style={{ width: isMobile ? "min(85vw, 20rem)" : `${chatsSidebarWidth}px` }}
          className={`relative z-40 flex shrink-0 flex-col border-r border-border bg-card/40 ${isMobile ? "absolute inset-y-0 left-0 shadow-2xl" : ""}`}
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
            <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <MessageSquarePlus className="h-3.5 w-3.5" />
              Chats
            </span>
            <div className="flex items-center gap-0.5">
              <button
                onClick={startNewChat}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                title="New chat"
              >
                <MessageSquarePlus className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setChatsSidebarOpen(false)}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Hide chat list"
              >
                <PanelRightClose className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2">
            {chatItems.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">No chats yet. Start one to begin.</p>
            ) : (
              chatItems.map((chat) => {
                const isActive = chat.id === sessionId;
                return (
                  <div
                    key={chat.id}
                    className={`group mb-1 flex items-center gap-2 rounded-md border px-2 py-2 transition-colors ${isActive ? "border-accent/50 bg-accent/10" : "border-transparent hover:bg-muted/60"}`}
                  >
                    <button
                      onClick={() => switchChat(chat.id)}
                      className="flex min-w-0 flex-1 items-start gap-2 text-left"
                    >
                      {chat.repoUrl
                        ? (<GitBranch className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${isActive ? "text-accent" : "text-muted-foreground"}`} />)
                        : (<MessageSquarePlus className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${isActive ? "text-accent" : "text-muted-foreground"}`} />)}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-foreground">{chat.title}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {(chat.repoUrl || "Chat")}{chat.model ? ` · ${chat.model}` : ""} · {relativeTime(chat.lastActivity)}
                        </span>
                      </span>
                      {isActive && <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                    </button>
                    {confirmDeleteChat === chat.id ? (
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          onClick={() => { removeChat(chat.id); setConfirmDeleteChat(null); }}
                          className="rounded p-1 text-destructive hover:bg-destructive/10"
                          title="Confirm delete"
                        >
                          <Check className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => setConfirmDeleteChat(null)}
                          className="rounded p-1 text-muted-foreground hover:bg-muted"
                          title="Cancel"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteChat(chat.id)}
                        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-destructive group-hover:opacity-100"
                        title="Delete chat"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
          {!isMobile && (
            <button
              type="button"
              onPointerDown={(event) => startResize("chats", event)}
              className="absolute right-0 top-0 z-20 flex h-full w-2 translate-x-1/2 cursor-col-resize touch-none items-center justify-center text-muted-foreground/30 hover:text-accent"
              title="Resize chat list"
              aria-label="Resize chat list"
            >
              <GripVertical className="h-5 w-5" />
            </button>
          )}
        </aside>
      )}
      {!chatsSidebarOpen && !isMobile && (
        <button
          onClick={() => setChatsSidebarOpen(true)}
          className="flex w-9 shrink-0 items-center justify-center border-r border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Show chat list"
        >
          <PanelRightOpen className="h-4 w-4 rotate-180" />
        </button>
      )}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2.5 sm:px-4 sm:py-3">
        {isMobile && (
          <button
            onClick={() => setChatsSidebarOpen(true)}
            className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Chats"
            aria-label="Open chats"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
        )}
        <Bot className="h-4 w-4 text-accent" />
        <span className="hidden text-sm font-medium sm:inline">Agent</span>
        <span className="hidden max-w-xs truncate text-xs text-muted-foreground sm:inline">
          {activeChatTitle}
        </span>
        {sessionRepo ? (
          <>
            <GitBranch className="ml-1 hidden h-3 w-3 text-muted-foreground sm:inline" />
            <span className="hidden max-w-xs truncate text-xs text-muted-foreground sm:inline">
              {sessionRepo.replace(/^https?:\/\/(www\.)?github\.com\//, "")}
            </span>
          </>
        ) : (
          <span className="hidden text-xs text-muted-foreground sm:inline">Chat</span>
        )}
        {(streaming || verifying) && (
          <span className="ml-2 flex items-center gap-1.5 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
            <Loader2 className="h-3 w-3 animate-spin" />
            {statusText || "Working…"}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {sessionRepo && workspace.checkpoints.length > 0 && (
            <>
              <select
                value={selectedCheckpoint}
                onChange={(event) => setSelectedCheckpoint(event.target.value)}
                disabled={streaming || verifying}
                className="hidden max-w-32 rounded-md border border-border bg-background px-2 py-1.5 text-[11px] text-muted-foreground sm:block"
                title="Select a checkpoint"
                aria-label="Select a checkpoint"
              >
                {[...workspace.checkpoints].reverse().map((checkpoint, index) => (
                  <option key={checkpoint.id} value={checkpoint.id}>
                    {index === 0 ? "Latest checkpoint" : `Checkpoint ${workspace.checkpoints.length - index}`} ({new Date(checkpoint.createdAt).toLocaleTimeString()})
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRollback}
                disabled={streaming || verifying}
                title="Revert the workspace to the selected checkpoint"
              >
                <RotateCcw className="mr-1 h-3.5 w-3.5" /> <span className="hidden sm:inline">Revert</span>
              </Button>
            </>
          )}
          {sessionRepo && (
            <Button
              variant="outline"
              size="sm"
              onClick={verifying ? () => verifyAbortRef.current?.() : handleVerify}
              disabled={streaming}
              title="Run QA checks and an AI review of the current changes"
            >
              {verifying
                ? (<><Square className="mr-1 h-3.5 w-3.5" /> <span className="hidden sm:inline">Stop</span></>)
                : (<><ShieldCheck className="mr-1 h-3.5 w-3.5" /> <span className="hidden sm:inline">Verify</span></>)}
            </Button>
          )}
          {sessionRepo && (
            <Button variant="outline" size="sm" onClick={() => setTaskOpen(true)} disabled={streaming || verifying}>
              <Rocket className="mr-1 h-3.5 w-3.5" /> <span className="hidden sm:inline">Run task → PR</span>
            </Button>
          )}
          <button
            onClick={() => setWorkspaceOpen((open) => !open)}
            className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title={workspaceOpen ? "Close workspace panel" : "Open workspace panel"}
          >
            {workspaceOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
          </button>
        </div>
        </header>

        <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-3xl space-y-6">
          {messages.map((msg) => (
            <div key={msg.id}>
              {msg.role === "user" && (
                <div className="flex gap-3">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/20 text-accent">
                    <User className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1 pt-0.5">
                    {msg.imageData && (
                      <img
                        src={`data:${imageMime(msg.imageMimeType)};base64,${msg.imageData}`}
                        alt="Uploaded attachment"
                        className="mb-2 max-h-64 max-w-sm rounded-lg border border-border object-contain"
                      />
                    )}
                    <p className="whitespace-pre-wrap text-sm">{msg.content}</p>
                    {msg.content && <CopyButton text={msg.content} />}
                  </div>
                </div>
              )}

              {msg.role === "assistant" && (
                <div className="flex gap-3">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/20 text-accent">
                    <Bot className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <Markdown>{msg.content}</Markdown>
                    {msg.content && !msg.streaming && <CopyButton text={msg.content} />}
                    {msg.streaming && (
                      <span className="ml-1 inline-block h-4 w-1.5 animate-pulse bg-accent align-middle" />
                    )}
                  </div>
                </div>
              )}

              {msg.role === "tool" && msg.toolName && (
                <div className="ml-10">
                  <ToolCall
                    name={msg.toolName}
                    args={msg.toolArgs ?? {}}
                    result={msg.toolResult}
                    diff={msg.toolDiff}
                  />
                </div>
              )}

              {msg.role === "approval" && (
                <div className="ml-10">
                  <div className="my-1 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                    <div className="mb-2 flex items-center gap-2 text-xs">
                      <Terminal className="h-3.5 w-3.5 text-amber-400" />
                      <span className="font-medium text-foreground">Run this command?</span>
                    </div>
                    <pre className="mb-2 overflow-auto rounded bg-background px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                      {msg.command}
                    </pre>
                    {msg.decision === undefined ? (
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => handleApproval(msg, "approve")}>
                          <Check className="mr-1 h-3.5 w-3.5" /> Approve
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => handleApproval(msg, "deny")}>
                          <X className="mr-1 h-3.5 w-3.5" /> Deny
                        </Button>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {msg.decision === "approve" ? "✓ Approved" : "✕ Denied"}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {msg.role === "clarification" && (
                <div className="ml-10">
                  <div className="my-1 rounded-lg border border-blue-500/40 bg-blue-500/5 p-3">
                    <div className="mb-2 flex items-center gap-2 text-xs">
                      <MessageSquarePlus className="h-3.5 w-3.5 text-blue-400" />
                      <span className="font-medium text-foreground">{msg.question}</span>
                    </div>
                    {msg.selectedOption ? (
                      <p className="text-xs text-muted-foreground">
                        ✓ Selected: {msg.selectedOption}
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {msg.options?.map((option) => (
                          <Button
                            key={option.label}
                            size="sm"
                            variant="outline"
                            onClick={() => handleClarification(msg, option.label)}
                            className="text-left"
                          >
                            <span className="font-medium">{option.label}</span>
                            {option.description && (
                              <span className="ml-1 text-muted-foreground">- {option.description}</span>
                            )}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {msg.role === "qa" && (
                <div className="ml-10">
                  <QaCard
                    command={msg.qaCommand ?? ""}
                    output={msg.qaOutput ?? ""}
                    passed={!!msg.qaPassed}
                    skipped={!!msg.qaSkipped}
                  />
                </div>
              )}

              {msg.role === "review" && (
                <div className="ml-10">
                  <ReviewCard verdict={msg.reviewVerdict ?? "changes_requested"} text={msg.reviewText ?? ""} />
                </div>
              )}
            </div>
          ))}

          {(() => {
            // Show a "working" indicator while streaming, except when an assistant
            // bubble is actively typing (its blinking cursor already signals activity).
            const last = messages[messages.length - 1];
            const typing = last?.role === "assistant" && last.streaming;
            if (!streaming || typing) return null;
            return (
              <div className="flex gap-3">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/20 text-accent">
                  <Bot className="h-3.5 w-3.5" />
                </div>
                <div className="flex items-center gap-2 pt-1 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
                  <span className="animate-pulse">{statusText || "Thinking…"}</span>
                </div>
              </div>
            );
          })()}

          <div ref={messagesEndRef} />
        </div>
      </div>

        <div className="sticky bottom-0 z-20 border-t border-border bg-background/95 px-4 py-3 backdrop-blur">
          <div className="mx-auto max-w-3xl space-y-2">
            {imageAttachment && (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-background p-2">
                <img
                  src={`data:${imageMime(imageAttachment.mimeType)};base64,${imageAttachment.data}`}
                  alt="Selected attachment"
                  className="h-12 w-12 rounded object-cover"
                />
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{imageAttachmentName || "Image attachment"}</span>
                <button onClick={removeImageAttachment} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="Remove image">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            <div className="flex gap-2">
              <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageSelected} />
              <Button variant="outline" size="icon" onClick={() => imageInputRef.current?.click()} title="Upload image">
                <ImagePlus className="h-4 w-4" />
              </Button>
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
                placeholder={streaming ? "Type a message to queue…" : "Ask about the code, request changes…"}
                className="flex-1"
              />
              <Button size="icon" onClick={handleSend} disabled={!input.trim() && !imageAttachment} title={streaming ? "Queue message" : "Send message"}>
                <Send className="h-4 w-4" />
              </Button>
              {streaming && (
                <Button variant="destructive" size="icon" onClick={handleStop} title="Stop response">
                  <Square className="h-4 w-4" />
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5">
              <label htmlFor="chat-model-select" className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Model
              </label>
              <select
                id="chat-model-select"
                value={model}
                onChange={(e) => void handleModelChange(e.target.value)}
                disabled={streaming || models.length === 0}
                className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs disabled:opacity-60"
              >
                {models.length === 0 && <option value="">No models detected</option>}
                {models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <span className="text-[10px] text-muted-foreground">
                Per-chat. Default in Settings.
              </span>
            </div>
          </div>
        </div>
      </main>

      {workspaceOpen ? (
        <div
          style={{ width: isMobile ? "min(90vw, 26rem)" : `${workspaceWidth}px` }}
          className={`relative z-40 h-full shrink-0 ${isMobile ? "absolute inset-y-0 right-0 shadow-2xl" : ""}`}
        >
          <WorkspacePanel
          tab={workspaceTab}
          onTabChange={setWorkspaceTab}
          hasRepo={Boolean(sessionRepo)}
          queue={queuedMessages}
          onRemoveQueueItem={(index) => setQueuedMessages((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}
          onClearQueue={() => setQueuedMessages([])}
          onReorderQueue={(from, to) => setQueuedMessages((prev) => {
            if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
            const next = prev.slice();
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            return next;
          })}
          workspace={workspace}
          messages={messages}
          onRefresh={() => void refreshWorkspace()}
          refreshing={workspaceRefreshing}
          auditEntries={auditEntries}
          />
          {!isMobile && (
            <button
              type="button"
              onPointerDown={(event) => startResize("workspace", event)}
              className="absolute left-0 top-0 z-20 flex h-full w-2 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center text-muted-foreground/30 hover:text-accent"
              title="Resize workspace panel"
              aria-label="Resize workspace panel"
            >
              <GripVertical className="h-5 w-5" />
            </button>
          )}
        </div>
      ) : (
        !isMobile && (
          <button
            onClick={() => setWorkspaceOpen(true)}
            className="flex w-9 shrink-0 items-center justify-center border-l border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Open workspace panel"
          >
            <PanelRightOpen className="h-4 w-4" />
          </button>
        )
      )}

      <TaskRunnerModal
        open={taskOpen}
        onClose={() => setTaskOpen(false)}
        agentUrl={agentUrl}
        repoUrl={sessionRepo}
        model={model}
        ollamaUrl={LOCAL_OLLAMA_URL}
      />
    </div>
  );
}

const TASK_PRESETS = [
  "Review the codebase for bugs and fix the most important ones.",
  "Add unit tests for the core modules.",
  "Fix any type errors and failing tests.",
  "Refactor for readability without changing behavior.",
];

interface JobLine {
  id: number;
  kind: AgentEvent["type"];
  text: string;
  ok?: boolean;
  requestId?: string;
  command?: string;
  decision?: "approve" | "deny";
}

/**
 * Kicks off the autonomous agent pipeline (multi-step loop → self-review → QA →
 * commit → open PR) against the connected repo and streams its progress.
 */
function TaskRunnerModal({
  open,
  onClose,
  agentUrl,
  repoUrl,
  model,
  ollamaUrl,
}: {
  open: boolean;
  onClose: () => void;
  agentUrl: string;
  repoUrl: string;
  model: string;
  ollamaUrl: string;
}) {
  const [task, setTask] = useState(TASK_PRESETS[0]);
  const [baseBranch, setBaseBranch] = useState("");
  const [reviewModel, setReviewModel] = useState("");
  const [qaCommand, setQaCommand] = useState("");
  const [agenticReview, setAgenticReview] = useState(true);
  const [generateTests, setGenerateTests] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<JobLine[]>([]);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const closeEventsRef = useRef<(() => void) | undefined>(undefined);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  useEffect(() => () => closeEventsRef.current?.(), []);

  // Fresh form each time the modal opens (unless a run is still in flight).
  useEffect(() => {
    if (open && !running) {
      setLines([]);
      setPrUrl(null);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function push(line: Omit<JobLine, "id">) {
    setLines((prev) => [...prev, { id: uid(), ...line }]);
  }

  async function start() {
    if (!task.trim() || running) return;
    setRunning(true);
    setLines([]);
    setPrUrl(null);
    setError(null);
    try {
      const { id } = await startAgentJob(agentUrl, {
        repoUrl,
        task: task.trim(),
        model,
        baseBranch: baseBranch.trim(),
        ollamaUrl,
        config: {
          reviewModel: reviewModel.trim() || undefined,
          qaCommand: qaCommand.trim() || undefined,
          agenticReview,
          generateTests,
        },
      });
      jobIdRef.current = id;
      closeEventsRef.current = openAgentEvents(agentUrl, id, (event) => {
        switch (event.type) {
          case "status":
            push({ kind: event.type, text: event.message });
            break;
          case "tool_start":
            push({ kind: event.type, text: `${event.name}(${Object.values(event.args).join(", ").slice(0, 80)})` });
            break;
          case "review":
            push({ kind: event.type, text: `Review: ${event.verdict === "approved" ? "approved" : "changes requested"} - ${event.text.slice(0, 200)}`, ok: event.verdict === "approved" });
            break;
          case "qa":
            push({ kind: event.type, text: `QA: ${event.command}${event.skipped ? " (skipped)" : event.passed ? " ✓" : " ✕"}`, ok: event.passed });
            break;
          case "approval_requested":
            push({ kind: event.type, text: "Approval requested", requestId: event.requestId, command: event.command });
            break;
          case "error":
            setError(event.message);
            setRunning(false);
            break;
          case "cancelled":
            push({ kind: event.type, text: event.message });
            setRunning(false);
            break;
          case "done":
            if (event.prUrl) setPrUrl(event.prUrl);
            push({ kind: event.type, text: event.prUrl ? "Done - pull request opened." : (event.summary || "Done."), ok: true });
            setRunning(false);
            break;
          // model / model_delta / tool_result / diff are noisy; the summary lines above suffice
          default:
            break;
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  }

  function cancel() {
    if (jobIdRef.current) cancelAgentJob(agentUrl, jobIdRef.current).catch(() => {});
  }

  function decide(line: JobLine, decision: "approve" | "deny") {
    if (!line.requestId) return;
    setLines((prev) => prev.map((l) => (l.id === line.id ? { ...l, decision } : l)));
    resolveApproval(agentUrl, line.requestId, decision).catch(() => {});
  }

  const started = running || lines.length > 0 || prUrl !== null || error !== null;

  return (
    <Modal open={open} onClose={onClose} title="Run Autonomous Task">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          The agent will work through this task on its own, review its own changes, run your QA
          command, and open a pull request on <span className="font-mono">{repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "")}</span>.
        </p>

        {!started && (
          <>
            <div className="space-y-2">
              <Textarea value={task} onChange={(e) => setTask(e.target.value)} rows={3} placeholder="Describe the task…" />
              <div className="flex flex-wrap gap-1.5">
                {TASK_PRESETS.map((p) => (
                  <button
                    key={p}
                    onClick={() => setTask(p)}
                    className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:border-accent/50 hover:text-foreground"
                  >
                    {p.length > 34 ? `${p.slice(0, 34)}…` : p}
                  </button>
                ))}
              </div>
            </div>

            <button onClick={() => setAdvanced((v) => !v)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              {advanced ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} Advanced Options
            </button>
            {advanced && (
              <div className="space-y-2">
                <Input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="Base branch (default: repo default)" className="font-mono text-xs" />
                <Input value={reviewModel} onChange={(e) => setReviewModel(e.target.value)} placeholder="Review model (default: same model)" className="font-mono text-xs" />
                <Input value={qaCommand} onChange={(e) => setQaCommand(e.target.value)} placeholder="QA command, e.g. npm test" className="font-mono text-xs" />
                <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs">
                  <input
                    type="checkbox"
                    checked={agenticReview}
                    onChange={(e) => setAgenticReview(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 accent-accent"
                  />
                  <span>
                    <span className="flex items-center gap-1.5 font-medium text-foreground">
                      <ShieldCheck className="h-3.5 w-3.5 text-accent" /> Agentic Review
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      The reviewer reads the surrounding code and runs the project’s tests before deciding - slower, but catches issues a diff-only review misses. Enabled by default.
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs">
                  <input
                    type="checkbox"
                    checked={generateTests}
                    onChange={(e) => setGenerateTests(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 accent-accent"
                  />
                  <span>
                    <span className="flex items-center gap-1.5 font-medium text-foreground">
                      <ListTodo className="h-3.5 w-3.5 text-accent" /> Generate Tests
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      After the change, write and run tests covering it (using the project’s existing test framework) before QA and review. Enabled by default; skipped if the repo has no test setup.
                    </span>
                  </span>
                </label>
              </div>
            )}

            <div className="flex justify-end">
              <Button onClick={start} disabled={!task.trim()}>
                <Rocket className="mr-1 h-4 w-4" /> Start task
              </Button>
            </div>
          </>
        )}

        {started && (
          <div className="space-y-3">
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-border bg-background p-3 text-xs">
              {lines.map((line) => (
                <div key={line.id}>
                  {line.kind === "approval_requested" ? (
                    <div className="rounded border border-amber-500/40 bg-amber-500/5 p-2">
                      <p className="mb-1 font-medium text-foreground">Approve command?</p>
                      <pre className="mb-2 overflow-auto rounded bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground">{line.command}</pre>
                      {line.decision ? (
                        <p className="text-muted-foreground">{line.decision === "approve" ? "✓ Approved" : "✕ Denied"}</p>
                      ) : (
                        <div className="flex gap-2">
                          <Button size="sm" onClick={() => decide(line, "approve")}><Check className="mr-1 h-3.5 w-3.5" /> Approve</Button>
                          <Button size="sm" variant="outline" onClick={() => decide(line, "deny")}><X className="mr-1 h-3.5 w-3.5" /> Deny</Button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className={line.ok === true ? "text-accent" : line.ok === false ? "text-destructive/90" : "text-muted-foreground"}>
                      {line.kind === "tool_start" ? "▸ " : ""}{line.text}
                    </p>
                  )}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            {prUrl && (
              <a href={prUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/5 px-3 py-2 text-sm text-accent hover:bg-accent/10">
                <ExternalLink className="h-4 w-4" /> View pull request
              </a>
            )}

            <div className="flex justify-end gap-2">
              {running ? (
                <Button variant="destructive" onClick={cancel}>Stop</Button>
              ) : (
                <Button variant="outline" onClick={onClose}>Close</Button>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
