import { Link } from "react-router-dom";
import { useOllama } from "../context/OllamaProvider";
import { cn } from "../lib/utils";

export function ConnectionStatus() {
  const { connected, checking, version, baseUrl } = useOllama();

  const dotColor = checking ? "bg-amber-400" : connected ? "bg-accent" : "bg-destructive";
  const label = checking
    ? "Connecting…"
    : connected
      ? `Connected${version && version !== "unknown" ? ` · v${version}` : ""}`
      : "Disconnected";

  return (
    <Link
      to="/settings"
      className="group flex w-full flex-col gap-1.5 rounded-lg border border-border bg-background/60 p-3 transition-colors hover:border-border/80 hover:bg-muted"
    >
      <span className="flex items-center gap-2 text-xs font-medium">
        <span className={cn("h-2 w-2 rounded-full", dotColor, connected && "shadow-[0_0_8px_hsl(var(--accent)/0.8)]")} />
        <span>{label}</span>
      </span>
      <span className="truncate font-mono text-[11px] text-muted-foreground">{baseUrl}</span>
    </Link>
  );
}
