import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SandboxRunner } from "./sandbox";

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description?: string }>;
      required?: string[];
    };
  };
}

export type CommandApprover = (command: string) => Promise<"approve" | "deny">;

const MAX_LIST = 600;
const MAX_READ_BYTES = 200_000;
const MAX_READ_LINES = 1500;
const MAX_SEARCH_MATCHES = 120;
const MAX_SEARCH_FILE = 500_000;
const MAX_OUTPUT = 12_000;
const CAPTURE_LIMIT = 200_000;
const COMMAND_TIMEOUT_MS = 180_000;

// Programs whose simple invocations are read-only and safe to run without approval.
const SAFE_PROGRAMS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "grep",
  "rg",
  "file",
  "du",
  "sort",
  "uniq",
  "diff",
  "echo",
  "which",
  "command",
  "type",
  "true",
  "false",
  "uname",
]);

// Git subcommands that never mutate or touch the network.
const SAFE_GIT = new Set([
  "status",
  "diff",
  "log",
  "show",
  "ls-files",
  "rev-parse",
  "blame",
  "grep",
  "shortlog",
  "describe",
]);

// Presence of any of these means the command is compound and cannot be auto-allowed.
const SHELL_META = /[;&|<>`$()]/;

// Hard-blocked: destructive filesystem ops, privilege escalation, network exfil, and git remote changes.
const BLOCK_PATTERNS: RegExp[] = [
  /^\s*rm\s+(-[a-z]*r[a-z]*f|--recursive|--force|-[a-z]*f[a-z]*r)\b/i,
  /^\s*chmod\s+-R\b/i,
  /^\s*(chown|chgrp)\b/i,
  /^\s*mkfs\b/i,
  /^\s*(fdisk|parted|losetup|mount|umount)\b/i,
  /^\s*dd\s+.*of=\//i,
  /^\s*sudo\b/i,
  /^\s*(shutdown|reboot|poweroff|halt|systemctl)\b/i,
  /^\s*(env|printenv|set)\b/i,
  /^\s*git\s+(push|fetch|pull)\b/i,
  /^\s*git\s+remote\s+(add|set-url|remove|rename)\b/i,
  /^\s*(curl|wget|nc|ncat|netcat|telnet|ssh|scp|sftp|rsync|ftp|gh)\b/i,
  /:\(\)\s*\{/,
];

// Hard-blocked if present anywhere in the command: credentials, keys, and process environments.
const SECRET_PATTERNS: RegExp[] = [
  /\.env/,
  /id_rsa/,
  /\.ssh\//,
  /\.aws\//,
  /\.git-credentials/,
  /\.npmrc/,
  /\.gitconfig/,
  /\.pem\b/,
  /\.(p12|pfx)\b/,
  /PRIVATE\s+KEY/,
  /\/proc\/\d+\/environ/,
  /\/proc\/self\/environ/,
];

export type Decision = "allow" | "block" | "approve";

export function classifyCommand(command: string): Decision {
  const trimmed = command.trim();
  if (!trimmed) return "allow";

  for (const pattern of BLOCK_PATTERNS) {
    if (pattern.test(trimmed)) return "block";
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(trimmed)) return "block";
  }
  if (SHELL_META.test(trimmed)) return "approve";

  const tokens = trimmed.split(/\s+/);
  const program = tokens[0];
  if (program === "git") {
    return tokens[1] && SAFE_GIT.has(tokens[1]) ? "allow" : "approve";
  }
  return SAFE_PROGRAMS.has(program) ? "allow" : "approve";
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories under a path (relative to the repo root), recursively up to a cap.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to list. Defaults to the repository root." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the repository, returning numbered lines (up to 1500 lines).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the repo root." },
          start_line: { type: "number", description: "Optional 1-indexed line to start from." },
          end_line: { type: "number", description: "Optional 1-indexed line to end at." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description: "Search files for a regular expression, returning matches with line numbers.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for." },
          path: { type: "string", description: "Optional file or directory to search (defaults to the whole repo)." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create a new file, or overwrite an existing file with its COMPLETE new contents. Only use this for new files or a deliberate full rewrite - for small edits use str_replace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the repo root." },
          content: { type: "string", description: "The COMPLETE new contents of the file (every line)." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "str_replace",
      description: "Replace exact text in a file in place, leaving the rest of the file untouched. Use this for small, targeted edits such as find-and-replace, fixing one line, or renaming an identifier. old_string must match the file exactly (including whitespace); if it appears more than once, make it more specific or set replace_all.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the repo root." },
          old_string: { type: "string", description: "The exact text to replace." },
          new_string: { type: "string", description: "The replacement text." },
          replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a single unique match." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command in the repo (tests, typecheck, builds, git status, etc.). Read-only inspection commands run automatically; commands that mutate files, execute code, or use the network require user approval, and destructive or credential-accessing commands are blocked.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run." },
        },
        required: ["command"],
      },
    },
  },
];

/** Read-only tool surface for the agentic reviewer - every tool except the mutating editors. */
export const REVIEW_TOOL_DEFINITIONS: ToolDefinition[] = TOOL_DEFINITIONS.filter(
  (tool) => tool.function.name !== "write_file" && tool.function.name !== "str_replace",
);

// Test / typecheck / build runners the agentic reviewer may execute on its own.
// These run project scripts, so they're gated to this allowlist; anything
// destructive, networked, or secret-accessing is still hard-blocked by
// classifyCommand before it ever reaches the reviewer's approver.
export const REVIEW_RUNNERS = new Set([
  "npm", "pnpm", "yarn", "bun", "npx", "node", "deno", "tsc", "vitest", "jest",
  "mocha", "eslint", "prettier", "biome", "go", "cargo", "python", "python3",
  "pytest", "ruff", "mypy", "make", "gradle", "./gradlew", "mvn", "dotnet",
  "rspec", "rake", "phpunit", "composer",
]);

// Runners that can execute inline code. Combined with -e/-c/-m style flags
// they would hand the read-only reviewer arbitrary code execution (e.g.
// `node -e 'fs.rmSync(...)'` or `python -m pip install`), so those flag
// combinations are rejected outright - legit uses like `pytest` or
// `node --version` are unaffected.
const CODE_EXEC_RUNNERS = new Set(["node", "bun", "bunx", "deno", "npx", "python", "python3"]);
const INLINE_CODE_FLAGS = new Set(["-e", "--eval", "-c", "--command", "-p", "--print", "--exec", "-m"]);

/**
 * Whether a command is safe for the agentic reviewer to run unattended: a
 * chain of `cd <dir>` and known verification runners (or the read-only
 * SAFE_PROGRAMS / safe git subcommands), with no shell plumbing beyond `&&`.
 */
export function isReviewSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // Only `&&` chaining is allowed; reject pipes, redirects, subshells, etc.
  const withoutAnd = trimmed.replace(/&&/g, " ");
  if (/[;&|<>`$()]/.test(withoutAnd)) return false;

  const segments = trimmed.split("&&").map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const tokens = segment.split(/\s+/);
    const program = tokens[0];
    if (program === "cd") return tokens.length === 2;
    if (program === "git") return Boolean(tokens[1]) && SAFE_GIT.has(tokens[1]);
    if (CODE_EXEC_RUNNERS.has(program) && tokens.slice(1).some((t) => INLINE_CODE_FLAGS.has(t))) {
      return false;
    }
    return REVIEW_RUNNERS.has(program) || SAFE_PROGRAMS.has(program);
  });
}

