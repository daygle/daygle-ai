export const LOCAL_OLLAMA_URL = "http://127.0.0.1:11434";

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * Build the browser URL for a service. The UI proxy keeps Ollama and Agent on
 * loopback while allowing this UI itself to be opened from the LAN.
 */
export function sameHostUrl(port: number, proxyPath: string): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}${proxyPath}`;
  }
  return `http://127.0.0.1:${port}`;
}

/** Accept loopback services or this UI's same-origin Ollama proxy. */
export function isAllowedOllamaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.username || url.password) return false;
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return true;
    return typeof window !== "undefined" &&
      url.origin === window.location.origin &&
      url.pathname === "/api/ollama";
  } catch {
    return false;
  }
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
