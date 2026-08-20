import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, Key, PlugZap, Server } from "lucide-react";
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
                checking || connected === null
                  ? "h-2 w-2 rounded-full bg-amber-400"
                  : connected
                    ? "h-2 w-2 rounded-full bg-accent"
                    : "h-2 w-2 rounded-full bg-destructive"
              }
            />
            <span className="text-muted-foreground">
              {checking || connected === null
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
          <Key className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-semibold">GitHub Token</h2>
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-xs text-muted-foreground">
            A personal access token lets the agent clone private repos and open pull requests. Create one at{" "}
            <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer" className="text-accent underline">github.com/settings/tokens</a>{" "}
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