/**
 * A CommandApprover for the agentic reviewer: auto-approves verification
 * commands from the allowlist and denies everything else, so the reviewer can
 * run tests unattended without prompting or gaining write access.
 */
export const reviewApprover: CommandApprover = (command: string) =>
  Promise.resolve(isReviewSafeCommand(command) ? "approve" : "deny");

function safeResolve(root: string, rel: string): string {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel || ".");
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`Path is outside the repository: ${rel}`);
  }
  // Lexical containment isn't enough when symlinks are involved: a link inside
  // the repo can point outside it. Walk up to the deepest existing ancestor
  // and compare real paths (the repo root itself may be a symlink, e.g. /tmp
  // on macOS, so compare against its real path too).
  const rootReal = fs.realpathSync(rootAbs);
  let probe = abs;
  for (;;) {
    let real: string;
    try {
      real = fs.realpathSync(probe);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
      continue;
    }
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      throw new Error(`Path is outside the repository: ${rel}`);
    }
    break;
  }
  return abs;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function listFiles(root: string, rel: string): string {
  const out: string[] = [];
  const missing: string[] = [];

  const listOne = (single: string) => {
    let abs: string;
    let stat: fs.Stats;
    try {
      abs = safeResolve(root, single);
      stat = fs.statSync(abs);
    } catch {
      // One bad path shouldn't sink a multi-path call (the model passes
      // space-separated paths); record it and keep going.
      missing.push(single);
      return;
    }
    if (stat.isFile()) {
      out.push(single);
      return;
    }

    const walk = (dirAbs: string, relDir: string, depth: number) => {
      if (out.length >= MAX_LIST || depth > 12) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (out.length >= MAX_LIST) break;
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === ".ollama") continue;
        const childRel = relDir ? path.join(relDir, entry.name) : entry.name;
        if (entry.isDirectory()) {
          out.push(`${childRel}/`);
          walk(path.join(dirAbs, entry.name), childRel, depth + 1);
        } else {
          out.push(childRel);
        }
      }
    };
    walk(abs, single === "." ? "" : single, 0);
  };

  // The model occasionally passes several space-separated paths in a single
  // list_files call; handle each independently so the call still succeeds.
  const paths = rel.trim() ? rel.split(/\s+/).filter(Boolean) : ["."];
  for (const p of paths) listOne(p);

  if (out.length === 0 && missing.length > 0) {
    throw new Error(`No such file or directory: ${missing.join(", ")}`);
  }

  // Sort globally: all directories first (sorted), then all files (sorted),
  // so the flat list in the Files panel groups folders at the top. Dedupe so
  // overlapping paths (e.g. "." plus a file) don't repeat entries.
  const entries = [...new Set(out)].sort((a, b) => {
    const aDir = a.endsWith("/");
    const bDir = b.endsWith("/");
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.localeCompare(b);
  });
  const lines = entries.length > 0 ? entries : ["(empty)"];
  // Tell the model when output was cut or paths were skipped, so it can
  // narrow the query instead of assuming it saw everything.
  if (out.length >= MAX_LIST) lines.push(`(truncated at ${MAX_LIST} entries)`);
  if (missing.length > 0) lines.push(`(not found: ${missing.join(", ")})`);
  return lines.join("\n");
}

