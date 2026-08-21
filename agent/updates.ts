import { createHash } from "node:crypto";

const REGISTRY = "https://registry.ollama.ai";
const MANIFEST_ACCEPT = "application/vnd.docker.distribution.manifest.v2+json";

// Docker-style namespace (`library/llama3.2`, `org/model`) and tag
// (`latest`, `7b`) components: alphanumeric start, then letters, digits,
// `_`, `.`, `-`. Anything else is rejected before it can reach a URL.
const NAMESPACE_SEGMENT = "[a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)*";
const NAMESPACE_RE = new RegExp(`^${NAMESPACE_SEGMENT}(?:/${NAMESPACE_SEGMENT})*$`);
const TAG_RE = new RegExp(`^${NAMESPACE_SEGMENT}$`);

function isSafeModelRef(namespace: string, tag: string): boolean {
  return NAMESPACE_RE.test(namespace) && TAG_RE.test(tag);
}

/**
 * Ollama is a local service, so update checks must only ever talk to
 * loopback addresses - never to arbitrary hosts supplied by a client
 * (which would let the server be used as an SSRF proxy).
 */
function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export interface ModelUpdateCheck {
  name: string;
  updateAvailable: boolean;
  localDigest?: string;
  remoteDigest?: string;
  error?: string;
}

/**
 * Splits an Ollama model reference into registry namespace + tag.
 * - `llama3.2`        -> { namespace: "library/llama3.2", tag: "latest" }
 * - `qwen2.5-coder:7b` -> { namespace: "library/qwen2.5-coder", tag: "7b" }
 * - `org/model:tag`    -> { namespace: "org/model", tag: "tag" }
 * Returns null for references on non-default registries (e.g. host:port/...).
 */
export function parseModelRef(name: string): { namespace: string; tag: string } | null {
  const match = name.trim().match(/^([^:/\s]+(?:\/[^:/\s]+)?)(?::([^:/\s]+))?$/);
  if (!match) return null;
  const path = match[1];
  const tag = match[2] ?? "latest";
  const segments = path.split("/");
  const namespace = segments.length === 1 ? `library/${path}` : path;
  return { namespace, tag };
}

export async function fetchRemoteDigest(
  namespace: string,
  tag: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!isSafeModelRef(namespace, tag)) return null;
  const encodedNs = namespace.split("/").map(encodeURIComponent).join("/");
  const url = `${REGISTRY}/v2/${encodedNs}/manifests/${encodeURIComponent(tag)}`;
  const res = await fetch(url, { headers: { Accept: MANIFEST_ACCEPT }, signal });
  if (!res.ok) return null;

  const header = res.headers.get("ollama-content-digest") ?? res.headers.get("Docker-Content-Digest");
  if (header) return header.trim().replace(/^sha256:/, "");

  // Fallback: hash the manifest body ourselves.
  const text = await res.text();
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Compares the locally installed digest (from Ollama's /api/tags) with the
 * registry's current manifest digest for the same tag. Different digests mean
 * an update is available. Runs server-side (the registry doesn't send CORS
 * headers, so the browser can't query it directly).
 */
export async function checkModelUpdate(ollamaUrl: string, name: string): Promise<ModelUpdateCheck> {
  const base = ollamaUrl.replace(/\/+$/, "");
  try {
    if (!isLoopbackUrl(base)) {
      return { name, updateAvailable: false, error: "ollamaUrl must be a loopback address (localhost)" };
    }
    const ref = parseModelRef(name);
    if (!ref) {
      return { name, updateAvailable: false, error: `Unsupported model reference: ${name}` };
    }
    if (!isSafeModelRef(ref.namespace, ref.tag)) {
      return { name, updateAvailable: false, error: "Invalid model name" };
    }

    const tagsRes = await fetch(`${base}/api/tags`);
    if (!tagsRes.ok) throw new Error(`Ollama /api/tags failed (${tagsRes.status})`);
    const tags = (await tagsRes.json()) as { models?: { name: string; digest: string }[] };
    const local = (tags.models ?? []).find((m) => m.name === name);
    if (!local?.digest) return { name, updateAvailable: false, error: "not installed locally" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let remoteDigest: string | null;
    try {
      remoteDigest = await fetchRemoteDigest(ref.namespace, ref.tag, controller.signal);
    } finally {
      clearTimeout(timer);
    }
    if (!remoteDigest) {
      return { name, updateAvailable: false, error: "registry check failed (custom/local model?)" };
    }

    const localHex = local.digest.replace(/^sha256:/, "");
    return {
      name,
      updateAvailable: remoteDigest !== localHex,
      localDigest: local.digest,
      remoteDigest: `sha256:${remoteDigest}`,
    };
  } catch (err) {
    return { name, updateAvailable: false, error: err instanceof Error ? err.message : String(err) };
  }
}
