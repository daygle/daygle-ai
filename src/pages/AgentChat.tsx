import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, GitBranch, Loader2, Send, Square, Terminal, User } from "lucide-react";
import {
  createChatSession,
  sendChatMessage,
  type ChatEvent,
} from "../lib/agent";
import { useOllama } from "../context/OllamaProvider";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

interface DisplayMessage {
  role: "user" | "assistant" | "tool" | "status";
  content: string;
  toolName?: string;
}

export function AgentChatPage() {
  const { baseUrl: ollamaUrl } = useOllama();
  const [agentUrl, setAgentUrl] = useState(() => {
    try {
      return localStorage.getItem("daygle.agentUrl") ?? "http://localhost:8787";
    } catch {
      return "http://localhost:8787";
    }
  });

  const [repoUrl, setRepoUrl] = useState("");
  const [model, setModel] = useState("qwen2.5-coder:7b");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<() => void>();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleConnect() {
    if (!repoUrl.trim()) return;
    setLoading(true);
    try {
      const session = await createChatSession(agentUrl, repoUrl.trim(), model, ollamaUrl);
      setSessionId(session.id);
      setConnected(true);
      setMessages([
        { role: "status", content: `Connected to ${repoUrl}` },
        { role: "assistant", content: "Repo cloned and ready. What would you like to do?" },
      ]);
    } catch (err) {
      setMessages([{ role: "status", content: `Error: ${err instanceof Error ? err.message : String(err)}` }]);
    } finally {
      setLoading(false);
    }
  }

  const handleSend = useCallback(() => {
    if (!input.trim() || !sessionId || streaming) return;

    const userMsg = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setStreaming(true);

    let assistantContent = "";

    const cancel = sendChatMessage(agentUrl, sessionId, userMsg, (event: ChatEvent) => {
      switch (event.type) {
        case "status":
          setMessages((prev) => [...prev, { role: "status", content: event.message }]);
          break;
        case "model_delta":
          assistantContent += event.content;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant") {
              return [...prev.slice(0, -1), { ...last, content: assistantContent }];
            }
            return [...prev, { role: "assistant", content: assistantContent }];
          });
          break;
        case "model_done":
          setStreaming(false);
          break;
        case "tool_start":
          setMessages((prev) => [
            ...prev,
            { role: "tool", content: `Running ${event.name}…`, toolName: event.name },
          ]);
          break;
        case "tool_result":
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "tool" && last.toolName === event.name) {
              return [...prev.slice(0, -1), { ...last, content: `${event.name}: ${event.result.slice(0, 500)}` }];
            }
            return [...prev, { role: "tool", content: `${event.name}: ${event.result.slice(0, 500)}`, toolName: event.name }];
          });
          break;
        case "error":
          setMessages((prev) => [...prev, { role: "status", content: `Error: ${event.message}` }]);
          setStreaming(false);
          break;
      }
    });

    abortRef.current = cancel;
  }, [input, sessionId, streaming, agentUrl]);

  function handleStop() {
    abortRef.current?.();
    setStreaming(false);
    setMessages((prev) => [...prev, { role: "status", content: "Stopped." }]);
  }

  if (!connected) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="w-full max-w-lg space-y-4 rounded-xl border border-border bg-card p-6">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-accent" />
            <h1 className="text-lg font-semibold">Agent Chat</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Connect to a repository for an interactive coding session with the AI agent.
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
                <option value="qwen2.5-coder:7b">qwen2.5-coder:7b</option>
                <option value="llama3.2">llama3.2</option>
                <option value="qwen2.5:7b">qwen2.5:7b</option>
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

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Bot className="h-4 w-4 text-accent" />
        <span className="text-sm font-medium">Agent Chat</span>
        <GitBranch className="ml-1 h-3 w-3 text-muted-foreground" />
        <span className="max-w-md truncate text-xs text-muted-foreground">{repoUrl}</span>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="space-y-4">
          {messages.map((msg, i) => (
            <div key={i} className="flex gap-3">
              {msg.role === "user" && (
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/20 text-accent">
                  <User className="h-3.5 w-3.5" />
                </div>
              )}
              {msg.role === "assistant" && (
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/20 text-accent">
                  <Bot className="h-3.5 w-3.5" />
                </div>
              )}
              {msg.role === "tool" && (
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-400">
                  <Terminal className="h-3.5 w-3.5" />
                </div>
              )}
              {msg.role === "status" && (
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                {msg.role === "tool" && msg.toolName && (
                  <span className="mb-1 inline-block rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                    {msg.toolName}
                  </span>
                )}
                <p className={`whitespace-pre-wrap text-sm ${msg.role === "status" ? "text-muted-foreground" : ""}`}>
                  {msg.content}
                </p>
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="border-t border-border px-4 py-3">
        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            placeholder={streaming ? "Agent is working…" : "Ask about the code, request changes…"}
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
