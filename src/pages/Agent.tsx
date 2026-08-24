import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Bot, Check, ClipboardList, ChevronDown, ChevronRight, ChevronUp, CircleAlert, Copy, Eye, ExternalLink, FileEdit, Files, Folder, GitBranch, GitCompare, GripVertical, ImagePlus, ListTodo, Loader2, MessageSquarePlus, Pencil, PanelRightClose, PanelRightOpen, Plus, RefreshCw, RotateCcw, Rocket, Search, Send, ShieldCheck, Square, Terminal, Trash2, User, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  DEFAULT_AGENT_URL,
  cancelAgentJob,
  cancelChat,
  createChatSession,
  deleteChatSession,
  renameChatSession,
  listSavedRepos,
  saveRepo,
  deleteSavedRepo,
  listProviderModels,
  type SavedRepo,
  type ProviderConfig,
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
import { useCloudProvider } from "../context/CloudProviderContext";
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
    case "read_headers": return "Checking file headers…";
    case "list_files": return "Exploring the repo…";
    case "write_file": return "Writing changes…";
    case "str_replace": return "Editing a file…";
    case "run_command": return "Running a command…";
    case "create_pr": return "Preparing pull request…";
    default: return "Working…";
  }
}

function progressToolText(name: string, args: Record<string, unknown>): string {
  const target = typeof args.path === "string" ? args.path : "the repository";
  switch (name) {
    case "search": return `Searching ${target}`;
    case "list_files": return `Inspecting ${target}`;
    case "read_file": return `Reading ${target}`;
    case "read_headers": return `Checking ${typeof args.paths === "string" ? args.paths : "file headers"}`;
    case "write_file": return `Preparing changes to ${target}`;
    case "str_replace": return `Finding text in ${target}`;
    case "run_command": return "Running a repository command";
    case "create_pr": return "Preparing the pull request";
    default: return toolStatus(name);
  }
}

/**
 * Frames a raw error string as a warm, reassuring chat message with a concrete
 * next step. Common, recognizable failures get tailored guidance; anything else
 * keeps the original detail so nothing is lost, just softened.
 */
function friendlyChatError(raw: string): string {
  const message = raw.replace(/^Error:\s*/i, "").trim();
  const lower = message.toLowerCase();
  if (/\b429\b|rate limit|too many requests/.test(lower)) {
    return `Looks like the model is a bit busy right now (rate limited). Give it a few seconds and try again — your message is safe.`;
  }
  if (/not found|no such model|unknown model|model .* does not exist/.test(lower)) {
    return `I couldn't find that model. Double-check it's pulled and selected in the model picker below, then try again.`;
  }
  if (/could not reach|econnrefused|failed to fetch|network|unreachable|disconnected/.test(lower)) {
    return `I lost the connection to the model server for a moment. Make sure it's running, then send your message again — I'll pick right back up.`;
  }
  if (/timed out|timeout/.test(lower)) {
    return `That one took too long and timed out. It may just have been a big request — try again, or break it into smaller steps and I'll help.`;
  }
  if (/cancel/.test(lower)) {
    return `No problem — I've stopped there. Send another message whenever you're ready.`;
  }
  // Fallback: keep the technical detail, but lead with a calm, human framing.
  return `Sorry, something went wrong on my end: ${message}\n\nYou can try again, and if it keeps happening, checking the model server (Settings) usually sorts it out.`;
}

function progressStatusText(message: string): string {
  if (/^Thinking/i.test(message)) return "Planning the next step";
  if (/reviewing changes/i.test(message)) return "Reviewing the proposed changes";
  if (/primary model failed/i.test(message)) return "Trying the fallback model";
  return message.replace(/…/g, "").trim() || "Working";
}

interface ProgressEntry {
  id: number;
  text: string;
  state: "active" | "done" | "error";
  toolName?: string;
  toolCallId?: string;
}

