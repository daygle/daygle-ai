import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isSandboxNetworkEnabled, type SandboxRunner } from "./sandbox";
import { isReviewSafeCommand } from "./tools";

const INSTALL_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/** Whitelist of allowed programs for QA command execution. */
const ALLOWED_QA_PROGRAMS = new Set([
  // Package managers
  "npm", "pnpm", "yarn", "bun",
  // Test runners
  "node", "deno", "bunx", "npx",
  // Git
  "git",
  // Build tools
  "make", "cargo", "go",
  // Python
  "python", "python3", "pip", "pip3",
  // Common utilities
  "ls", "cat", "head", "tail", "find", "grep", "wc",
  "echo", "mkdir", "cp", "mv", "rm", "touch",
  "chmod", "chown", "ln",
  // Version checks
  "tsc", "eslint", "prettier",
]);

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

/**
 * Splits a command string into argv pieces (POSIX-ish: single/double quotes
 * and backslash escapes are honored) so commands can run without a shell.
 * Running through a shell would let untrusted command text (e.g. a repo's
 * package.json scripts or a user-supplied QA command) inject arbitrary
 * commands - shell metacharacters like `;`, `&&` or `$()` are therefore
 * treated as literal arguments and will not be interpreted.
 */
function splitCommandLine(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += "\\";
  if (current) args.push(current);
  return args;
}

function spawnCapture(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; allowInstall?: boolean },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const argv = splitCommandLine(command);
    if (argv.length === 0) {
      resolve({ code: 1, stdout: "", stderr: "Empty command.", timedOut: false });
      return;
    }
    // Validate that the program is in our whitelist to prevent command injection.
    const program = argv[0];
    // The allowlist maps every program to itself, so a single lookup is the
    // whole validation - no alias indirection needed.
    if (!ALLOWED_QA_PROGRAMS.has(program)) {
      resolve({
        code: 1,
        stdout: "",
        stderr: `QA command rejected: "${program}" is not in the allowed programs list.`,
        timedOut: false,
      });
      return;
    }
    // Package scripts are accepted only when their body passes the same
    // reviewer policy used by the agentic reviewer. Installs are the sole
    // exception and are explicitly requested by the QA dependency bootstrap.
    const safe = opts.allowInstall
      ? INSTALL_RUNNERS.has(argv[0]) && argv[1] === "install" && argv.slice(2).every((token) => token === "--ignore-scripts")
      : isReviewSafeCommand(command, opts.cwd);
    if (!safe) {
      resolve({
        code: 1,
        stdout: "",
        stderr: `QA command rejected: "${argv[0]}" is not an allowed verification or install runner.`,
        timedOut: false,
      });
      return;
    }
    // The executable is selected from the literal allowlist; arguments are
    // passed directly so no shell can interpret repository-controlled text.
    const child = spawn(program, argv.slice(1), {
      cwd: opts.cwd,
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
      opts.signal?.removeEventListener("abort", onAbort);
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
 * detected (or configured) verification commands. Verification commands run
 * inside the sandbox. Host fallback is deliberately disabled by default:
 * verification and dependency installation must not execute repository code on
 * the host. Set DAYGLE_ALLOW_HOST_QA=1 only for an explicitly trusted local
 * checkout.
 */
export async function runQaGate(opts: {
  root: string;
  command?: string;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
  /** Verification runs here; host fallback is disabled unless explicitly opted in. */
  sandbox?: SandboxRunner;
  /** Explicit escape hatch for trusted local development, never enabled by default. */
  allowHostFallback?: boolean;
}): Promise<QaResult> {
  const { root, signal, sandbox } = opts;
  const allowHostFallback = opts.allowHostFallback === true || process.env.DAYGLE_ALLOW_HOST_QA === "1";
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

  if (!sandbox && !allowHostFallback) {
    throw new Error(
      "QA refused to run: a command sandbox is unavailable. Start Docker/Podman/bubblewrap, or explicitly set DAYGLE_ALLOW_HOST_QA=1 for a trusted checkout.",
    );
  }

  const outputParts: string[] = [];
  let passed = true;

  // The sandbox handles its own cwd (the repo is mounted at /work). Host
  // execution is reachable only through the explicit trusted-development
  // escape hatch above.
  const run = async (command: string, timeoutMs: number) => {
    if (!isReviewSafeCommand(command, root)) {
      return { code: 1, stdout: "", stderr: `QA command rejected by verification policy: ${command}`, timedOut: false };
    }
    if (sandbox) {
      const result = await sandbox.runCapture(root, command, { signal, timeoutMs, readOnly: true, network: false });
      return { code: result.code, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut };
    }
    return spawnCapture(command, { cwd: root, timeoutMs, signal });
  };

  if (fs.existsSync(path.join(root, "package.json")) && !fs.existsSync(path.join(root, "node_modules"))) {
    const pm = detectPackageManager(root);
    // Dependency bootstrap is also repository-controlled execution. Keep it in
    // the sandbox and never run it on the host; --ignore-scripts prevents the
    // package manager from invoking arbitrary lifecycle hooks.
    const installCommand = `${pm} install --ignore-scripts`;
    opts.onStatus?.(`QA: installing dependencies (${installCommand})${sandbox ? " (sandboxed)" : ""}…`);
    const install = sandbox
      ? await sandbox.runCapture(root, installCommand, {
          signal,
          timeoutMs: INSTALL_TIMEOUT_MS,
          network: isSandboxNetworkEnabled(),
        })
      : await spawnCapture(installCommand, { cwd: root, timeoutMs: INSTALL_TIMEOUT_MS, signal, allowInstall: true });
    if (install.timedOut) {
      return { ran: true, command: installCommand, output: "QA: dependency install timed out.", passed: false };
    }
    if (install.code !== 0) {
      const err = truncate(`${install.stdout}\n${install.stderr}`.trim(), MAX_OUTPUT);
      return { ran: true, command: installCommand, output: `QA: dependency install failed.\n${err}`, passed: false };
    }
  }

  for (const command of commands) {
    opts.onStatus?.(`QA: running ${command}${sandbox ? " (sandboxed)" : ""}…`);
    const result = await run(command, COMMAND_TIMEOUT_MS);
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