function readFile(root: string, rel: string, startLine?: number, endLine?: number): string {
  const abs = safeResolve(root, rel);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) throw new Error(`Path is a directory: ${rel}`);
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`File too large (${stat.size} bytes). Read a line range or use search instead.`);
  }
  const raw = fs.readFileSync(abs, "utf8");
  if (raw.includes("\u0000")) {
    throw new Error(`File appears to be binary: ${rel}. Use run_command (e.g. strings/hexdump) instead.`);
  }
  let lines = raw.split("\n");
  const firstLine = Math.max(1, startLine ?? 1);
  if (startLine !== undefined || endLine !== undefined) {
    const end = Math.min(lines.length, endLine ?? lines.length);
    lines = lines.slice(firstLine - 1, end);
  } else if (lines.length > MAX_READ_LINES) {
    lines = lines.slice(0, MAX_READ_LINES);
  }
  return lines.map((line, i) => `${String(firstLine + i).padStart(4, " ")} | ${line}`).join("\n");
}

function collectFiles(dirAbs: string, out: string[], budget: { count: number }): void {
  if (budget.count >= 2000) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.count >= 2000) break;
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === ".ollama") continue;
    const child = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      collectFiles(child, out, budget);
    } else {
      out.push(child);
      budget.count += 1;
    }
  }
}

function searchFiles(root: string, pattern: string, rel?: string): string {
  if (!pattern.trim()) {
    throw new Error("Missing search pattern.");
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    throw new Error(`Invalid regular expression: ${pattern}`);
  }
  // Like list_files, tolerate the model passing several space-separated paths
  // in a single call; search each independently instead of treating the whole
  // string as one path (which made statSync throw ENOENT).
  const targets = rel && rel.trim() ? rel.split(/\s+/).filter(Boolean) : ["."];
  const missing: string[] = [];
  const collected: string[] = [];
  for (const target of targets) {
    let abs: string;
    try {
      abs = safeResolve(root, target);
      if (fs.statSync(abs).isFile()) {
        collected.push(abs);
        continue;
      }
      collectFiles(abs, collected, { count: 0 });
    } catch {
      missing.push(target);
    }
  }

  if (collected.length === 0 && missing.length > 0) {
    throw new Error(`No such file or directory: ${missing.join(", ")}`);
  }
  const files: string[] = [...new Set(collected)];

  const matches: string[] = [];
  for (const file of files) {
    if (matches.length >= MAX_SEARCH_MATCHES) break;
    try {
      if (fs.statSync(file).size > MAX_SEARCH_FILE) continue;
    } catch {
      continue; // file vanished between listing and reading
    }
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\u0000")) continue; // skip binary
    const relPath = path.relative(root, file);
    content.split("\n").forEach((line, i) => {
      if (matches.length >= MAX_SEARCH_MATCHES) return;
      if (regex.test(line)) {
        matches.push(`${relPath}:${i + 1}: ${line.trim().slice(0, 200)}`);
      }
    });
  }
  if (matches.length === 0) {
    return missing.length > 0 ? `(no matches; not found: ${missing.join(", ")})` : "(no matches)";
  }
  // Surface skipped paths so the model can correct course instead of
  // assuming every target was searched.
  const note = missing.length > 0 ? `\n(not found: ${missing.join(", ")})` : "";
  return matches.join("\n") + note;
}

