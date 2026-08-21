import { spawn } from "node:child_process";
import fs from "node:fs";

export interface SandboxRunner {
  name: string;
  run(root: string, command: string, signal?: AbortSignal): Promise<string>;
  /** Structured variant for harness code (e.g. the QA gate): raw exit code and output. */
  runCapture(
    root: string,
    command: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<CaptureResult>;
}

const NETWORK_ENABLED = process.env.DAYGLE_SANDBOX_NETWORK === "1";
const DEFAULT_IMAGE = process.env.DAYGLE_SANDBOX_IMAGE ?? "node:22-slim";
// Registries the sandbox image may be pulled from (comma-separated). Anything
// else is refused at run time, so a tampered DAYGLE_SANDBOX_IMAGE can't point
// the sandbox at an arbitrary registry.
const ALLOWED_REGISTRIES = (process.env.DAYGLE_SANDBOX_REGISTRIES ?? "docker.io")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);
const TIMEOUT_MS = 180_000;
const CAPTURE_LIMIT = 200_000;
const MAX_OUTPUT = 12_000;

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflow: boolean;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

function hasCommand(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", `command -v ${cmd} >/dev/null 2>&1`], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function spawnCapture(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const child = spawn(args[0], args.slice(1), {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let overflow = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: CaptureResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const onAbort = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // group already gone
        }
      }
      finish({ code: null, stdout, stderr, timedOut: false, overflow });
    };
    opts.signal?.addEventListener("abort", onAbort);

    timer = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // group already gone
        }
      }
      finish({ code: null, stdout, stderr, timedOut: true, overflow });
    }, opts.timeoutMs ?? TIMEOUT_MS);

    const append = (chunk: Buffer, target: "stdout" | "stderr") => {
      const text = chunk.toString();
      if (target === "stdout") {
        if (stdout.length < CAPTURE_LIMIT) stdout += text;
        else overflow = true;
      } else {
        if (stderr.length < CAPTURE_LIMIT) stderr += text;
        else overflow = true;
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, "stderr"));
    child.on("error", () => finish({ code: null, stdout, stderr, timedOut: false, overflow }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut: false, overflow }));
  });
}

function formatResult(result: CaptureResult): string {
  if (result.timedOut) {
    return `exit code: timeout\n(command timed out after ${Math.round(TIMEOUT_MS / 1000)}s)`;
  }
  const parts: string[] = [];
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout) parts.push(truncate(stdout, MAX_OUTPUT));
  if (stderr) parts.push(`[stderr]\n${truncate(stderr, MAX_OUTPUT)}`);
  if (result.overflow) parts.push("(output truncated)");
  return `exit code: ${result.code ?? "error"}\n${parts.join("\n") || "(no output)"}`;
}

function buildBwrapArgs(root: string, command: string): string[] {
  const args = ["bwrap"];

  // Read-only toolchain + config from the host.
  args.push("--ro-bind", "/usr", "/usr");
  args.push("--ro-bind", "/etc", "/etc");
  if (fs.existsSync("/opt")) args.push("--ro-bind", "/opt", "/opt");

  // Merged-/usr symlinks so /bin/sh, /lib, etc. resolve.
  args.push("--symlink", "usr/bin", "/bin");
  args.push("--symlink", "usr/lib", "/lib");
  args.push("--symlink", "usr/sbin", "/sbin");
  if (fs.existsSync("/usr/lib64")) {
    args.push("--symlink", "usr/lib64", "/lib64");
  } else if (fs.existsSync("/lib64")) {
    args.push("--ro-bind", "/lib64", "/lib64");
  }

  args.push("--proc", "/proc");
  args.push("--dev", "/dev");
  args.push("--tmpfs", "/tmp");

  // The repo is the only writable location (mounted at /work).
  args.push("--bind", root, "/work");

  if (NETWORK_ENABLED) {
    args.push("--unshare-pid", "--unshare-ipc", "--unshare-uts");
  } else {
    args.push("--unshare-all");
  }
  args.push("--die-with-parent", "--new-session", "--chdir", "/work");

  args.push("--", "sh", "-c", command);
  return args;
}

function bwrapRunner(): SandboxRunner {
  const runCapture: SandboxRunner["runCapture"] = async (root, command, opts) =>
    spawnCapture(buildBwrapArgs(root, command), { signal: opts?.signal, timeoutMs: opts?.timeoutMs });
  return {
    name: "bubblewrap",
    runCapture,
    run: (root, command, signal) => runCapture(root, command, { signal }).then(formatResult),
  };
}

interface ParsedImageRef {
  registry: string;
  repository: string;
  digest?: string;
}

/**
 * Normalizes a container image reference and defaults the registry to
 * docker.io: `node:22-slim`, `library/node:22-slim`, and
 * `docker.io/library/node:22-slim@sha256:...` all parse; a host with a `.` or
 * `:` (or `localhost`) before the first slash is treated as a registry.
 */
