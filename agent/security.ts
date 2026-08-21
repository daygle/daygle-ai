export const LOOPBACK_HOST = "127.0.0.1";

export const DEFAULT_UI_ORIGINS = [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
] as const;

export function getAllowedUiOrigins(value = process.env.DAYGLE_UI_ORIGINS): Set<string> {
  const origins = (value ?? DEFAULT_UI_ORIGINS.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return new Set(origins);
}

export function isAllowedUiOrigin(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  return Boolean(origin && allowed.has(origin));
}

/** Only allow the agent to send model requests to this machine's Ollama. */
export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      !url.username &&
      !url.password &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}
