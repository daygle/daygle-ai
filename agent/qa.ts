import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface QaResult {
  /** Whether any verification command actually ran (false = nothing to verify). */
  ran: boolean;
  /** The command(s) that ran, for display. */
  command: string;
  output: string;
  passed: boolean;
}

const INSTALL_TIMEOUT_MS = 300_000;
const COMMAND_TIMEOUT_MS = 300_000;
const CAPTURE_LIMIT = 200_000;
const MAX_OUTPUT = 8_000;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

function spawnCapture(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: "/bin/bash",
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: { code: number | null; stdout: string; stderr: string; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // group already gone
        }
      }
    };

    const onAbort = () => {
      kill();
      finish({ code: null, stdout, stderr, timedOut: false });
    };
    opts.signal?.addEventListener("abort", onAbort);

    timer = setTimeout(() => {
      kill();
      finish({ code: null, stdout, stderr, timedOut: true });
    }, opts.timeoutMs);

    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString();
      if (target === "stdout") {
        if (stdout.length < CAPTURE_LIMIT) stdout += text;
      } else if (stderr.length < CAPTURE_LIMIT) stderr += text;
    };

    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", () => finish({ code: null, stdout, stderr, timedOut: false }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut: false }));
  });
}

function detectPackageManager(root: string): string {
  if (fs.existsSync(path.join(root, "bun.lock")) || fs.existsSync(path.join(root, "bun.lockb"))) return "bun";
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * Auto-detect verification commands from package.json: typecheck and test when
 * present; build only if neither exists.
 */
function detectCommands(root: string): string[] {
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) return [];
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  } catch {
    return [];
  }
  const scripts = pkg.scripts ?? {};
  const pm = detectPackageManager(root);
  const cmds: string[] = [];
  if (scripts.typecheck) cmds.push(`${pm} run typecheck`);
  if (scripts.test) cmds.push(`${pm} run test`);
  if (cmds.length === 0 && scripts.build) cmds.push(`${pm} run build`);
  return cmds;
}

/**
 * Runs the QA gate for a repo: installs dependencies if missing, then runs the
 * detected (or configured) verification commands. Runs on the host, not the
 * sandbox - the commands come from the repo's package.json or an explicit
 * user-provided QA command, so they're trusted harness input, and installs
 * need network anyway.
 */
export async function runQaGate(opts: {
  root: string;
  command?: string;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
}): Promise<QaResult> {
  const { root, signal } = opts;
  const commands = opts.command?.trim() ? [opts.command.trim()] : detectCommands(root);

  if (commands.length === 0) {
    return {
      ran: false,
      command: "",
      output:
        "No verification commands found (looked for typecheck / test / build in package.json, or a configured QA command).",
      passed: true,
    };
  }

  const outputParts: string[] = [];
  let passed = true;

  if (fs.existsSync(path.join(root, "package.json")) && !fs.existsSync(path.join(root, "node_modules"))) {
    const pm = detectPackageManager(root);
    opts.onStatus?.(`QA: installing dependencies (${pm} install)…`);
    const install = await spawnCapture(`${pm} install`, { cwd: root, timeoutMs: INSTALL_TIMEOUT_MS, signal });
    if (install.timedOut) {
      return { ran: true, command: `${pm} install`, output: "QA: dependency install timed out.", passed: false };
    }
    if (install.code !== 0) {
      const err = truncate(`${install.stdout}\n${install.stderr}`.trim(), MAX_OUTPUT);
      return { ran: true, command: `${pm} install`, output: `QA: dependency install failed.\n${err}`, passed: false };
    }
  }

  for (const command of commands) {
    opts.onStatus?.(`QA: running ${command}…`);
    const result = await spawnCapture(command, { cwd: root, timeoutMs: COMMAND_TIMEOUT_MS, signal });
    const output = truncate(`${result.stdout}\n${result.stderr}`.trim(), MAX_OUTPUT);
    if (result.timedOut) {
      passed = false;
      outputParts.push(`$ ${command}\nQA: timed out after ${COMMAND_TIMEOUT_MS / 1000}s`);
    } else {
      outputParts.push(`$ ${command}\n${output || "(no output)"}`);
      if (result.code !== 0) passed = false;
    }
  }

  return { ran: true, command: commands.join(" && "), output: outputParts.join("\n\n"), passed };
}
