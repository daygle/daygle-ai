import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, Key, PlugZap, Server, TerminalSquare } from "lucide-react";
import { useOllama } from "../context/OllamaProvider";
import { describeError, getVersion } from "../lib/ollama";
import { getGithubToken, saveGithubToken } from "../lib/agent";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";

export function SettingsPage() {
  const { baseUrl, setBaseUrl, connected, checking, version, error } = useOllama();
  const [url, setUrl] = useState(baseUrl);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const [agentUrl] = useState(() => {
    try {
      return localStorage.getItem("daygle.agentUrl") ?? "http://localhost:8787";
    } catch {
      return "http://localhost:8787";
    }
  });
  const [ghToken, setGhToken] = useState("");
  const [ghTokenSaving, setGhTokenSaving] = useState(false);
  const [ghTokenResult, setGhTokenResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    getGithubToken(agentUrl).then(setGhToken).catch(() => {});
  }, [agentUrl]);

  async function handleTest() {
    const target = url.trim();
    if (!target) return;
    setTesting(true);
    setTestResult(null);
    try {
      const v = await getVersion(target);
      setTestResult({ ok: true, text: `Reachable · Ollama v${v}` });
    } catch (err) {
      setTestResult({ ok: false, text: describeError(err) });
    } finally {
      setTesting(false);
    }
  }

  function handleSave() {
    setBaseUrl(url.trim());
    setTestResult(null);
  }

  async function handleSaveToken() {
    setGhTokenSaving(true);
    setGhTokenResult(null);
    try {
      await saveGithubToken(agentUrl, ghToken.trim());
      setGhTokenResult({ ok: true, text: "Token saved." });
    } catch (err) {
      setGhTokenResult({ ok: false, text: describeError(err) });
    } finally {
      setGhTokenSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          daygle bundles its own Ollama server. Point it at a server, or run the bundled one.
        </p>
      </header>

      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-semibold">Server</h2>
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <label htmlFor="ollama-url" className="text-xs font-medium text-muted-foreground">
            Ollama base URL
          </label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <Input
              id="ollama-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="http://localhost:11434"
              className="font-mono"
            />
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleTest} disabled={testing || !url.trim()}>
                {testing ? <Spinner /> : <PlugZap className="h-4 w-4" />}
                Test
              </Button>
              <Button onClick={handleSave} disabled={url.trim() === baseUrl}>
                Save
              </Button>
            </div>
          </div>

          {testResult && (
            <p
              className={
                testResult.ok
                  ? "mt-3 flex items-center gap-1.5 text-xs text-accent"
                  : "mt-3 flex items-start gap-1.5 text-xs text-destructive"
              }
            >
              {testResult.ok ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : <CircleAlert className="h-3.5 w-3.5 shrink-0" />}
              {testResult.text}
            </p>
          )}

          <div className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-background p-3 text-xs">
            <span
              className={
                checking
                  ? "h-2 w-2 rounded-full bg-amber-400"
                  : connected
                    ? "h-2 w-2 rounded-full bg-accent"
                    : "h-2 w-2 rounded-full bg-destructive"
              }
            />
            <span className="text-muted-foreground">
              {checking
                ? "Checking connection…"
                : connected
                  ? `Connected to ${baseUrl}${version && version !== "unknown" ? ` (v${version})` : ""}`
                  : error
                    ? `Disconnected — ${error}`
                    : "Disconnected"}
            </span>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <TerminalSquare className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-semibold">Getting your server ready</h2>
        </div>

        <div className="space-y-3">
          <SetupBlock
            title="1 · Start the bundled server"
            description="Runs the project-local Ollama on 0.0.0.0:11434, stores models in .ollama/models, and allows the browser origin automatically:"
            code="bun run ollama"
          />
          <SetupBlock
            title="2 · Install Ollama (first time)"
            description="Downloads the official Ollama binary into .ollama/ — no system install. On Linux you'll need zstd (sudo apt-get install zstd):"
            code="bun run ollama:install"
          />
          <SetupBlock
            title="3 · Pull a model"
            description="Grab a model from the CLI, or just use the Models page in daygle:"
            code=".ollama/bin/ollama pull llama3.2"
          />
        </div>

        <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-4 text-xs leading-relaxed text-amber-200/90">
          <strong className="font-semibold text-amber-200">Heads up:</strong> daygle talks to Ollama directly from your
          browser, so run both on the same machine. If you use daygle from a hosted sandbox or another device, it can't
          reach <code className="font-mono">localhost</code> on your computer — run <code className="font-mono">bun run dev</code>{" "}
          locally, or expose your server with a tunnel (e.g. Tailscale or ngrok).
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Key className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-semibold">GitHub Token</h2>
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-xs text-muted-foreground">
            A personal access token lets the agent clone private repos and open pull requests. Create one at
            <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer" className="text-accent underline">github.com/settings/tokens</a>
            with <strong>repo</strong> scope.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input
              type="password"
              value={ghToken}
              onChange={(e) => setGhToken(e.target.value)}
              placeholder="ghp_xxxxxxxxxxxx"
              className="font-mono"
            />
            <Button onClick={handleSaveToken} disabled={ghTokenSaving}>
              {ghTokenSaving ? <Spinner /> : "Save"}
            </Button>
          </div>
          {ghTokenResult && (
            <p className={`mt-3 flex items-center gap-1.5 text-xs ${ghTokenResult.ok ? "text-accent" : "text-destructive"}`}>
              {ghTokenResult.ok ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : <CircleAlert className="h-3.5 w-3.5 shrink-0" />}
              {ghTokenResult.text}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function SetupBlock({ title, description, code }: { title: string; description: string; code: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-background p-3 font-mono text-xs text-accent">
        {code}
      </pre>
    </div>
  );
}
