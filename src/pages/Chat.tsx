import { useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { Bot, Loader2, Send, User, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  DEFAULT_AGENT_URL,
  createChatSession,
  deleteChatSession,
  renameChatSession,
  type ProviderConfig,
  getChatSession,
  sendChatMessage,
  type ChatEvent,
  type ChatImage,
  type ChatSummary,
  type StoredChatMessage,
} from "../lib/agent";
import { useOllama } from "../context/OllamaProvider";
import { useCloudProvider } from "../context/CloudProviderContext";
import { listModels } from "../lib/ollama";
import { loadGenOptions, loadModelPreference } from "../lib/genOptions";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { LOCAL_OLLAMA_URL } from "../lib/utils";

/** Remove raw tool-call JSON that some models emit as plain text. */
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

    let start = match.index;
    let depth = 0;
    let end = -1;
    for (let i = start; i < withoutFences.length; i++) {
      if (withoutFences[i] === "{") depth++;
      if (withoutFences[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }

    if (end < 0) break;
    try {
      const candidate = JSON.parse(withoutFences.slice(start, end)) as { name?: unknown; arguments?: unknown };
      if (typeof candidate.name === "string" && candidate.arguments !== undefined) {
        cursor = end;
        continue;
      }
    } catch {
      // Leave malformed assistant text visible.
    }
    cursor = start + 1;
  }

  return result
    .replace(/\{\s*"file"\s*:\s*"[^"]+"\s*,\s*"line"\s*:\s*\d+\s*\}/g, "")
    .replace(/(?:bash\s+)?(?:list_files|read_file|search|write_file|str_replace|run_command)\s*\([^)]*\)/gi, "")
    .replace(/(?:bash\s+)?cd\s+\S+\s+.+/gi, "")
    .trim();
}

let nextId = 0;
function uid() { return ++nextId; }

/** Lightweight markdown for assistant messages. */
function Markdown({ children }: { children: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed [&_a]:text-accent [&_a]:underline [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_p]:my-0 [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
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

/** Copy text to clipboard. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="mt-1 text-muted-foreground hover:text-foreground"
      title="Copy to clipboard"
    >
      {copied ? "✓" : "📋"}
    </button>
  );
}

interface ChatBubble {
  id: number;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  imageData?: string;
  imageMimeType?: string;
}

function bubblesFromMessages(stored: StoredChatMessage[]): ChatBubble[] {
  return stored.map((m) => ({
    id: uid(),
    role: m.role as "user" | "assistant",
    content: m.content,
  }));
}

/** Simple connection screen: model selection only, no repo. */
function ConnectScreen({
  models,
  model,
  onModelChange,
  onConnect,
  loading,
  error,
}: {
  models: string[];
  model: string;
  onModelChange: (m: string) => void;
  onConnect: () => void;
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6">
        <div className="space-y-1 text-center">
          <Bot className="mx-auto h-8 w-8 text-accent" />
          <h2 className="text-lg font-semibold">Start a Chat</h2>
          <p className="text-sm text-muted-foreground">Choose a model to get started.</p>
        </div>

        {error && (
          <p className="rounded bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
        )}

        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">Model</label>
          <select
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            {models.length === 0 && <option value="">Loading models…</option>}
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>

        <Button
          className="w-full"
          onClick={onConnect}
          disabled={loading || !model}
        >
          {loading ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Connecting…</>
          ) : (
            "Start Chat"
          )}
        </Button>
      </div>
    </div>
  );
}

export function ChatPage() {
  const { baseUrl: ollamaUrl } = useOllama();
  const [agentUrl] = useState(DEFAULT_AGENT_URL);
  const { kind: providerKind, baseUrl: cloudBaseUrl, apiKey: cloudApiKey } = useCloudProvider();

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
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatSummary[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteChat, setConfirmDeleteChat] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const abortRef = useRef<(() => void) | undefined>(undefined);
  const streamGenerationRef = useRef(0);
  const modelRequestRef = useRef(0);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const [searchParams] = useSearchParams();
  const paramModel = searchParams.get("model");

  // Load available models
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
      import("../lib/agent").then(({ listProviderModels }) =>
        listProviderModels(agentUrl, "openai", cloudBaseUrl.trim(), cloudApiKey || undefined)
          .then(applyModels)
          .catch(() => requestId === modelRequestRef.current && setModels([]))
      );
    } else if (providerKind === "ollama") {
      listModels(ollamaUrl)
        .then((items) => applyModels(items.map((item) => item.name)))
        .catch(() => requestId === modelRequestRef.current && setModels([]));
    }
  }, [ollamaUrl, paramModel, providerKind, cloudBaseUrl, cloudApiKey, agentUrl]);

  const refreshHistory = useCallback(() => {
    import("../lib/agent").then(({ listChatSessions }) =>
      listChatSessions(agentUrl).then(setHistory).catch(() => {})
    );
  }, [agentUrl]);

  useEffect(() => {
    if (!connected) return;
    const timer = window.setInterval(refreshHistory, 5000);
    return () => window.clearInterval(timer);
  }, [connected, refreshHistory]);

  // Auto-load last session on mount
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

  // Auto-scroll
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

  function rememberSession(id: string | null) {
    try {
      if (id) localStorage.setItem("daygle.chatSessionId", id);
      else localStorage.removeItem("daygle.chatSessionId");
    } catch { /* ignore */ }
  }

  async function handleConnect() {
    if (!model) return;
    setLoading(true);
    setConnectionError(null);
    try {
      const providerConfig: ProviderConfig | undefined = providerKind === "openai"
        ? { kind: "openai", baseUrl: cloudBaseUrl.trim(), apiKey: cloudApiKey || undefined }
        : undefined;
      const session = await createChatSession(agentUrl, "", model, LOCAL_OLLAMA_URL, loadGenOptions(), providerConfig);
      setSessionId(session.id);
      rememberSession(session.id);
      setConnected(true);
      setMessages([{
        id: uid(),
        role: "assistant",
        content: "Hi — I'm ready to chat. Ask me anything!",
      }]);
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : String(err));
      setConnected(false);
      setSessionId(null);
    } finally {
      setLoading(false);
    }
  }

  async function resumeChat(id: string, opts?: { silent?: boolean }) {
    abortRef.current?.();
    abortRef.current = undefined;
    setLoading(true);
    try {
      const chat = await getChatSession(agentUrl, id);
      setSessionId(chat.id);
      rememberSession(chat.id);
      setMessages(bubblesFromMessages(chat.messages));
      setConnected(true);
    } catch (err) {
      if (!opts?.silent) {
        setMessages([{ id: uid(), role: "assistant", content: `Failed to open chat: ${err instanceof Error ? err.message : String(err)}` }]);
        setConnected(true);
      } else {
        rememberSession(null);
      }
    } finally {
      setLoading(false);
    }
  }

  function startNewChat() {
    streamGenerationRef.current++;
    abortRef.current?.();
    abortRef.current = undefined;
    setConnected(false);
    setSessionId(null);
    setMessages([]);
    setInput("");
    removeImageAttachment();
    rememberSession(null);
    refreshHistory();
  }

  async function deleteChat(id: string) {
    setHistory((prev) => prev.filter((c) => c.id !== id));
    try {
      await deleteChatSession(agentUrl, id);
      if (id === sessionId) startNewChat();
    } catch {
      refreshHistory();
    }
    setConfirmDeleteChat(null);
  }

  async function renameChat(id: string) {
    if (!renameValue.trim()) {
      setRenamingChatId(null);
      return;
    }
    try {
      await renameChatSession(agentUrl, id, renameValue.trim());
      refreshHistory();
    } catch { /* ignore */ }
    setRenamingChatId(null);
  }

  function removeImageAttachment() {
    setImageAttachment(null);
    setImageAttachmentName("");
  }

  function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      setImageAttachment({ data: result.slice(comma + 1), mimeType: file.type });
      setImageAttachmentName(file.name);
    };
    reader.readAsDataURL(file);
  }

  const handleSend = useCallback((messageOverride?: string) => {
    const override = messageOverride?.trim();
    if ((!override && !input.trim() && !imageAttachment) || !sessionId) return;

    const userMsg = override || input.trim() || "Please describe this image.";
    const userImage = override ? undefined : imageAttachment;
    setInput("");
    removeImageAttachment();

    if (streaming) return; // no queue in chat-only mode

    setMessages((prev) => [...prev, {
      id: uid(),
      role: "user",
      content: userMsg,
      imageData: userImage?.data,
      imageMimeType: userImage?.mimeType,
    }]);
    setStreaming(true);
    setStatusText("Thinking…");

    const streamGeneration = ++streamGenerationRef.current;
    let assistantId = uid();
    let assistantContent = "";

    const cancel = sendChatMessage(agentUrl, sessionId, userMsg, (event: ChatEvent) => {
      if (streamGenerationRef.current !== streamGeneration) return;
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
          const finalCleaned = stripToolJson(assistantContent) || stripToolJson(event.content);
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

        // Ignore tool events in chat-only mode
        case "tool_start":
          setStatusText("Thinking…");
          // Start a new assistant bubble after tool use
          assistantId = uid();
          assistantContent = "";
          break;

        case "tool_result":
        case "diff_preview":
          setStatusText("Thinking…");
          break;

        case "approval_requested":
          // Auto-approve or skip — no approval UI in chat-only mode
          break;

        case "clarification_requested":
          // Show as a simple assistant message
          setMessages((prev) => [...prev, {
            id: uid(),
            role: "assistant",
            content: event.question,
          }]);
          break;

        case "error": {
          setMessages((prev) => [...prev, {
            id: uid(),
            role: "assistant",
            content: event.message,
          }]);
          setStreaming(false);
          setStatusText("");
          break;
        }
      }
    }, userImage ?? undefined);

    abortRef.current = cancel;
    setInput("");
  }, [input, sessionId, streaming, agentUrl, imageAttachment]);

  // Handle Enter key
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // --- Render ---
  if (!connected) {
    return (
      <ConnectScreen
        models={models}
        model={model}
        onModelChange={setModel}
        onConnect={handleConnect}
        loading={loading}
        error={connectionError}
      />
    );
  }

  return (
    <div className="flex h-full">
      {/* Sidebar: chat history */}
      {sidebarOpen && (
        <div className="flex w-64 shrink-0 flex-col border-r border-border bg-card/50">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-muted-foreground">Chats</span>
            <Button variant="ghost" size="sm" onClick={startNewChat} className="h-7 px-2 text-xs">
              + New
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {history.map((chat) => (
              <div
                key={chat.id}
                className={`group flex items-center gap-1 border-b border-border/50 px-2 py-2 text-sm transition-colors hover:bg-muted/50 ${
                  chat.id === sessionId ? "bg-muted" : ""
                }`}
              >
                {renamingChatId === chat.id ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => renameChat(chat.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") renameChat(chat.id);
                      if (e.key === "Escape") setRenamingChatId(null);
                    }}
                    className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                  />
                ) : (
                  <button
                    onClick={() => resumeChat(chat.id)}
                    className="min-w-0 flex-1 truncate text-left text-sm"
                  >
                    {chat.title || "New chat"}
                  </button>
                )}
                <div className="hidden shrink-0 group-hover:flex gap-0.5">
                  <button
                    onClick={() => { setRenamingChatId(chat.id); setRenameValue(chat.title || ""); }}
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                    title="Rename"
                  >✏️</button>
                  {confirmDeleteChat === chat.id ? (
                    <button
                      onClick={() => deleteChat(chat.id)}
                      className="rounded px-1 text-[10px] text-destructive hover:bg-destructive/10"
                    >Delete?</button>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteChat(chat.id)}
                      className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                      title="Delete"
                    >🗑</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main chat area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
          <button
            onClick={() => setSidebarOpen((o) => !o)}
            className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          >
            {sidebarOpen ? "◀" : "▶"}
          </button>
          <Bot className="h-4 w-4 text-accent" />
          <span className="text-sm font-medium">Chat</span>
          {streaming && statusText && (
            <span className="ml-2 flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> {statusText}
            </span>
          )}
        </header>

        {/* Messages */}
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
                          src={`data:${msg.imageMimeType};base64,${msg.imageData}`}
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
              </div>
            ))}

            {/* Thinking indicator */}
            {streaming && !messages.some((m) => m.streaming) && (
              <div className="flex gap-3">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/20 text-accent">
                  <Bot className="h-3.5 w-3.5" />
                </div>
                <div className="flex items-center gap-2 pt-1 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
                  <span className="animate-pulse">{statusText || "Thinking…"}</span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input area */}
        <div className="sticky bottom-0 z-20 border-t border-border bg-background/95 px-4 py-3 backdrop-blur">
          <div className="mx-auto max-w-3xl space-y-2">
            {imageAttachment && (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-background p-2">
                <img
                  src={`data:${imageAttachment.mimeType};base64,${imageAttachment.data}`}
                  alt="Attachment"
                  className="h-10 w-10 rounded object-cover"
                />
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{imageAttachmentName}</span>
                <button onClick={removeImageAttachment} className="text-muted-foreground hover:text-foreground">
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            <div className="flex gap-2">
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Attach image"
              >🖼️</button>
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message…"
                disabled={streaming}
                className="flex-1"
              />
              <Button
                size="sm"
                onClick={() => handleSend()}
                disabled={streaming || !input.trim()}
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
