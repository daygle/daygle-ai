import { createHash } from "node:crypto";

const REGISTRY = "https://registry.ollama.ai";
const MANIFEST_ACCEPT = "application/vnd.docker.distribution.manifest.v2+json";

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
  const url = `${REGISTRY}/v2/${namespace}/manifests/${encodeURIComponent(tag)}`;
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
    const ref = parseModelRef(name);
    if (!ref) {
      return { name, updateAvailable: false, error: `Unsupported model reference: ${name}` };
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
