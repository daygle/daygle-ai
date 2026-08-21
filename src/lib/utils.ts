export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * Build a default service URL on the same host the UI is served from. When the
 * app is opened locally this resolves to `http://localhost:<port>`; when it's
 * opened over the LAN (`http://<server-ip>:5173`) it resolves to that server's
 * IP, so the bundled Ollama and agent are reachable without hand-editing the
 * URL in Settings. Falls back to localhost outside a browser.
 */
export function sameHostUrl(port: number, fallbackHost = "localhost"): string {
  const host =
    typeof window !== "undefined" && window.location?.hostname
      ? window.location.hostname
      : fallbackHost;
  return `http://${host}:${port}`;
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function timeAgo(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function shortDigest(digest: string): string {
  return digest.replace(/^sha256:/, "").slice(0, 12);
}
