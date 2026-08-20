import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Check, ChevronDown, ChevronRight, Copy, FileEdit, GitBranch, MessageSquarePlus, Search, Send, Square, Terminal, Trash2, User, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  createChatSession,
  deleteChatSession,
  getChatSession,
  listChatSessions,
  resolveApproval,
  sendChatMessage,
  type ChatEvent,
  type ChatSummary,
  type StoredChatMessage,
} from "../lib/agent";
import { useOllama } from "../context/OllamaProvider";
import { listModels } from "../lib/ollama";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

interface ChatBubble {
  id: number | string;
  role: "user" | "assistant" | "tool" | "approval";
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

/** Lightweight markdown for assistant messages — headings, lists, code, links. */
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
      bubbles.push({ id: uid(), role: "user", content: m.content });
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
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="ml-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      title="Copy"
    >
      <Copy className="h-3 w-3" />
      {copied && <span className="ml-1 text-[10px] text-accent">copied</span>}
    </button>
  );
}

export function AgentChatPage() {
  const { baseUrl: ollamaUrl } = useOllama();
  const [agentUrl] = useState(() => {
    try {
      return localStorage.getItem("daygle.agentUrl") ?? "http://localhost:8787";
    } catch {
      return "http://localhost:8787";
    }
  });

  const [repoUrl, setRepoUrl] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatBubble[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const [history, setHistory] = useState<ChatSummary[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const abortRef = useRef<() => void>();
  const toolResultsRef = useRef<Map<string, string>>(new Map());

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

  useEffect(() => {
    listModels(ollamaUrl)
      .then((m) => {
        const names = m.map((model) => model.name);
        setModels(names);
        if (!model && names.length > 0) setModel(names[0]);
      })
      .catch(() => {});
  }, [ollamaUrl, model]);

  const refreshHistory = useCallback(() => {
    listChatSessions(agentUrl).then(setHistory).catch(() => {});
  }, [agentUrl]);

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
    if (!repoUrl.trim()) return;
    setLoading(true);
    try {
      const session = await createChatSession(agentUrl, repoUrl.trim(), model, ollamaUrl);
      setSessionId(session.id);
      rememberSession(session.id);
      setConnected(true);
      setMessages([
        { id: uid(), role: "assistant", content: `Connected to **${repoUrl}**. I've cloned the repo and I'm ready to help. What would you like me to do?` },
      ]);
    } catch (err) {
      setMessages([{ id: uid(), role: "assistant", content: `Failed to connect: ${err instanceof Error ? err.message : String(err)}` }]);
    } finally {
      setLoading(false);
    }
  }

  async function resumeChat(id: string, opts?: { silent?: boolean }) {
    setLoading(true);
    try {
      const chat = await getChatSession(agentUrl, id);
      setSessionId(chat.id);
      rememberSession(chat.id);
      setRepoUrl(chat.repoUrl);
      if (chat.model) setModel(chat.model);
      setMessages(bubblesFromMessages(chat.messages));
      setConnected(true);
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

  function startNewChat() {
    abortRef.current?.();
    setConnected(false);
    setSessionId(null);
    setMessages([]);
    setInput("");
    setStreaming(false);
    rememberSession(null);
    refreshHistory();
  }

  async function removeChat(id: string) {
    try {
      await deleteChatSession(agentUrl, id);
    } catch {
      // ignore
    }
    if (id === sessionId) startNewChat();
    else refreshHistory();
  }

  const handleSend = useCallback(() => {
    if (!input.trim() || !sessionId || streaming) return;

    const userMsg = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { id: uid(), role: "user", content: userMsg }]);
    setStreaming(true);
    toolResultsRef.current.clear();

    let assistantId = uid();
    let assistantContent = "";
    const pendingTools = new Map<string, { name: string; args: Record<string, unknown>; result?: string }>();

    const cancel = sendChatMessage(agentUrl, sessionId, userMsg, (event: ChatEvent) => {
      switch (event.type) {
        case "model_delta": {
          assistantContent += event.content;
          const cleaned = stripToolJson(assistantContent);
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            const hasBubble = last?.id === assistantId && last.role === "assistant";
            // Nothing displayable yet (pure tool-call JSON) — don't spawn an empty bubble.
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

        case "error":
          setMessages((prev) => [...prev, { id: uid(), role: "assistant", content: `Error: ${event.message}` }]);
          setStreaming(false);
          break;
      }
    });

    abortRef.current = cancel;
  }, [input, sessionId, streaming, agentUrl]);

  function handleStop() {
    abortRef.current?.();
    setStreaming(false);
    // Clear the blinking cursor on whatever bubble was mid-stream.
    setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
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

  // --- Connect screen ---
  if (!connected) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="w-full max-w-lg space-y-4 rounded-xl border border-border bg-card p-6">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-accent" />
            <h1 className="text-lg font-semibold">Agent Chat</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Connect to a repository for an interactive coding session with the AI.
          </p>
          <div className="space-y-3">
            <Input
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="font-mono"
              onKeyDown={(e) => e.key === "Enter" && handleConnect()}
            />
            <div className="flex gap-2">
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                {models.length === 0 && <option value="">Loading models…</option>}
                {models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <Button onClick={handleConnect} disabled={loading || !repoUrl.trim()}>
                {loading ? "Connecting…" : "Connect"}
              </Button>
            </div>
          </div>

          {history.length > 0 && (
            <div className="space-y-2 border-t border-border pt-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent chats</p>
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {history.map((chat) => (
                  <div
                    key={chat.id}
                    className="group flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 hover:border-accent/50"
                  >
                    <button onClick={() => resumeChat(chat.id)} className="min-w-0 flex-1 text-left">
                      <p className="truncate text-sm">{chat.title}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {chat.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "")} · {chat.messageCount} msgs · {relativeTime(chat.lastActivity)}
                      </p>
                    </button>
                    <button
                      onClick={() => removeChat(chat.id)}
                      className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-destructive group-hover:opacity-100"
                      title="Delete chat"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
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
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Bot className="h-4 w-4 text-accent" />
        <span className="text-sm font-medium">Agent Chat</span>
        <GitBranch className="ml-1 h-3 w-3 text-muted-foreground" />
        <span className="max-w-md truncate text-xs text-muted-foreground">{repoUrl}</span>
        <Button variant="outline" size="sm" onClick={startNewChat} className="ml-auto" disabled={streaming}>
          <MessageSquarePlus className="mr-1 h-3.5 w-3.5" /> New chat
        </Button>
      </header>

      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-3xl space-y-6">
          {messages.map((msg) => (
            <div key={msg.id}>
              {msg.role === "user" && (
                <div className="flex gap-3">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/20 text-accent">
                    <User className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <p className="whitespace-pre-wrap text-sm">{msg.content}</p>
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
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="border-t border-border px-4 py-3">
        <div className="mx-auto max-w-3xl flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            placeholder={streaming ? "Thinking…" : "Ask about the code, request changes…"}
            disabled={streaming}
            className="flex-1"
          />
          {streaming ? (
            <Button variant="destructive" size="icon" onClick={handleStop}>
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button size="icon" onClick={handleSend} disabled={!input.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
