import { Link } from "react-router-dom";
import { useOllama } from "../context/OllamaProvider";
import { cn } from "../lib/utils";

export function ConnectionStatus({ compact = false }: { compact?: boolean }) {
  const { connected, checking, version, baseUrl } = useOllama();

  const dotColor = checking ? "bg-amber-400" : connected ? "bg-accent" : "bg-destructive";
  const label = checking
    ? "Connecting…"
    : connected
      ? `Connected${version && version !== "unknown" ? ` · v${version}` : ""}`
      : "Disconnected";

  if (compact) {
    // Horizontal pill for the top nav bar — collapses to just the status dot on
    // narrow screens where the label and URL would crowd the header.
    return (
      <Link
        to="/settings"
        title={`${label} · ${baseUrl}`}
        className="group flex items-center gap-2 rounded-full border border-border bg-background/60 px-3 py-1.5 transition-colors hover:border-border/80 hover:bg-muted"
      >
        <span className={cn("h-2 w-2 shrink-0 rounded-full", dotColor, connected && "shadow-[0_0_8px_hsl(var(--accent)/0.8)]")} />
        <span className="hidden text-xs font-medium sm:inline">{label}</span>
        <span className="hidden truncate font-mono text-[11px] text-muted-foreground lg:inline">{baseUrl}</span>
      </Link>
    );
  }

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
