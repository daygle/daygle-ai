import { cn } from "../../lib/utils";

export function Progress({ value, className }: { value: number; className?: string }) {
  const width = Math.min(100, Math.max(0, value));
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div className="h-full bg-accent transition-all duration-200" style={{ width: `${width}%` }} />
    </div>
  );
}
