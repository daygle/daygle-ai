import { Link } from "react-router-dom";
import { ArrowRight, Bot, Box, MessageCircle, Settings as SettingsIcon } from "lucide-react";
import { Logo } from "../components/Logo";
import { useOllama } from "../context/OllamaProvider";

const TILES = [
  { to: "/models", icon: Box, title: "Models", body: "Pull and manage your local models." },
  { to: "/settings", icon: SettingsIcon, title: "Settings", body: "Server URL and GitHub token." },
];

export function Landing() {
  const { connected, models } = useOllama();

  const status =
    connected === null
      ? { dot: "bg-amber-400", text: "Checking Ollama…" }
      : connected
        ? { dot: "bg-accent", text: `Ollama connected · ${models.length} model${models.length === 1 ? "" : "s"}` }
        : { dot: "bg-destructive", text: "Ollama not reachable" };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-2xl">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo />
          <p className="mt-4 text-sm text-muted-foreground">
            Your private AI coding agent, on models you run yourself.
          </p>
          <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs">
            <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
            <span className="text-muted-foreground">{status.text}</span>
          </div>
        </div>

        {/* Primary: Agent + Chat side by side */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Link
            to="/agent"
            className="group flex items-center gap-4 rounded-2xl border border-accent/40 bg-card p-5 transition-colors hover:border-accent"
          >
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
              <Bot className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold">Agent</h2>
              <p className="text-sm text-muted-foreground">Chat, work in a repository, or hand it a whole task to complete and open a PR.</p>
            </div>
            <ArrowRight className="h-5 w-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
          </Link>
          <Link
            to="/chat"
            className="group flex items-center gap-4 rounded-2xl border border-border bg-card p-5 transition-colors hover:border-accent/60"
          >
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground group-hover:text-foreground">
              <MessageCircle className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold">Chat</h2>
              <p className="text-sm text-muted-foreground">Talk to your local models - no repository needed.</p>
            </div>
          </Link>
        </div>

        {/* Secondary tiles */}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {TILES.map(({ to, icon: Icon, title, body }) => (
            <Link
              key={to}
              to={to}
              className="group flex items-start gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-border/80 hover:bg-card/80"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground group-hover:text-foreground">
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">{title}</h3>
                <p className="text-xs text-muted-foreground">{body}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
