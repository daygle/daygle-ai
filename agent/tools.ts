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

/**
 * A couple of programs in SAFE_PROGRAMS can still write files via a flag
 * (`sort -o <file>`, `sort --output=<file>`). Those invocations must not be
 * auto-allowed: the coding agent and the read-only reviewer would otherwise
 * overwrite files without approval.
 */
function isMutatingReadOnlyCommand(tokens: string[]): boolean {
  if (tokens[0] === "sort") {
    return tokens.slice(1).some((t) => t === "-o" || t === "--output" || t.startsWith("--output="));
  }
  return false;
}

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
  if (SAFE_PROGRAMS.has(program)) {
    return isMutatingReadOnlyCommand(tokens) ? "approve" : "allow";
  }
  return "approve";
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
          path: { type: "string", description: "Optional file or directory to search (defaults to the whole repo). Space-separated paths are accepted." },
          semantic: { type: "boolean", description: "Use a lightweight word-based search when the exact regular expression is unknown." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create a new file, or overwrite an existing file with its COMPLETE new contents. Rewrites that remove most lines require explicit approval; for small edits use str_replace.",
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
      description: "Replace exact text in a file in place, leaving the rest of the file untouched. Use this for small, targeted edits such as find-and-replace, fixing one line, or renaming an identifier. Large replace_all operations require explicit approval. old_string must match the file exactly (including whitespace); if it appears more than once, make it more specific or set replace_all.",
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

// Only these package scripts are eligible for unattended reviewer execution.
// The script body is inspected as well; names alone are not trusted because a
// repo can define `test` as `rm -rf ...` or `curl ...`.
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const SAFE_SCRIPT_NAMES = new Set(["test", "typecheck", "build", "lint", "check", "verify", "test:unit", "test:ci"]);
const REVIEW_RUNNERS = new Set([
  "tsc", "vitest", "jest", "mocha", "eslint", "prettier", "biome", "pytest", "ruff", "mypy",
  "go", "cargo", "dotnet", "rspec", "rake", "phpunit", "vite", "next", "webpack", "true", "false",
]);
export { REVIEW_RUNNERS };

const INLINE_CODE_FLAGS = new Set(["-e", "--eval", "-c", "--command", "-p", "--print", "--exec", "-m"]);
const UNSAFE_SCRIPT_WORDS = /(?:curl|wget|nc|ncat|netcat|telnet|ssh|scp|sftp|rsync|ftp|gh|sudo|rm|chmod|chown|mkfs|mount|umount|git\s+(?:push|fetch|pull)|npm\s+install|pnpm\s+install|yarn\s+add|bun\s+add|PRIVATE\s+KEY)/i;

function packageScript(root: string, script: string): string | undefined {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    const value = packageJson.scripts?.[script];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function isSafeScriptBody(body: string, root: string): boolean {
  const withoutAnd = body.replace(/&&/g, " ");
  if (/[;&|<>`$()]/.test(withoutAnd)) return false;
  return body.split("&&").map((part) => part.trim()).filter(Boolean).every((part) => {
    const tokens = part.split(/\s+/);
    const program = tokens[0];
    if (PACKAGE_MANAGERS.has(program)) return Boolean(tokens[1]) && SAFE_SCRIPT_NAMES.has(tokens[1]) && tokens.slice(2).every((token) => token !== "--eval" && token !== "-e");
    if ((program === "node" || program === "deno") && (tokens[1] === "--version" || tokens[1] === "-v")) return tokens.length === 2;
    if (INLINE_CODE_FLAGS.has(tokens[1]) || tokens.slice(1).some((token) => INLINE_CODE_FLAGS.has(token))) return false;
    if (SAFE_PROGRAMS.has(program)) return !isMutatingReadOnlyCommand(tokens);
    return REVIEW_RUNNERS.has(program) && isReviewSafeCommand(part, root);
  });
}

function isSafePackageInvocation(tokens: string[], root?: string): boolean {
  const manager = tokens[0];
  if (!PACKAGE_MANAGERS.has(manager)) return false;
  const script = tokens[1] === "run" ? tokens[2] : tokens[1];
  if (!script || !SAFE_SCRIPT_NAMES.has(script)) return false;
  const body = root ? packageScript(root, script) : undefined;
  // Without a checkout we can still validate the command shape, but callers
  // with a root (the reviewer/QA) must also validate the package script body.
  if (root && (!body || UNSAFE_SCRIPT_WORDS.test(body) || !isSafeScriptBody(body, root))) return false;
  return true;
}

/**
 * Whether a command is safe for unattended review/QA. Package scripts are
 * accepted only when their name and package.json body pass the verification
 * policy; arbitrary `npm run <script>` and inline-code runners are rejected.
 */
export function isReviewSafeCommand(command: string, root?: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  const withoutAnd = trimmed.replace(/&&/g, " ");
  if (/[;&|<>`$()]/.test(withoutAnd)) return false;
  const segments = trimmed.split("&&").map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const tokens = segment.split(/\s+/);
    const program = tokens[0];
    if (program === "cd") return tokens.length === 2;
    if (PACKAGE_MANAGERS.has(program)) return isSafePackageInvocation(tokens, root);
    if (program === "git") return Boolean(tokens[1]) && SAFE_GIT.has(tokens[1]);
    if ((program === "node" || program === "deno") && (tokens[1] === "--version" || tokens[1] === "-v") && tokens.length === 2) return true;
    if (INLINE_CODE_FLAGS.has(tokens[1]) || tokens.slice(1).some((token) => INLINE_CODE_FLAGS.has(token))) return false;
    if (SAFE_PROGRAMS.has(program)) return !isMutatingReadOnlyCommand(tokens);
    return REVIEW_RUNNERS.has(program);
  });
}

