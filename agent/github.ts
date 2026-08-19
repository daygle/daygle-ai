import crypto from "node:crypto";

const API = "https://api.github.com";

export interface ParsedRepo {
  owner: string;
  repo: string;
}

export interface CreatePrOptions {
  base: string;
  head: string;
  title: string;
  body: string;
}

interface AppConfig {
  appId: string;
  privateKey: string;
  installationId?: string;
}

export function parseRepo(input: string): ParsedRepo {
  let value = input.trim().replace(/\.git$/, "");
  value = value
    .replace(/^https?:\/\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/^github\.com\//i, "")
    .replace(/\/+$/, "");
  const parts = value.split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error(`Could not parse a GitHub repo from "${input}". Use owner/repo or a GitHub URL.`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function normalizePem(key: string): string {
  if (key.includes("\\n")) return key.replace(/\\n/g, "\n");
  if (key.includes("-----BEGIN")) return key;
  try {
    return Buffer.from(key.replace(/\s+/g, ""), "base64").toString("utf8");
  } catch {
    return key;
  }
}

function getAppConfig(): AppConfig | null {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return null;
  return {
    appId,
    privateKey: normalizePem(privateKey),
    installationId: process.env.GITHUB_APP_INSTALLATION_ID?.trim() || undefined,
  };
}

export function githubAppAvailable(): boolean {
  return getAppConfig() !== null;
}

function createJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({ iat: now - 60, exp: now + 540, iss: appId });
  const input = `${header}.${payload}`;
  const signature = crypto.createSign("RSA-SHA256").update(input).sign(privateKey, "base64url");
  return `${input}.${signature}`;
}

async function apiRequest(jwt: string, path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (await res.json()) as unknown;
}

async function resolveInstallationId(jwt: string, owner: string, config: AppConfig): Promise<number> {
  if (config.installationId) return Number(config.installationId);
  const installations = (await apiRequest(jwt, "/app/installations")) as Array<{
    id: number;
    account?: { login?: string };
  }>;
  const found = installations.find(
    (installation) => installation.account?.login?.toLowerCase() === owner.toLowerCase(),
  );
  if (!found) {
    throw new Error(`The GitHub App is not installed for "${owner}". Install it on that account or repository.`);
  }
  return found.id;
}

export async function createInstallationToken(owner: string): Promise<string> {
  const config = getAppConfig();
  if (!config) throw new Error("GitHub App credentials are not configured.");
  const jwt = createJwt(config.appId, config.privateKey);
  const installationId = await resolveInstallationId(jwt, owner, config);
  const data = (await apiRequest(jwt, `/app/installations/${installationId}/access_tokens`, "POST", {})) as {
    token?: string;
  };
  if (!data.token) throw new Error("GitHub did not return an installation token.");
  return data.token;
}

export async function createPullRequest(
  token: string,
  owner: string,
  repo: string,
  options: CreatePrOptions,
): Promise<string> {
  const res = await fetch(`${API}/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: options.title,
      head: options.head,
      base: options.base,
      body: options.body,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to create pull request (${res.status}): ${text.slice(0, 400)}`);
  }
  const data = (await res.json()) as { html_url?: string };
  if (!data.html_url) throw new Error("GitHub did not return a pull request URL.");
  return data.html_url;
}
