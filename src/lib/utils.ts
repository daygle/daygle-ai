export const LOCAL_OLLAMA_URL = "http://127.0.0.1:11434";

/** Same-origin path the UI proxies to the loopback Ollama server. */
export const OLLAMA_PROXY_PATH = "/api/ollama";

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

/** The same-origin Ollama proxy URL the browser should always talk to. */
export function ollamaProxyUrl(): string {
  return sameHostUrl(11434, OLLAMA_PROXY_PATH);
}

/** True when the URL is this UI's same-origin `/api/ollama` proxy path. */
export function isProxyOllamaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      typeof window !== "undefined" &&
      url.origin === window.location.origin &&
      url.pathname === OLLAMA_PROXY_PATH
    );
  } catch {
    return false;
  }
}

/** Accept loopback services or this UI's same-origin Ollama proxy. */
export function isAllowedOllamaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.username || url.password) return false;
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return true;
    return isProxyOllamaUrl(value);
  } catch {
    return false;
  }
}

/**
 * Resolve the URL the browser should actually fetch Ollama from. The browser
 * must never connect to Ollama directly: a direct cross-origin POST/DELETE
 * (pull, delete, show) triggers a CORS preflight that Ollama rejects, so
 * downloads fail even while GET-based checks (version, tags) look connected.
 * Any allowed direct-loopback URL is therefore migrated to the same-origin
 * proxy path, which reaches the same loopback server with the Origin header
 * stripped at the proxy boundary (no CORS). Returns the input unchanged when
 * there is no window (SSR/tests) or the value is not an allowed URL.
 */
export function toBrowserOllamaUrl(value: string): string {
  if (typeof window === "undefined") return value;
  if (!isAllowedOllamaUrl(value)) return value;
  if (isProxyOllamaUrl(value)) return value;
  return ollamaProxyUrl();
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