export function reviewApproverForRoot(root: string): CommandApprover {
  return (command: string) => Promise.resolve(isReviewSafeCommand(command, root) ? "approve" : "deny");
}

/** Backwards-compatible policy for callers that do not have a checkout root. */
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

function splitPaths(root: string, rel: string): string[] {
  const trimmed = rel.trim();
  if (!trimmed) return ["."];
  // Prefer the literal string as a single path when it actually exists, so
  // paths containing spaces work; otherwise fall back to splitting on
  // whitespace for the multi-path shorthand the model sometimes emits.
  try {
    // existsSync deliberately does not throw for a missing aggregate string;
    // the old statSync-first path made the model's multi-path shorthand surface
    // an ENOENT before searchFiles could split it.
    if (fs.existsSync(safeResolve(root, trimmed))) return [trimmed];
  } catch {
    // An invalid/outside aggregate is still eligible for the safe token split;
    // each resulting path is checked independently below.
  }
  const paths: string[] = [];
  let current = "";
  let quote = "";
  for (const char of trimmed) {
    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote ? "" : char;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) paths.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) paths.push(current);
  return paths;
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
  // A literal path (which may contain spaces) wins over the shorthand split.
  const paths = splitPaths(root, rel);
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
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`No such file or directory: ${rel}`);
  }
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
  if (lines.length > MAX_READ_LINES) {
    throw new Error(`Requested range is too large (${lines.length} lines). Read at most ${MAX_READ_LINES} lines at a time.`);
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

function searchFiles(root: string, pattern: string, rel?: string, semantic = false): string {
  if (!pattern.trim()) {
    throw new Error("Missing search pattern.");
  }
  let regex: RegExp | undefined;
  if (!semantic) {
    try {
      regex = new RegExp(pattern);
    } catch {
      throw new Error(`Invalid regular expression: ${pattern}`);
    }
  }
  // Like list_files, tolerate the model passing several space-separated paths
  // in a single call; search each independently instead of treating the whole
  // string as one path (which made statSync throw ENOENT).
  const targets = splitPaths(root, rel || ".");
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

  const matches: Array<{ text: string; score: number }> = [];
  const words = semantic
    ? pattern.toLowerCase().match(/[a-z0-9_]{2,}/g)?.filter((word, index, all) => all.indexOf(word) === index) ?? []
    : [];
  const candidateLimit = semantic ? MAX_SEARCH_MATCHES * 10 : MAX_SEARCH_MATCHES;
  for (const file of files) {
    if (matches.length >= candidateLimit) break;
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
      if (matches.length >= candidateLimit) return;
      const lower = line.toLowerCase();
      if (!semantic && regex?.test(line)) {
        matches.push({ text: `${relPath}:${i + 1}: ${line.trim().slice(0, 200)}`, score: 0 });
      } else if (semantic && words.length > 0) {
        const score = words.reduce((total, word) => total + (lower.includes(word) ? 1 : 0), 0);
        if (score >= Math.max(1, Math.ceil(words.length / 2))) {
          matches.push({ text: `${relPath}:${i + 1}: ${line.trim().slice(0, 200)}`, score });
        }
      }
    });
  }
  if (matches.length === 0) {
    return missing.length > 0 ? `(no matches; not found: ${missing.join(", ")})` : "(no matches)";
  }
  // Semantic mode is intentionally dependency-free: rank lines containing the
  // most query words. It is a useful retrieval fallback, not a claim of true
  // embedding-based understanding.
  if (semantic) matches.sort((a, b) => b.score - a.score);
  // Surface skipped paths so the model can correct course instead of
  // assuming every target was searched.
  const note = missing.length > 0 ? `\n(not found: ${missing.join(", ")})` : "";
  return matches.slice(0, MAX_SEARCH_MATCHES).map((match) => match.text).join("\n") + note;
}

