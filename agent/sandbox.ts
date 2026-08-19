import { spawn } from "node:child_process";
import fs from "node:fs";

export interface SandboxRunner {
  name: string;
  run(root: string, command: string, signal?: AbortSignal): Promise<string>;
}

const NETWORK_ENABLED = process.env.DAYGLE_SANDBOX_NETWORK === "1";
const DEFAULT_IMAGE = process.env.DAYGLE_SANDBOX_IMAGE ?? "node:22-slim";
const TIMEOUT_MS = 180_000;
const CAPTURE_LIMIT = 200_000;
const MAX_OUTPUT = 12_000;

interface CaptureResult {
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
  opts: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal } = {},
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
    }, TIMEOUT_MS);

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
  return {
    name: "bubblewrap",
    async run(root, command, signal) {
      return formatResult(await spawnCapture(buildBwrapArgs(root, command), { signal }));
    },
  };
}

function containerRunner(engine: "docker" | "podman"): SandboxRunner {
  return {
    name: engine,
    async run(root, command, signal) {
      const args = [engine, "run", "--rm"];
      if (!NETWORK_ENABLED) args.push("--network", "none");
      args.push("--memory", "2g", "--cpus", "2");
      args.push("-v", `${root}:/work`, "-w", "/work");
      args.push(DEFAULT_IMAGE, "sh", "-c", command);
      return formatResult(await spawnCapture(args, { signal }));
    },
  };
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