function ProgressPanel({
  entries,
  expanded,
  onToggle,
}: {
  entries: ProgressEntry[];
  expanded: boolean;
  onToggle: () => void;
}) {
  if (entries.length === 0) return null;
  let active: ProgressEntry | undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index].state === "active") {
      active = entries[index];
      break;
    }
  }

  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-border bg-card/70">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <span className="text-foreground">Progress</span>
        {!expanded && active && <span className="truncate">{active.text}</span>}
        <span className="ml-auto tabular-nums">{entries.length}</span>
      </button>
      {expanded && (
        <div className="space-y-1 border-t border-border px-3 py-2">
          {entries.map((entry) => (
            <div key={entry.id} className="flex items-center gap-2 text-[11px] text-muted-foreground">
              {entry.state === "active" ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin text-accent" />
              ) : entry.state === "error" ? (
                <CircleAlert className="h-3 w-3 shrink-0 text-destructive" />
              ) : (
                <Check className="h-3 w-3 shrink-0 text-accent" />
              )}
              <span className={entry.state === "active" ? "text-foreground" : ""}>{entry.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface ChatBubble {
  id: number | string;
  role: "user" | "assistant" | "tool" | "approval" | "clarification" | "qa" | "review";
  content: string;
  toolName?: string;
  toolCallId?: string;
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
  const withoutFences = text.replace(/```(?:json|tool_code)?/gi, "");
  let result = "";
  let cursor = 0;
  const toolPrefix = /\{\s*"name"\s*:/g;

  for (;;) {
    toolPrefix.lastIndex = cursor;
    const match = toolPrefix.exec(withoutFences);
    if (!match) {
      result += withoutFences.slice(cursor);
      break;
    }

    const start = match.index;
    result += withoutFences.slice(cursor, start);
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < withoutFences.length; index++) {
      const character = withoutFences[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{") depth++;
      else if (character === "}" && --depth === 0) {
        end = index + 1;
        break;
      }
    }

    // A partial tool object is hidden while it streams; a complete object is
    // removed only when it parses as the tool-call shape we expect.
    if (end < 0) break;
    try {
      const candidate = JSON.parse(withoutFences.slice(start, end)) as { name?: unknown; arguments?: unknown };
      if (typeof candidate.name === "string" && candidate.arguments !== undefined) {
        cursor = end;
        continue;
      }
    } catch {
      // Leave malformed assistant text visible rather than deleting user content.
    }
    cursor = start + 1;
  }

  return result
    .replace(/\{\s*"file"\s*:\s*"[^"]+"\s*,\s*"line"\s*:\s*\d+\s*\}/g, "")
    .replace(/(?:bash\s+)?(?:list_files|read_file|search|write_file|str_replace|run_command)\s*\([^)]*\)/gi, "")
    .replace(/(?:bash\s+)?cd\s+\S+\s+.+/gi, "")
    .trim();
}

/** Renders a colored +/- unified diff with line number gutters (lines prefixed with " ", "+", "-"). */
function DiffView({ diff }: { diff: string }) {
  // Parse hunk headers to show original (left) / new (right) line numbers
  const gutter = useMemo(() => {
    const lines = diff.split("\n");
    let leftLine = 1;
    let rightLine = 1;
    let inHunk = false;
    return lines.map((line) => {
      const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        rightLine = parseInt(hunkMatch[1], 10);
        inHunk = true;
        return { type: "hunk" as const };
      }
      if (!inHunk) return { type: "hunk" as const };
      const prefix = line[0];
      if (prefix === " ") {
        const result = { type: "context" as const, left: leftLine, right: rightLine };
        leftLine++;
        rightLine++;
        return result;
      }
      if (prefix === "-") {
        const result = { type: "removed" as const, left: leftLine, right: null };
        leftLine++;
        return result;
      }
      if (prefix === "+") {
        const result = { type: "added" as const, left: null, right: rightLine };
        rightLine++;
        return result;
      }
      // hunk header lines like @@ or \ No newline at end of file
      return { type: "other" as const };
    });
  }, [diff]);

  return (
    <pre className="max-h-72 overflow-auto border-t border-border font-mono text-[11px] leading-relaxed">
      {diff.split("\n").map((line, i) => {
        const g = gutter[i];
        const isAdd = line.startsWith("+");
        const isDel = line.startsWith("-");
        const textClass = isAdd
          ? "text-accent"
          : isDel
            ? "text-destructive/90"
            : "text-muted-foreground";
        return (
          <div key={i} className="flex">
            <span className="w-16 shrink-0 select-none border-r border-border pr-1.5 text-right text-muted-foreground/50">
              {g?.type === "context" || g?.type === "removed" ? g.left : ""}
              {g?.type === "added" ? g.right : ""}
            </span>
            <span className="w-16 shrink-0 select-none border-r border-border pr-1.5 text-right text-muted-foreground/50">
              {g?.type === "context" || g?.type === "added" ? g.right : ""}
              {g?.type === "removed" ? g.left : ""}
            </span>
            <span className={`flex-1 pl-3 ${textClass}`}>{line || " "}</span>
          </div>
        );
      })}
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
  return mime && /^image\/[a-z0-9.+-]+$/i.test(mime) ? mime : "image/png";
}

/** Lightweight markdown for assistant messages - headings, lists, code, links. */
function Markdown({ children }: { children: string }) {
  const [checked, setChecked] = useState<Set<number>>(() => new Set());

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
          li({ node, children, ...props }) {
            // GFM task list items have dataChecked set by remarkGfm → rehype
            const dataChecked = node?.properties?.dataChecked;
            if (dataChecked !== undefined) {
              // Use a stable index from position info to track local toggle state
              const pos = node ? (node.position?.start.line ?? 0) * 1000 + (node.position?.start.column ?? 0) : 0;
              const isChecked = dataChecked === true || dataChecked === "true" || checked.has(pos);
              return (
                <li
                  className="!ml-4 !list-none flex items-start gap-2 py-0.5"
                  {...props}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    readOnly
                    onClick={(e) => {
                      e.stopPropagation();
                      setChecked((prev) => {
                        const next = new Set(prev);
                        if (next.has(pos)) next.delete(pos); else next.add(pos);
                        return next;
                      });
                    }}
                    className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-border bg-background accent-accent"
                  />
                  <span className="flex-1 leading-relaxed [&_p]:my-0">{children}</span>
                </li>
              );
            }
            return <li {...props}>{children}</li>;
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
  const toolQueue: Array<{ id?: string; name: string; args: Record<string, unknown> }> = [];
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
        toolQueue.push({ id: call.id, name: call.function.name, args: call.function.arguments ?? {} });
      }
    } else if (m.role === "tool") {
      const metaIndex = m.tool_call_id
        ? toolQueue.findIndex((call) => call.id === m.tool_call_id)
        : 0;
      const meta = metaIndex >= 0 ? toolQueue.splice(metaIndex, 1)[0] : toolQueue.shift();
      bubbles.push({
        id: uid(),
        role: "tool",
        content: "",
        toolName: m.tool_name ?? meta?.name ?? "tool",
        toolCallId: m.tool_call_id,
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
    : name === "read_headers" && args.paths ? `Headers ${args.paths}`
    : name === "list_files" && args.path ? `List ${args.path}`
    : name === "search" && args.pattern ? `Search "${args.pattern}"`
    : name === "write_file" && args.path ? `Write ${args.path}`
    : name === "str_replace" && args.path ? `Edit ${args.path}`
    : name === "run_command" && args.command ? `${args.command}`
    : name === "create_pr" && args.title ? `Create PR: ${args.title}`
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
      } else if (nodeIsDir) {
        // A flat listing can contain both `dir` and `dir/file`; preserve the
        // directory shape when the directory marker arrives after a child.
        node.isDir = true;
      }
      if (node.isDir) parent = node.children;
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

function collectDirPaths(nodes: FileNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.isDir) {
      paths.push(node.path);
      paths.push(...collectDirPaths(node.children));
    }
  }
  return paths;
}

function FileTree({ files }: { files: string[] }) {
  const visibleFiles = useMemo(() => files.slice(0, 600), [files]);
  const tree = useMemo(() => buildFileTree(visibleFiles), [visibleFiles]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(collectDirPaths(tree)));

  useEffect(() => {
    const directoryPaths = new Set(collectDirPaths(tree));
    setCollapsed((previous) => {
      const next = new Set([...previous].filter((path) => directoryPaths.has(path)));
      for (const path of directoryPaths) {
        if (!previous.has(path)) next.add(path);
      }
      return next;
    });
  }, [tree]);

  const toggleDir = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  if (tree.length === 0) {
    return <div className="py-8 text-center text-xs text-muted-foreground">No files to show yet - try refreshing.</div>;
  }

  return (
    <div>
      {tree.map((node) => (
        <FileTreeRow key={node.path} node={node} depth={0} collapsed={collapsed} onToggle={toggleDir} />
      ))}
      {files.length > visibleFiles.length && (
        <p className="px-2 pt-2 text-[11px] text-muted-foreground">Showing the first {visibleFiles.length} files.</p>
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
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Collect unique event types for the type filter
  const eventTypes = useMemo(() => {
    const types = new Set<string>();
    for (const entry of entries) {
      if (entry.type) types.add(entry.type);
      if (entry.name) types.add(entry.name);
    }
    return [...types].sort();
  }, [entries]);

  const visible = entries
    .map((entry, originalIndex) => ({ entry, originalIndex }))
    .filter(({ entry }) => {
      // Text filter
      if (filter.trim() && !JSON.stringify(entry).toLowerCase().includes(filter.trim().toLowerCase())) return false;
      // Type filter
      if (typeFilter.length > 0) {
        const entryType = entry.type ?? entry.name ?? "";
        if (!typeFilter.includes(entryType)) return false;
      }
      return true;
    });

  const toggleExpand = (index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  };

  const toggleType = (type: string) => {
    setTypeFilter((prev) => prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]);
  };

  if (entries.length === 0) return <div className="py-8 text-center text-xs text-muted-foreground">No audit entries yet.</div>;
  return (
    <div className="space-y-2">
      <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search audit entries…" className="font-mono text-[11px]" />
      {eventTypes.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {eventTypes.slice(0, 12).map((type) => (
            <button
              key={type}
              onClick={() => toggleType(type)}
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                typeFilter.includes(type) ? "bg-accent/20 text-accent" : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {type}
            </button>
          ))}
        </div>
      )}
      <div className="space-y-1">
        {visible.slice().reverse().map(({ entry, originalIndex }) => {
          const isExpanded = expanded.has(originalIndex);
          const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "";
          const label = entry.name ?? entry.type ?? "event";
          const scope = entry.scope ? entry.scope.replace(/^chat:/, "").slice(0, 12) : "";
          return (
            <button
              key={`${entry.timestamp ?? "entry"}-${originalIndex}`}
              onClick={() => toggleExpand(originalIndex)}
              className="w-full rounded-lg border border-border bg-background p-2 text-left text-[11px] transition-colors hover:bg-muted/50"
            >
              <div className="flex items-center gap-2 font-mono">
                <span className="shrink-0 text-muted-foreground/60">{time}</span>
                <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">{label}</span>
                {scope && <span className="truncate text-muted-foreground/50">{scope}</span>}
                {entry.result && <span className="ml-auto truncate text-muted-foreground/40">{entry.result.slice(0, 60)}</span>}
              </div>
              {isExpanded && (
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-muted-foreground">{JSON.stringify(entry, null, 2)}</pre>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function WorkspacePanel({
  tab,
  onTabChange,
  sidebarExpanded,
  onSidebarExpandedChange,
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
  /** Controlled by the parent so the panel wrapper can shrink when collapsed. */
  sidebarExpanded: boolean;
  onSidebarExpandedChange: (expanded: boolean) => void;
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
  // If the selected tab isn't available (e.g. repo tabs on a plain chat),
  // collapse all sections so nothing is open by default.
  const activeTab: WorkspaceTab = tabs.some((item) => item.id === tab) ? tab : ("" as WorkspaceTab);
  const terminalEntries = messages.filter((message) => message.role === "tool" && message.toolName === "run_command");
  const showRefresh = activeTab === "files" || activeTab === "changes";
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  return (
    <aside className={`flex h-full flex-col border-l border-border bg-card overflow-y-auto ${sidebarExpanded ? "w-full min-w-0" : "w-12 min-w-12"}`}>
      {/* Sidebar toggle button */}
      <button
        onClick={() => onSidebarExpandedChange(!sidebarExpanded)}
        className="flex items-center justify-center border-b border-border py-2 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        title={sidebarExpanded ? "Collapse sidebar" : "Expand sidebar"}
      >
        {sidebarExpanded ? (
          <PanelRightClose className="h-4 w-4" />
        ) : (
          <PanelRightOpen className="h-4 w-4" />
        )}
      </button>

      <div className="flex flex-1 flex-col">
        {tabs.map(({ id, label, icon: Icon, count }, idx) => {
          const isOpen = activeTab === id && sidebarExpanded;
          // In collapsed mode, insert a thin divider between logical groups
          // (after Queue and after Changes) to match the activity-bar style.
          const showDivider = !sidebarExpanded && (idx === 0 || idx === 3);
          return (
            <div key={id} className={showDivider ? "border-t border-border/50" : ""}>
              <button
                onClick={() => {
                  if (sidebarExpanded) {
                    onTabChange(isOpen ? "" as WorkspaceTab : id);
                  } else {
                    onSidebarExpandedChange(true);
                    onTabChange(id);
                  }
                }}
                title={sidebarExpanded ? (isOpen ? undefined : label) : label}
                className={`flex w-full items-center transition-colors ${
                  !sidebarExpanded
                    ? `justify-center py-3 text-muted-foreground hover:bg-muted/50 hover:text-foreground ${isOpen ? "bg-accent/10 text-accent" : ""}`
                    : isOpen
                      ? "gap-2 px-3 py-2.5 text-[11px] font-medium bg-accent/10 text-accent"
                      : "gap-2 px-3 py-2 text-[11px] font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                {!sidebarExpanded ? (
                  <span className="relative">
                    <Icon className="h-[18px] w-[18px]" />
                    {count !== undefined && count > 0 && (
                      <span className="absolute -right-1.5 -top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[8px] font-bold text-accent-foreground">
                        {count > 99 ? "99+" : count}
                      </span>
                    )}
                  </span>
                ) : (
                  <>
                    {isOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                    <Icon className={isOpen ? "h-3.5 w-3.5 shrink-0" : "h-4 w-4"} />
                    <span className="flex-1 text-left">{label}</span>
                    {count !== undefined && count > 0 && <span className="rounded-full bg-muted px-1.5 text-[10px]">{count}</span>}
                    {id === "files" && showRefresh && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); onRefresh(); }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            e.stopPropagation();
                            onRefresh();
                          }
                        }}
                        className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="Refresh"
                        aria-label="Refresh files"
                      >
                        <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
                      </span>
                    )}
                  </>
                )}
              </button>
              {isOpen && (
                <div className="scrollbar-thin max-h-[60vh] overflow-y-auto bg-background/50 p-3">
                  {id === "queue" && (
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
            <FileTree files={workspace.files} />
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
                  <div className="flex items-center gap-2 border-b border-border px-2.5 py-2 font-mono text-[11px] text-amber-700 dark:text-amber-300">
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
              )}
            </div>
          );
        })}
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
  const [sessionRepo, setSessionRepo] = useState("");  const [savedRepos, setSavedRepos] = useState<SavedRepo[]>([]);
  const { kind: providerKind, setKind: setProviderKind, baseUrl: cloudBaseUrl, setBaseUrl: setCloudBaseUrl, apiKey: cloudApiKey, setApiKey: setCloudApiKey } = useCloudProvider();

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
  const [progressEntries, setProgressEntries] = useState<ProgressEntry[]>([]);
  const [progressExpanded, setProgressExpanded] = useState(true);
  const [progressHidden, setProgressHidden] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatSummary[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [workspace, setWorkspace] = useState<ChatWorkspace>({ files: [], changedFiles: [], stat: "", diff: "", checkpoints: [] });
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<string>("");
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("" as WorkspaceTab);
  // On small screens the chat list and workspace become overlay drawers (closed
  // by default) so the conversation gets the full width; on desktop they stay
  // inline side panels as before.
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  const [workspaceOpen, setWorkspaceOpen] = useState(() => !isMobile);
  // Collapsed workspace sidebar (icons only). Lives here, not in WorkspacePanel,
  // so the outer wrapper can shrink to the rail instead of leaving dead space
  // between the collapsed bar and the right edge of the page.
  const [workspaceSidebarExpanded, setWorkspaceSidebarExpanded] = useState(true);
  const [workspaceWidth, setWorkspaceWidth] = useState(() => loadPanelWidth("daygle.agent.workspaceWidth", 360, 280, 620));
  const [workspaceRefreshing, setWorkspaceRefreshing] = useState(false);
  const [autoSendQueued, setAutoSendQueued] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [confirmDeleteChat, setConfirmDeleteChat] = useState<string | null>(null);
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
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
  const busyPollRef = useRef<number | null>(null);
  const busyPollInFlightRef = useRef(false);
  const resumeRequestRef = useRef(0);
  const workspaceRequestRef = useRef(0);
  const streamGenerationRef = useRef(0);
  const modelRequestRef = useRef(0);

  const addProgress = useCallback((text: string, state: ProgressEntry["state"] = "active", toolName?: string, toolCallId?: string) => {
    setProgressEntries((previous) => {
      const last = previous[previous.length - 1];
      if (last?.text === text && last.state === state && last.toolCallId === toolCallId) return previous;
      return [...previous.slice(-7), { id: uid(), text, state, toolName, toolCallId }];
    });
  }, []);

  const finishProgress = useCallback((toolName: string, toolCallId: string | undefined, failed: boolean) => {
    setProgressEntries((previous) => {
      for (let index = previous.length - 1; index >= 0; index--) {
        const entry = previous[index];
        if (entry.state === "active" && (toolCallId ? entry.toolCallId === toolCallId : entry.toolName === toolName)) {
          const updated = [...previous];
          updated[index] = { ...entry, state: failed ? "error" : "done" };
          return updated;
        }
      }
      return previous;
    });
  }, []);

  const finishProgressRun = useCallback(() => {
    setProgressEntries((previous) => previous.map((entry) => entry.state === "active" ? { ...entry, state: "done" } : entry));
  }, []);

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

  // Auto-collapse then auto-hide progress panel when all entries are complete
  useEffect(() => {
    if (progressEntries.length === 0) {
      setProgressHidden(false);
      return;
    }
    const hasActive = progressEntries.some((e) => e.state === "active");
    if (hasActive) {
      setProgressExpanded(true);
      setProgressHidden(false);
      return;
    }
    // All done: collapse immediately, hide after 3 seconds
    setProgressExpanded(false);
    const timer = setTimeout(() => setProgressHidden(true), 3000);
    return () => clearTimeout(timer);
  }, [progressEntries]);

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

  const refreshWorkspace = useCallback(async (requestedSessionId?: string) => {
    const targetSessionId = requestedSessionId ?? sessionId;
    const requestId = ++workspaceRequestRef.current;
    if (!targetSessionId) {
      setWorkspace({ files: [], changedFiles: [], stat: "", diff: "", checkpoints: [] });
      setAuditEntries([]);
      setWorkspaceRefreshing(false);
      return;
    }
    setWorkspaceRefreshing(true);
    try {
      const [nextWorkspace, nextAudit] = await Promise.all([
        getChatWorkspace(agentUrl, targetSessionId),
        getAuditLog(agentUrl, 200, `chat:${targetSessionId}`),
      ]);
      if (requestId !== workspaceRequestRef.current) return;
      setWorkspace(nextWorkspace);
      setAuditEntries(nextAudit);
    } catch {
      // A chat-only session has no workspace; keep the empty state.
    } finally {
      if (requestId === workspaceRequestRef.current) setWorkspaceRefreshing(false);
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
    const requestId = ++modelRequestRef.current;
    setModels([]);
    const applyModels = (names: string[]) => {
      if (requestId !== modelRequestRef.current) return;
      setModels(names);
      setModel((current) => {
        if (current && names.includes(current)) return current;
        const preferredModel = loadModelPreference();
        if (paramModel && names.includes(paramModel)) return paramModel;
        if (preferredModel && names.includes(preferredModel)) return preferredModel;
        return names.length > 0 ? names[0] : "";
      });
    };

    if (providerKind === "openai" && cloudBaseUrl.trim()) {
      listProviderModels(agentUrl, "openai", cloudBaseUrl.trim(), cloudApiKey || undefined)
        .then(applyModels)
        .catch(() => requestId === modelRequestRef.current && setModels([]));
    } else if (providerKind === "ollama") {
      listModels(ollamaUrl)
        .then((items) => applyModels(items.map((item) => item.name)))
        .catch(() => requestId === modelRequestRef.current && setModels([]));
    }
  }, [ollamaUrl, paramModel, providerKind, cloudBaseUrl, cloudApiKey, agentUrl]);

  const refreshHistory = useCallback(() => {
    listChatSessions(agentUrl).then(setHistory).catch(() => {});
  }, [agentUrl]);

  const refreshSavedRepos = useCallback(() => {
    listSavedRepos(agentUrl).then(setSavedRepos).catch(() => {});
  }, [agentUrl]);

  useEffect(() => {
    if (!connected) return;
    const timer = window.setInterval(refreshHistory, 5000);
    return () => window.clearInterval(timer);
  }, [connected, refreshHistory]);

  // Load the conversation list, and auto-resume the last open chat on refresh.
  useEffect(() => {
    refreshHistory();
    refreshSavedRepos();
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

  async function handleSaveRepo() {
    const url = repoUrl.trim();
    if (!url) return;
    try {
      const repos = await saveRepo(agentUrl, url);
      setSavedRepos(repos);
    } catch { /* best effort */ }
  }

  async function handleDeleteSavedRepo(id: string) {
    try {
      const repos = await deleteSavedRepo(agentUrl, id);
      setSavedRepos(repos);
    } catch { /* best effort */ }
  }

  async function handleConnect() {
    if (!model || loading) return;
    const repo = repoUrl.trim();
    setLoading(true);
    setConnectionError(null);
    try {
      if (providerKind === "openai" && !cloudBaseUrl.trim()) {
        throw new Error("Enter an OpenAI-compatible provider URL before connecting.");
      }
      const providerConfig: ProviderConfig | undefined = providerKind === "openai"
        ? { kind: "openai", baseUrl: cloudBaseUrl.trim(), apiKey: cloudApiKey || undefined }
        : undefined;
      const session = await createChatSession(agentUrl, repo, model, LOCAL_OLLAMA_URL, loadGenOptions(), providerConfig);
      setSessionId(session.id);
      setSessionRepo(repo);
      rememberSession(session.id);
      setConnected(true);
      setMessages([
        {
          id: uid(),
          role: "assistant",
          content: repo
            ? `Connected to **${repo}**. I've cloned the repo and I'm ready to help — what would you like to work on?`
            : `Hi — I'm ready to chat. Ask me anything, or connect a repository and I'll read and edit the code with you.`,
        },
      ]);
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : String(err));
      setConnected(false);
      setSessionId(null);
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
    const requestId = resumeRequestRef.current;
    setStreaming(true);
    setStatusText("Working…");
    busyPollRef.current = window.setInterval(async () => {
      if (busyPollInFlightRef.current) return;
      busyPollInFlightRef.current = true;
      try {
        const chat = await getChatSession(agentUrl, id);
        if (requestId !== resumeRequestRef.current) return;
        setMessages(bubblesFromMessages(chat.messages));
        if (!chat.busy) {
          stopBusyPoll();
          setStreaming(false);
          setStatusText("");
          void refreshWorkspace(id);
        }
      } catch {
        if (requestId !== resumeRequestRef.current) return;
        stopBusyPoll();
        setStreaming(false);
        setStatusText("");
      } finally {
        busyPollInFlightRef.current = false;
      }
    }, 1500);
  }

  async function resumeChat(id: string, opts?: { silent?: boolean }) {
    const requestId = ++resumeRequestRef.current;
    stopBusyPoll();
    setQueuedMessages([]);
    setAutoSendQueued(false);
    removeImageAttachment();
    setProgressEntries([]);
    setProgressExpanded(true);
    setProgressHidden(false);
    setLoading(true);
    try {
      const chat = await getChatSession(agentUrl, id);
      if (requestId !== resumeRequestRef.current) return;
      setSessionId(chat.id);
      setConnectionError(null);
      setSessionRepo(chat.repoUrl ?? "");
      rememberSession(chat.id);
      setRepoUrl(chat.repoUrl ?? "");
      if (chat.model) setModel(chat.model);
      setMessages(bubblesFromMessages(chat.messages));
      setConnected(true);
      // If a reply is still streaming server-side, resume showing progress.
      if (chat.busy) startBusyPoll(chat.id);
    } catch (err) {
      if (requestId !== resumeRequestRef.current) return;
      if (!opts?.silent) {
        setMessages([{ id: uid(), role: "assistant", content: `Failed to open chat: ${err instanceof Error ? err.message : String(err)}` }]);
        setConnected(true);
      } else {
        rememberSession(null); // stale id from a pruned chat
      }
    } finally {
      if (requestId === resumeRequestRef.current) setLoading(false);
    }
  }

  function switchChat(id: string) {
    if (id === sessionId) return;
    streamGenerationRef.current++;
    abortRef.current?.();
    abortRef.current = undefined;
    verifyAbortRef.current?.();
    verifyAbortRef.current = undefined;
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
    resumeRequestRef.current++;
    streamGenerationRef.current++;
    abortRef.current?.();
    abortRef.current = undefined;
    verifyAbortRef.current?.();
    verifyAbortRef.current = undefined;
    stopBusyPoll();
    setConnected(false);
    setSessionId(null);
    setSessionRepo("");
    setMessages([]);
    setInput("");
    removeImageAttachment();
    setQueuedMessages([]);
    setWorkspace({ files: [], changedFiles: [], stat: "", diff: "", checkpoints: [] });
    workspaceRequestRef.current++;
    setWorkspaceRefreshing(false);
    setStreaming(false);
    setStatusText("");
    setConnectionError(null);
    setAuditEntries([]);
    setProgressEntries([]);
    setProgressExpanded(true);
    setProgressHidden(false);
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

  async function handleRenameChat(id: string, newTitle: string) {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    // Optimistically update the list
    setHistory((prev) => prev.map((c) => c.id === id ? { ...c, title: trimmed } : c));
    setRenamingChatId(null);
    try {
      await renameChatSession(agentUrl, id, trimmed);
    } catch {
      refreshHistory();
    }
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

  const handleSend = useCallback((messageOverride?: string) => {
    const override = messageOverride?.trim();
    if ((!override && !input.trim() && !imageAttachment) || !sessionId) return;

    const userMsg = override || input.trim() || "Please describe this image.";
    const userImage = override ? undefined : imageAttachment;
    const userImageName = override ? "" : imageAttachmentName;
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
    setProgressEntries([]);
    setProgressExpanded(true);
    addProgress("Preparing the response");
    const streamGeneration = ++streamGenerationRef.current;
    let assistantId = uid();
    let assistantContent = "";
    const cancel = sendChatMessage(agentUrl, sessionId, userMsg, (event: ChatEvent) => {
      if (streamGenerationRef.current !== streamGeneration) return;
      switch (event.type) {
        case "status":
          setStatusText(event.message);
          addProgress(progressStatusText(event.message));
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
          const finalCleaned = stripToolJson(assistantContent) || stripToolJson(event.content);
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
          finishProgressRun();
          addProgress("Response ready", "done");
          break;
        }

        case "tool_start": {
          const toolId = `${assistantId}-tool-${event.toolCallId ?? event.name}-${Date.now()}`;
          setMessages((prev) => {
            // Freeze any still-streaming assistant bubble before the tool card,
            // and drop it if it only held tool-call JSON (now empty).
            const finalized = prev
              .map((m) => (m.role === "assistant" && m.streaming ? { ...m, streaming: false } : m))
              .filter((m) => !(m.role === "assistant" && !m.content));
            return [...finalized, { id: toolId, role: "tool", content: "", toolName: event.name, toolCallId: event.toolCallId, toolArgs: event.args }];
          });
          setStatusText(toolStatus(event.name));
          addProgress(progressToolText(event.name, event.args), "active", event.name, event.toolCallId);
          // Subsequent model text belongs to a fresh turn (a new bubble after the tool).
          assistantId = uid();
          assistantContent = "";
          break;
        }

        case "tool_result":
          setMessages((prev) => {
            // Find the last tool message without a result
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].role === "tool" && prev[i].toolName === event.name && (event.toolCallId ? prev[i].toolCallId === event.toolCallId : true) && !prev[i].toolResult) {
                const updated = [...prev];
                updated[i] = { ...updated[i], toolResult: event.result, toolDiff: event.diff };
                return updated;
              }
            }
            return prev;
          });
          finishProgress(event.name, event.toolCallId, /^Error:/i.test(event.result));
          setStatusText("Thinking…");
          break;

        case "diff_preview":
          setMessages((prev) => {
            // Update the last tool card with the preview diff so the user can see it
            // while deciding on the approval that follows.
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].role === "tool" && prev[i].toolName === event.name && (event.toolCallId ? prev[i].toolCallId === event.toolCallId : true) && !prev[i].toolResult) {
                const updated = [...prev];
                updated[i] = { ...updated[i], toolDiff: event.diff };
                return updated;
              }
            }
            return prev;
          });
          addProgress("Reviewing the proposed changes");
          setStatusText("Reviewing changes…");
          break;

        case "approval_requested":
          setMessages((prev) => [
            ...prev,
            { id: `approval-${event.requestId}`, role: "approval", content: "", requestId: event.requestId, command: event.command },
          ]);
          addProgress("Waiting for your approval");
          break;

        case "approval_resolved":
          setMessages((prev) =>
            prev.map((m) =>
              m.role === "approval" && m.requestId === event.requestId
                ? { ...m, decision: event.decision }
                : m,
            ),
          );
          addProgress(event.decision === "approve" ? "Approval received" : "Approval denied", event.decision === "approve" ? "done" : "error");
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
          finishProgressRun();
          addProgress("Waiting for your answer", "active");
          break;

        case "error":
          setMessages((prev) => [...prev, { id: uid(), role: "assistant", content: friendlyChatError(event.message) }]);
          setStreaming(false);
          setStatusText("");
          finishProgressRun();
          addProgress("The response stopped with an error", "error");
          break;
      }
    }, userImage ?? undefined);

    abortRef.current = cancel;
  }, [addProgress, finishProgress, finishProgressRun, imageAttachment, imageAttachmentName, input, sessionId, streaming, agentUrl]);

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
    if (!autoSendQueued || streaming || (!input.trim() && !imageAttachment)) return;
    setAutoSendQueued(false);
    handleSend();
  }, [autoSendQueued, handleSend, imageAttachment, input, streaming]);

  function handleStop() {
    streamGenerationRef.current++;
    // Abort our own stream if we own it, and ask the server to stop the run -
    // the latter also covers a generation we only reconnected to (busy-poll),
    // where we no longer hold the original stream handle.
    abortRef.current?.();
    if (sessionId) void cancelChat(agentUrl, sessionId);
    stopBusyPoll();
    setStreaming(false);
    setStatusText("");
    finishProgressRun();
    addProgress("Response stopped", "done");
    abortRef.current = undefined;
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
    setProgressEntries([]);
    setProgressExpanded(true);
    addProgress("Preparing verification");
    setMessages((prev) => [
      ...prev,
      { id: uid(), role: "assistant", content: "Running verification - QA checks and an AI review of the current changes…" },
    ]);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      setVerifying(false);
      setStatusText("");
      finishProgressRun();
      addProgress("Verification complete", "done");
      verifyAbortRef.current = undefined;
      void refreshWorkspace();
    };
    const cancel = verifyChat(agentUrl, sessionId, (event: ChatEvent) => {
      switch (event.type) {
        case "status":
          setStatusText(event.message);
          addProgress(progressStatusText(event.message));
          break;
        case "tool_start":
          setMessages((prev) => [
            ...prev,
            { id: uid(), role: "tool", content: "", toolName: event.name, toolCallId: event.toolCallId, toolArgs: event.args },
          ]);
          addProgress(progressToolText(event.name, event.args), "active", event.name, event.toolCallId);
          break;
        case "tool_result":
          setMessages((prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].role === "tool" && prev[i].toolName === event.name && (event.toolCallId ? prev[i].toolCallId === event.toolCallId : true) && !prev[i].toolResult) {
                const updated = [...prev];
                updated[i] = { ...updated[i], toolResult: event.result, toolDiff: event.diff };
                return updated;
              }
            }
            return prev;
          });
          finishProgress(event.name, event.toolCallId, /^Error:/i.test(event.result));
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
          finish();
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
      if (!bubble.requestId || bubble.selectedOption || !sessionId) return;
      setMessages((prev) => prev.map((message) => (
        message.id === bubble.id ? { ...message, selectedOption: selectedLabel } : message
      )));
      // Route the answer through the same stream lifecycle as normal messages.
      // This avoids the old duplicated implementation drifting out of sync.
      handleSend(selectedLabel);
    },
    [handleSend, sessionId],
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
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <GitBranch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    placeholder="https://github.com/owner/repo"
                    className="pl-9 font-mono"
                    onKeyDown={(e) => e.key === "Enter" && handleConnect()}
                  />
                </div>
                {repoUrl.trim() && !savedRepos.some((r) => r.url === repoUrl.trim()) && (
                  <Button variant="outline" size="sm" onClick={handleSaveRepo} className="shrink-0" title="Save this repo">
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
              {savedRepos.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {savedRepos.map((repo) => (
                    <div key={repo.id} className="group flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-[11px]">
                      <button
                        onClick={() => setRepoUrl(repo.url)}
                        className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                        title={repo.url}
                      >
                        <GitBranch className="h-3 w-3" />
                        <span className="max-w-[160px] truncate">{repo.name}</span>
                      </button>
                      <button
                        onClick={() => handleDeleteSavedRepo(repo.id)}
                        className="ml-0.5 rounded-full p-0.5 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-destructive group-hover:opacity-100"
                        title="Remove"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">Leave blank to just chat with the model.</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Provider</label>
              <div className="flex gap-1 rounded-lg border border-border bg-background p-1">
                <button
                  type="button"
                  onClick={() => setProviderKind("ollama")}
                  className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    providerKind === "ollama"
                      ? "bg-accent/15 text-accent"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Local (Ollama)
                </button>
                <button
                  type="button"
                  onClick={() => setProviderKind("openai")}
                  className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    providerKind === "openai"
                      ? "bg-accent/15 text-accent"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Cloud (OpenAI-compatible)
                </button>
              </div>
              {providerKind === "openai" && (
                <div className="space-y-2 pt-1">
                  <div className="relative">
                    <Input
                      value={cloudBaseUrl}
                      onChange={(e) => setCloudBaseUrl(e.target.value)}
                      placeholder="https://api.together.xyz/v1"
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="relative">
                    <Input
                      type="password"
                      value={cloudApiKey}
                      onChange={(e) => setCloudApiKey(e.target.value)}
                      placeholder="API key (optional for some providers)"
                      className="font-mono text-xs"
                    />
                  </div>
                </div>
              )}
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
              {connectionError && (
                <p className="text-[11px] text-destructive" role="alert">{connectionError}</p>
              )}
              {noModels && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400/90">
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
                      <div className="flex shrink-0 items-center gap-1 opacity-60 transition hover:opacity-100">
                        <button
                          onClick={() => { setRenamingChatId(chat.id); setRenameValue(chat.title); }}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                          title="Rename chat"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setConfirmDeleteChat(chat.id)}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                          title="Delete chat"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
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
                    {renamingChatId === chat.id ? (
                      <form
                        onSubmit={(e) => { e.preventDefault(); handleRenameChat(chat.id, renameValue); }}
                        className="flex min-w-0 flex-1 items-center gap-1"
                      >
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => handleRenameChat(chat.id, renameValue)}
                          onKeyDown={(e) => { if (e.key === "Escape") setRenamingChatId(null); }}
                          className="min-w-0 flex-1 rounded bg-background px-1.5 py-0.5 text-xs font-medium text-foreground outline-none ring-1 ring-accent"
                        />
                      </form>
                    ) : (
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
                    )}
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
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                        <button
                          onClick={() => { setRenamingChatId(chat.id); setRenameValue(chat.title); }}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                          title="Rename chat"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => setConfirmDeleteChat(chat.id)}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                          title="Delete chat"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
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
        <span className="hidden rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground sm:inline" title={providerKind === "openai" ? `Cloud: ${cloudBaseUrl || "(no URL set)"}` : "Local Ollama"}>
          {providerKind === "openai" ? "☁ Cloud" : "◉ Local"}
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

          {connected && !streaming && !messages.some((message) => message.role === "user") && (
            <div className="ml-10 space-y-2">
              <p className="text-xs text-muted-foreground">Not sure where to start? Try one of these:</p>
              <div className="flex flex-wrap gap-2">
                {(sessionRepo
                  ? ["Give me a tour of this codebase", "What does this project do?", "Find likely bugs or risky spots", "How do I run the tests?"]
                  : ["Explain a programming concept", "Help me write a function", "Review some code I'll paste", "Help me debug an error"]
                ).map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => handleSend(prompt)}
                    className="rounded-full border border-border bg-card px-3 py-1.5 text-xs text-foreground transition-colors hover:border-accent/50 hover:bg-accent/10"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

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

          {!progressHidden && <ProgressPanel entries={progressEntries} expanded={progressExpanded} onToggle={() => setProgressExpanded((expanded) => !expanded)} />}

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
              <Button size="icon" onClick={() => handleSend()} disabled={!input.trim() && !imageAttachment} title={streaming ? "Queue message" : "Send message"}>
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
          style={{ width: workspaceSidebarExpanded ? (isMobile ? "min(90vw, 26rem)" : `${workspaceWidth}px`) : "48px" }}
          className={`relative z-40 h-full shrink-0 transition-[width] duration-200 ${isMobile ? "absolute inset-y-0 right-0 shadow-2xl" : ""}`}
        >
          <WorkspacePanel
          tab={workspaceTab}
          onTabChange={setWorkspaceTab}
          sidebarExpanded={workspaceSidebarExpanded}
          onSidebarExpandedChange={setWorkspaceSidebarExpanded}
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
