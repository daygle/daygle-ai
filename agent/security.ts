export const LOOPBACK_HOST = "127.0.0.1";

/**
 * Block SSRF by refusing URLs that target private, loopback, or link-local
 * addresses.  Only public HTTPS (or explicit HTTP localhost for Ollama) is
 * allowed through the provider layer.
 */
export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const h = url.hostname.toLowerCase();
    // Block ALL literal IPv6 hosts (e.g. [::1], [fc00::1], [::ffff:127.0.0.1]).
    // Legitimate cloud providers use domain names, so nothing is lost.
    if (h.startsWith("[")) return false;
    // Parse IPv4 if present
    const ipv4 = h.includes(".") ? h : "";
    if (ipv4) {
      const parts = ipv4.split(".");
      // Reject octal/hex encodings (leading zeros): "0177.0.0.1" must not
      // normalize to 127.0.0.1 in a resolver while parsing as 177 here.
      if (parts.length !== 4 || parts.some((p) => !/^(0|[1-9]\d*)$/.test(p))) return false;
      const nums = parts.map(Number);
      if (nums.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return false;
      // Loopback 127.0.0.0/8
      if (nums[0] === 127) return false;
      // Private 10.0.0.0/8
      if (nums[0] === 10) return false;
      // Private 172.16.0.0/12
      if (nums[0] === 172 && nums[1] >= 16 && nums[1] <= 31) return false;
      // Private 192.168.0.0/16
      if (nums[0] === 192 && nums[1] === 168) return false;
      // Link-local 169.254.0.0/16 (incl. cloud metadata)
      if (nums[0] === 169 && nums[1] === 254) return false;
      // This-host 0.0.0.0/8
      if (nums[0] === 0) return false;
    } else {
      // Dotted-quad bypasses: a bare decimal integer ("2130706433" =
      // 127.0.0.1) resolves in some HTTP stacks but has no dots here.
      if (/^\d+$/.test(h)) return false;
    }
    // Block common internal hostnames and suffixes
    const blocked = ["localhost", "metadata.google.internal", "169.254.169.254"];
    if (blocked.includes(h)) return false;
    if (h.endsWith(".internal") || h.endsWith(".local") || h.endsWith(".localhost")) return false;
    return true;
  } catch {
    return false;
  }
}

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