function writeFile(root: string, rel: string, content: string): string {
  const abs = safeResolve(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${rel}.`;
}

function strReplace(root: string, rel: string, oldStr: string, newStr: string, replaceAll: unknown): string {
  if (!oldStr) {
    throw new Error("str_replace: old_string must not be empty.");
  }
  const abs = safeResolve(root, rel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`No such file or directory: ${rel}`);
  }
  if (stat.isDirectory()) throw new Error(`Path is a directory: ${rel}`);
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`File too large (${stat.size} bytes). Use run_command instead.`);
  }
  const raw = fs.readFileSync(abs, "utf8");
  if (raw.includes("\u0000")) {
    throw new Error(`File appears to be binary: ${rel}.`);
  }
  const occurrences = raw.split(oldStr).length - 1;
  if (occurrences === 0) {
    throw new Error(`str_replace: old_string was not found in ${rel}. Match it exactly (including whitespace), or read the file first to copy the exact text.`);
  }
  const all = replaceAll === true || replaceAll === "true" || replaceAll === 1 || replaceAll === "1";
  if (occurrences > 1 && !all) {
    throw new Error(`str_replace: old_string appears ${occurrences} times in ${rel}. Include more surrounding context to make it unique, or set replace_all to true.`);
  }
  const replaced = all ? raw.split(oldStr).join(newStr) : raw.replace(oldStr, newStr);
  fs.writeFileSync(abs, replaced, "utf8");
  const count = all ? occurrences : 1;
  return `Replaced ${count} occurrence${count === 1 ? "" : "s"} in ${rel}.`;
}

function executeCommand(root: string, command: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: root,
      shell: "/bin/bash",
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let overflow = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(text);
    };

    const onAbort = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // group already gone
        }
      }
      finish("exit code: cancelled\n(cancelled by user)");
    };
    signal?.addEventListener("abort", onAbort);

    timer = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // group already gone
        }
      }
      finish(`exit code: timeout\n(command timed out after ${Math.round(COMMAND_TIMEOUT_MS / 1000)}s)`);
    }, COMMAND_TIMEOUT_MS);

    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (target === "stdout") {
        if (stdout.length < CAPTURE_LIMIT) stdout += chunk.toString();
        else overflow = true;
      } else {
        if (stderr.length < CAPTURE_LIMIT) stderr += chunk.toString();
        else overflow = true;
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (err) => finish(`exit code: error\n${err.message}`));
    child.on("close", (code) => {
      const parts: string[] = [];
      if (stdout.trim()) parts.push(truncate(stdout.trim(), MAX_OUTPUT));
      if (stderr.trim()) parts.push(`[stderr]\n${truncate(stderr.trim(), MAX_OUTPUT)}`);
      if (overflow) parts.push("(output truncated)");
      finish(`exit code: ${code ?? "unknown"}\n${parts.join("\n") || "(no output)"}`);
    });
  });
}

async function runCommand(
  root: string,
  command: string,
  approve?: CommandApprover,
  sandbox?: SandboxRunner,
  signal?: AbortSignal,
): Promise<string> {
  const decision = classifyCommand(command);
  if (decision === "block") {
    throw new Error(`Blocked for safety: ${command}`);
  }
  if (decision === "approve") {
    if (!approve) {
      return "This command requires approval, but no approval channel is available. It was denied.";
    }
    const result = await approve(command);
    if (result === "deny") {
      return "Command denied by the user.";
    }
  }
  return sandbox ? sandbox.run(root, command, signal) : executeCommand(root, command, signal);
}

export async function runTool(
  root: string,
  name: string,
  args: Record<string, unknown>,
  approve?: CommandApprover,
  sandbox?: SandboxRunner,
  signal?: AbortSignal,
): Promise<string> {
  switch (name) {
    case "list_files":
      return listFiles(root, typeof args.path === "string" ? args.path : ".");
    case "read_file":
      return readFile(root, String(args.path ?? ""), asNumber(args.start_line), asNumber(args.end_line));
    case "search":
      return searchFiles(root, String(args.pattern ?? ""), typeof args.path === "string" ? args.path : undefined);
    case "write_file":
      return writeFile(root, String(args.path ?? ""), String(args.content ?? ""));
    case "str_replace":
      return strReplace(
        root,
        String(args.path ?? ""),
        String(args.old_string ?? ""),
        String(args.new_string ?? ""),
        args.replace_all,
      );
    case "run_command":
      return runCommand(root, String(args.command ?? ""), approve, sandbox, signal);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
