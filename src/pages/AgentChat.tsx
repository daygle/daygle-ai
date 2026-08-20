import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, ChevronDown, ChevronRight, Copy, FileEdit, GitBranch, Loader2, Search, Send, Square, Terminal, User } from "lucide-react";
import {
  createChatSession,
  sendChatMessage,
  type ChatEvent,
} from "../lib/agent";
import { useOllama } from "../context/OllamaProvider";
import { listModels } from "../lib/ollama";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

interface ChatBubble {
  id: number;
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  streaming?: boolean;
}

let nextId = 0;
function uid() { return ++nextId; }

function ToolCall({ name, args, result }: { name: string; args: Record<string, unknown>; result?: string }) {
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

  return (
    <div className="my-1 rounded-lg border border-border bg-background">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
      >
        {icon}
        <span className="font-medium text-muted-foreground">{label}</span>
        {result !== undefined && (
          expanded
            ? <ChevronDown className="ml-auto h-3 w-3 text-muted-foreground" />
            : <ChevronRight className="ml-auto h-3 w-3 text-muted-foreground" />
        )}
      </button>
      {expanded && result && (
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<() => void>();
  const toolResultsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    listModels(ollamaUrl)
      .then((m) => {
        const names = m.map((model) => model.name);
        setModels(names);
        if (!model && names.length > 0) setModel(names[0]);
      })
      .catch(() => {});
  }, [ollamaUrl, model]);

  async function handleConnect() {
    if (!repoUrl.trim()) return;
    setLoading(true);
    try {
      const session = await createChatSession(agentUrl, repoUrl.trim(), model, ollamaUrl);
      setSessionId(session.id);
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
        case "model_delta":
          assistantContent += event.content;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.id === assistantId && last.role === "assistant") {
              return [...prev.slice(0, -1), { ...last, content: assistantContent, streaming: true }];
            }
            return [...prev, { id: assistantId, role: "assistant", content: assistantContent, streaming: true }];
          });
          break;

        case "model_done":
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.id === assistantId && last.role === "assistant") {
              return [...prev.slice(0, -1), { ...last, content: assistantContent, streaming: false }];
            }
            if (assistantContent) {
              return [...prev, { id: assistantId, role: "assistant", content: assistantContent, streaming: false }];
            }
            return prev;
          });
          setStreaming(false);
          break;

        case "tool_start": {
          const toolId = `${assistantId}-tool-${event.name}-${Date.now()}`;
          pendingTools.set(toolId, { name: event.name, args: event.args });
          setMessages((prev) => [
            ...prev,
            { id: toolId, role: "tool", content: "", toolName: event.name, toolArgs: event.args },
          ]);
          break;
        }

        case "tool_result":
          setMessages((prev) => {
            // Find the last tool message without a result
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].role === "tool" && prev[i].toolName === event.name && !prev[i].toolResult) {
                const updated = [...prev];
                updated[i] = { ...updated[i], toolResult: event.result };
                return updated;
              }
            }
            return prev;
          });
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
  }

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
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
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
                    <p className="whitespace-pre-wrap text-sm">{msg.content}</p>
                    {msg.content && <CopyButton text={msg.content} />}
                    {msg.streaming && (
                      <span className="ml-1 inline-block h-4 w-1.5 animate-pulse bg-accent" />
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
                  />
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