async function writeFile(root: string, rel: string, content: string, approve?: CommandApprover): Promise<string> {
  if (Buffer.byteLength(content, "utf8") > MAX_READ_BYTES) {
    throw new Error(`File too large (${Buffer.byteLength(content, "utf8")} bytes). Keep write_file content under ${MAX_READ_BYTES} bytes or use run_command instead.`);
  }
  const abs = safeResolve(root, rel);
  // Snapshot the old text so a drastic shrink can be blocked: the classic
  // failure mode is the model "rewriting" a file for a small edit and dropping
  // every line it didn't reproduce. Explicit approval still permits deliberate
  // full rewrites.
  let before = "";
  let existingSize = 0;
  try { existingSize = fs.statSync(abs).size; } catch { /* new file */ }
  if (existingSize > MAX_READ_BYTES) {
    throw new Error(`File too large to rewrite safely (over ${MAX_READ_BYTES} bytes): ${rel}`);
  }
  try {
    before = fs.readFileSync(abs, "utf8");
  } catch {
    before = "";
  }
  let note = "";
  if (before && !before.includes("\u0000")) {
    const beforeLineList = before.split("\n");
    const afterLineList = content.split("\n");
    const beforeLines = beforeLineList.length;
    const afterLines = afterLineList.length;
    const changedLines = Math.max(beforeLines, afterLines) - beforeLineList.reduce(
      (same, line, index) => same + (line === afterLineList[index] ? 1 : 0),
      0,
    );
    const drasticRewrite = beforeLines > 10 && (
      afterLines < Math.ceil(beforeLines / 2) ||
      (beforeLines > 20 && changedLines / Math.max(beforeLines, afterLines) > 0.75)
    );
    if (drasticRewrite) {
      const approvalText = `write_file ${rel}: replace ${beforeLines} lines with ${afterLines} lines (${changedLines} changed)`;
      if (!approve) {
        throw new Error(`Refusing to overwrite ${rel}: the replacement changes too much of the existing file (${beforeLines} to ${afterLines} lines, ${changedLines} changed). Use str_replace for a small edit, or explicitly approve this full rewrite.`);
      }
      if (await approve(approvalText) !== "approve") {
        return `Write denied: ${rel} was not changed because the replacement is a drastic rewrite.`;
      }
      note = `\nApproved full rewrite: ${rel} changed ${changedLines} of ${Math.max(beforeLines, afterLines)} lines.`;
    }
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${rel}.${note}`;
}

async function strReplace(root: string, rel: string, oldStr: string, newStr: string, replaceAll: unknown, approve?: CommandApprover): Promise<string> {
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
  if (Buffer.byteLength(replaced, "utf8") > MAX_READ_BYTES) {
    throw new Error(`Replacement would create a file larger than ${MAX_READ_BYTES} bytes.`);
  }
  if (all && occurrences > 10) {
    if (!approve) throw new Error(`Refusing to replace ${occurrences} occurrences in ${rel} without explicit approval.`);
    if (await approve(`str_replace ${rel}: replace ${occurrences} occurrences`) !== "approve") {
      return `Edit denied: ${rel} was not changed.`;
    }
  }
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
      return searchFiles(
        root,
        String(args.pattern ?? ""),
        typeof args.path === "string" ? args.path : undefined,
        args.semantic === true,
      );
    case "write_file":
      return writeFile(root, String(args.path ?? ""), String(args.content ?? ""), approve);
    case "str_replace":
      return strReplace(
        root,
        String(args.path ?? ""),
        String(args.old_string ?? ""),
        String(args.new_string ?? ""),
        args.replace_all,
        approve,
      );
    case "run_command":
      return runCommand(root, String(args.command ?? ""), approve, sandbox, signal);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