export function parseImageRef(ref: string): ParsedImageRef {
  let rest = ref.trim();
  let digest: string | undefined;
  const at = rest.lastIndexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let registry = "docker.io";
  let repository = rest;
  const slash = rest.indexOf("/");
  if (slash !== -1) {
    const first = rest.slice(0, slash);
    if (first.includes(".") || first.includes(":") || first === "localhost") {
      registry = first;
      repository = rest.slice(slash + 1);
    }
  }
  // docker.io implies the `library` namespace for single-name references.
  if (registry === "docker.io" && !repository.includes("/")) {
    repository = `library/${repository}`;
  }
  return { registry, repository, digest };
}

/** Refuses images from registries outside the allowlist (supply-chain hardening). */
export function assertAllowedImage(ref: string): ParsedImageRef {
  const parsed = parseImageRef(ref);
  if (!ALLOWED_REGISTRIES.includes(parsed.registry)) {
    throw new Error(
      `Sandbox image registry "${parsed.registry}" is not in the allowlist (${ALLOWED_REGISTRIES.join(", ")}). ` +
        `Allow it with DAYGLE_SANDBOX_REGISTRIES or use an image from an allowed registry.`,
    );
  }
  return parsed;
}

function containerRunner(engine: "docker" | "podman"): SandboxRunner {
  // Resolved once and frozen, so every container runs the exact image content
  // that was first pulled - a registry tag moving later can't silently change
  // what the sandbox executes.
  let pinnedRef: string | null = null;

  async function resolveImageRef(): Promise<string> {
    if (pinnedRef) return pinnedRef;
    const parsed = assertAllowedImage(DEFAULT_IMAGE);

    // An explicit @sha256: pin is honored as-is (strongest form).
    if (parsed.digest) {
      pinnedRef = `${parsed.registry}/${parsed.repository}@${parsed.digest}`;
      return pinnedRef;
    }

    const ref = `${parsed.registry}/${parsed.repository}`;
    const inspect = async (): Promise<string> => {
      const result = await spawnCapture(
        [engine, "image", "inspect", "--format", "{{index .RepoDigests 0}}", ref],
        { timeoutMs: 60_000 },
      );
      return result.code === 0 ? result.stdout.trim() : "";
    };

    let digest = await inspect();
    if (!digest) {
      const pulled = await spawnCapture([engine, "pull", ref], { timeoutMs: 600_000 });
      if (pulled.code !== 0) {
        throw new Error(
          `Failed to pull sandbox image ${ref}: ${`${pulled.stdout}\n${pulled.stderr}`.trim().slice(0, 1000) || "unknown error"}`,
        );
      }
      digest = await inspect();
    }
    if (!digest) {
      // No registry digest (e.g. a locally built image) - freeze on the image ID instead.
      const id = await spawnCapture([engine, "image", "inspect", "--format", "{{.Id}}", ref], { timeoutMs: 60_000 });
      if (id.code !== 0 || !id.stdout.trim()) {
        throw new Error(`Could not resolve a digest for sandbox image ${ref}.`);
      }
      pinnedRef = id.stdout.trim();
    } else {
      pinnedRef = digest;
    }
    console.log(`sandbox image pinned: ${pinnedRef}`);
    return pinnedRef;
  }

  const runCapture: SandboxRunner["runCapture"] = async (root, command, opts) => {
    try {
      const args = [engine, "run", "--rm"];
      if (!NETWORK_ENABLED) args.push("--network", "none");
      args.push("--memory", "2g", "--cpus", "2");
      args.push("-v", `${root}:/work`, "-w", "/work");
      args.push(await resolveImageRef(), "sh", "-c", command);
      return await spawnCapture(args, { signal: opts?.signal, timeoutMs: opts?.timeoutMs });
    } catch (err) {
      // Surface config/pull errors as a failed command result instead of an
      // unhandled rejection, so they show up in run logs and the UI.
      return {
        code: null,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        timedOut: false,
        overflow: false,
      };
    }
  };

  return {
    name: engine,
    runCapture,
    run: (root, command, signal) => runCapture(root, command, { signal }).then(formatResult),
  };
}

/** Whether the sandbox is configured to allow network access (DAYGLE_SANDBOX_NETWORK=1). */
export function isSandboxNetworkEnabled(): boolean {
  return NETWORK_ENABLED;
}

export async function detectSandbox(): Promise<SandboxRunner | null> {
  if (await hasCommand("bwrap")) {
    try {
      const result = await spawnCapture(buildBwrapArgs("/tmp", "true"));
      if (result.code === 0) return bwrapRunner();
    } catch {
      // fall through to the next backend
    }
  }
  if (await hasCommand("docker")) {
    try {
      const result = await spawnCapture(["docker", "info"]);
      if (result.code === 0) return containerRunner("docker");
    } catch {
      // fall through
    }
  }
  if (await hasCommand("podman")) {
    try {
      const result = await spawnCapture(["podman", "info"]);
      if (result.code === 0) return containerRunner("podman");
    } catch {
      // fall through
    }
  }
  return null;
}
