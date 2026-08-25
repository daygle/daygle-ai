import { useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Bot,
  Check,
  ImagePlus,
  Loader2,
  MessageSquarePlus,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Send,
  Square,
  Trash2,
  User,
  X,
} from "lucide-react";
import {
  DEFAULT_AGENT_URL,
  cancelChat,
  createChatSession,
  deleteChatSession,
  renameChatSession,
  listChatSessions,
  getChatSession,
  sendChatMessage,
  updateChatModel,
  listProviderModels,
  type ProviderConfig,
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
import { CopyButton, Markdown, imageMime, stripToolJson } from "../components/chatUi";

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

interface ChatBubble {
  id: number;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  imageData?: string;
  imageMimeType?: string;
}

function bubblesFromMessages(stored: StoredChatMessage[]): ChatBubble[] {
  return stored
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      id: uid(),
      role: m.role as "user" | "assistant",
      content: m.content,
      imageData: m.images?.[0],
      imageMimeType: m.imageMimeTypes?.[0],
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
    // This page owns the plain "chat" history; agent sessions live on /agent.
    listChatSessions(agentUrl, "chat").then(setHistory).catch(() => {});
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
      const session = await createChatSession(agentUrl, "", model, LOCAL_OLLAMA_URL, loadGenOptions(), providerConfig, "chat");
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
      // A conversation owned by the Agent page belongs there, not here.
      if (chat.origin === "agent") {
        if (!opts?.silent) {
          setMessages([{ id: uid(), role: "assistant", content: "That conversation lives on the Agent page." }]);
          setConnected(true);
        } else {
          rememberSession(null);
        }
        return;
      }
      setSessionId(chat.id);
      rememberSession(chat.id);
      setMessages(bubblesFromMessages(chat.messages));
      setConnected(true);
      if (chat.model) setModel(chat.model);
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

  async function handleModelChange(next: string) {
    if (!next || next === model || !sessionId) return;
    setModel(next);
    try {
      await updateChatModel(agentUrl, sessionId, next);
      setHistory((prev) => prev.map((chat) => (chat.id === sessionId ? { ...chat, model: next } : chat)));
    } catch (err) {
      setMessages((prev) => [...prev, { id: uid(), role: "assistant", content: `Failed to update model: ${err instanceof Error ? err.message : String(err)}` }]);
    }
  }

  function removeImageAttachment() {
    setImageAttachment(null);
    setImageAttachmentName("");
  }

  function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
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

        // Tool events don't occur on this page, but keep the state correct in
        // case a tool-using session is ever resumed here.
        case "tool_start":
        case "tool_result":
        case "diff_preview":
          setStatusText("Thinking…");
          break;

        case "approval_requested":
          break;

        case "clarification_requested":
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

  function handleStop() {
    streamGenerationRef.current++;
    abortRef.current?.();
    abortRef.current = undefined;
    if (sessionId) void cancelChat(agentUrl, sessionId);
    setStreaming(false);
    setStatusText("");
    setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
  }

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

  const chatItems: ChatSummary[] = sessionId && !history.some((chat) => chat.id === sessionId)
    ? [{
        id: sessionId,
        repoUrl: "",
        model,
        title: messages.find((m) => m.role === "user")?.content.trim().replace(/\s+/g, " ").slice(0, 48) || "New chat",
        messageCount: messages.filter((m) => m.role === "user" || m.role === "assistant").length,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        origin: "chat",
      }, ...history]
    : history;

  return (
    <div className="flex h-full">
      {/* Sidebar: chat history */}
      {sidebarOpen && (
        <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card/40">
          <div className="flex items-center justify-between border-b border-border px-3 py-3">
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
                onClick={() => setSidebarOpen(false)}
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
                        onSubmit={(e) => { e.preventDefault(); renameChat(chat.id); }}
                        className="flex min-w-0 flex-1 items-center gap-1"
                      >
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => renameChat(chat.id)}
                          onKeyDown={(e) => { if (e.key === "Escape") setRenamingChatId(null); }}
                          className="min-w-0 flex-1 rounded bg-background px-1.5 py-0.5 text-xs font-medium text-foreground outline-none ring-1 ring-accent"
                        />
                      </form>
                    ) : (
                      <button
                        onClick={() => resumeChat(chat.id)}
                        className="flex min-w-0 flex-1 items-start gap-2 text-left"
                      >
                        <MessageSquarePlus className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${isActive ? "text-accent" : "text-muted-foreground"}`} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium text-foreground">{chat.title || "New chat"}</span>
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {chat.model ? `${chat.model} · ` : ""}{relativeTime(chat.lastActivity)}
                          </span>
                        </span>
                        {isActive && <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                      </button>
                    )}
                    {confirmDeleteChat === chat.id ? (
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          onClick={() => { deleteChat(chat.id); }}
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
                          onClick={() => { setRenamingChatId(chat.id); setRenameValue(chat.title || ""); }}
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
        </aside>
      )}
      {!sidebarOpen && (
        <button
          onClick={() => setSidebarOpen(true)}
          className="flex w-9 shrink-0 items-center justify-center border-r border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Show chat list"
        >
          <PanelRightOpen className="h-4 w-4 rotate-180" />
        </button>
      )}

      {/* Main chat area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5 sm:px-4 sm:py-3">
          <Bot className="h-4 w-4 text-accent" />
          <span className="hidden text-sm font-medium sm:inline">Chat</span>
          <span
            className="hidden rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground sm:inline"
            title={providerKind === "openai" ? `Cloud: ${cloudBaseUrl || "(no URL set)"}` : "Local Ollama"}
          >
            {providerKind === "openai" ? "☁ Cloud" : "◉ Local"}
          </span>
          {streaming && (
            <span className="ml-2 flex items-center gap-1.5 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
              <Loader2 className="h-3 w-3 animate-spin" />
              {statusText || "Working…"}
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
              </div>
            ))}

            {connected && !streaming && !messages.some((m) => m.role === "user") && (
              <div className="ml-10 space-y-2">
                <p className="text-xs text-muted-foreground">Not sure where to start? Try one of these:</p>
                <div className="flex flex-wrap gap-2">
                  {["Explain a programming concept", "Help me write a function", "Review some code I'll paste", "Help me debug an error"].map((prompt) => (
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
                  src={`data:${imageMime(imageAttachment.mimeType)};base64,${imageAttachment.data}`}
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
              <Button variant="outline" size="icon" onClick={() => imageInputRef.current?.click()} title="Upload image">
                <ImagePlus className="h-4 w-4" />
              </Button>
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message…"
                disabled={streaming}
                className="flex-1"
              />
              <Button
                size="icon"
                onClick={() => handleSend()}
                disabled={streaming || !input.trim() && !imageAttachment}
                title="Send message"
              >
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
      </div>
    </div>
  );
}