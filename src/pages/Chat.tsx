import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Bot, CircleAlert, Send, Square, Trash2, User } from "lucide-react";
import { useOllama } from "../context/OllamaProvider";
import { describeError, streamChat, type ChatMessage } from "../lib/ollama";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Select } from "../components/ui/select";
import { cn } from "../lib/utils";

const SUGGESTIONS = [
  "Explain what an LLM agent loop is, in one paragraph.",
  "Write a function that retries an HTTP request with exponential backoff.",
  "Give me a git alias that prints a compact branch graph.",
];

export function ChatPage() {
  const { baseUrl, connected, models } = useOllama();
  const [searchParams, setSearchParams] = useSearchParams();

  const paramModel = searchParams.get("model") ?? "";
  const model = models.some((m) => m.name === paramModel) ? paramModel : (models[0]?.name ?? "");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [partial, setPartial] = useState("");

  const partialRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, partial]);

  function setModel(name: string) {
    setSearchParams({ model: name });
  }

  async function handleSend() {
    const content = input.trim();
    if (!content || streaming || !model) return;

    const userMessage: ChatMessage = { role: "user", content };
    const history = [...messages, userMessage];
    setMessages(history);
    setInput("");
    setStreaming(true);
    partialRef.current = "";
    setPartial("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChat(
        baseUrl,
        model,
        history,
        (delta) => {
          partialRef.current += delta;
          setPartial(partialRef.current);
        },
        () => {},
        controller.signal,
      );
      setMessages((prev) => [...prev, { role: "assistant", content: partialRef.current }]);
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      if (!aborted) {
        setMessages((prev) => [...prev, { role: "assistant", content: `⚠️ ${describeError(err)}` }]);
      } else if (partialRef.current) {
        setMessages((prev) => [...prev, { role: "assistant", content: partialRef.current }]);
      }
    } finally {
      setStreaming(false);
      setPartial("");
      abortRef.current = null;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  function handleClear() {
    if (streaming) handleStop();
    setMessages([]);
    setPartial("");
    partialRef.current = "";
  }

  if (!connected) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Chat</h1>
          <p className="mt-1 text-sm text-muted-foreground">Test the models running on your Ollama server.</p>
        </header>
        <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Not connected to Ollama at <span className="font-mono">{baseUrl}</span>.{" "}
            <Link to="/settings" className="underline underline-offset-2">
              Check your settings
            </Link>
            .
          </p>
        </div>
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Chat</h1>
        </header>
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-20 text-center">
          <Bot className="h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">No models available to chat with.</p>
          <Link
            to="/models"
            className="text-sm font-medium text-accent underline-offset-2 hover:underline"
          >
            Pull a model first →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col md:h-[calc(100vh-4rem)]">
      <header className="flex items-center justify-between gap-3 pb-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Chat</h1>
          <p className="truncate text-sm text-muted-foreground">Streaming from {baseUrl}</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={model} onChange={(event) => setModel(event.target.value)} className="w-44">
            {models.map((m) => (
              <option key={m.digest} value={m.name}>
                {m.name}
              </option>
            ))}
          </Select>
          <Button variant="ghost" size="icon" onClick={handleClear} disabled={messages.length === 0} aria-label="Clear chat">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto pb-4 pr-1 scrollbar-thin">
        {messages.length === 0 && !partial ? (
          <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Bot className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm font-medium">Ask <span className="font-mono">{model}</span> anything.</p>
              <p className="mt-1 text-xs text-muted-foreground">Try one of these:</p>
            </div>
            <div className="flex max-w-md flex-col gap-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => setInput(suggestion)}
                  className="rounded-lg border border-border bg-card px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:border-accent/40 hover:text-foreground"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((message, index) => (
              <MessageBubble key={index} message={message} />
            ))}
            {(streaming || partial) && (
              <MessageBubble
                message={{ role: "assistant", content: partial }}
                streaming
              />
            )}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border pt-3">
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                handleSend();
              }
            }}
            placeholder={`Message ${model}…`}
            className="max-h-40 min-h-[48px] resize-none"
            disabled={streaming}
          />
          {streaming ? (
            <Button onClick={handleStop} variant="outline" size="icon" className="h-[48px] w-[48px]" aria-label="Stop">
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              onClick={handleSend}
              size="icon"
              className="h-[48px] w-[48px]"
              disabled={!input.trim()}
              aria-label="Send"
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Enter to send · Shift+Enter for a new line
        </p>
      </div>
    </div>
  );
}

function MessageBubble({ message, streaming = false }: { message: ChatMessage; streaming?: boolean }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex gap-2.5", isUser && "justify-end")}>
      {!isUser && (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
          <Bot className="h-4 w-4" />
        </div>
      )}
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap rounded-xl px-3.5 py-2.5 text-sm leading-relaxed",
          isUser ? "bg-accent text-accent-foreground" : "bg-muted text-foreground",
        )}
      >
        {message.content}
        {streaming && <span className="ml-0.5 inline-block h-4 w-2 translate-y-0.5 animate-blink bg-accent" />}
      </div>
      {isUser && (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <User className="h-4 w-4" />
        </div>
      )}
    </div>
  );
}
