import { Terminal } from "lucide-react";
import { cn } from "../lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-accent-foreground">
        <Terminal className="h-4 w-4" strokeWidth={2.5} />
      </span>
      <span className="font-mono text-sm font-semibold tracking-tight">daygle</span>
    </span>
  );
}
