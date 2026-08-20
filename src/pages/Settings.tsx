import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, Cpu, Key, PlugZap, RotateCcw, Server, SlidersHorizontal } from "lucide-react";
import { useOllama } from "../context/OllamaProvider";
import { describeError, getVersion } from "../lib/ollama";
import { getGithubToken, saveGithubToken } from "../lib/agent";
import { DEFAULT_GEN_OPTIONS, loadGenOptions, loadModelPreference, saveGenOptions, saveModelPreference, type GenOptions } from "../lib/genOptions";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";

export function SettingsPage() {
  const { baseUrl, setBaseUrl, connected, checking, version, error, models } = useOllama();
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

  const [gen, setGen] = useState<GenOptions>(() => loadGenOptions());
  const [defaultModel, setDefaultModel] = useState(() => loadModelPreference());

  function updateGen(patch: Partial<GenOptions>) {
    setGen((prev) => {
      const next = { ...prev, ...patch };
      saveGenOptions(next);
      return next;
    });
  }
  function resetGen() {
    setGen({ ...DEFAULT_GEN_OPTIONS });
    saveGenOptions({ ...DEFAULT_GEN_OPTIONS });
  }

  useEffect(() => {
    getGithubToken(agentUrl).then(setGhToken).catch(() => {});
  }, [agentUrl]);

  useEffect(() => {
    if (models.length === 0 || (defaultModel && models.some((model) => model.name === defaultModel))) return;
    const next = models[0].name;
    setDefaultModel(next);
    saveModelPreference(next);
  }, [defaultModel, models]);

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
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
          <SlidersHorizontal className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Point daygle at an Ollama server and give the agent a GitHub token.
          </p>
        </div>
      </header>

      <section className="space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Server className="h-4 w-4" />
          </div>
          <h2 className="text-sm font-semibold">Server</h2>
        </div>

        <div className="rounded-2xl border border-border bg-card p-5">
          <label htmlFor="ollama-url" className="text-xs font-medium text-muted-foreground">
            Ollama base URL
          </label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Server className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="ollama-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="http://localhost:11434"
                className="pl-9 font-mono"
              />
            </div>
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
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Cpu className="h-4 w-4" />
          </div>
          <h2 className="text-sm font-semibold">Generation</h2>
        </div>

        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="space-y-1">
            <label htmlFor="default-agent-model" className="text-xs font-medium text-muted-foreground">Default Agent model</label>
            <select
              id="default-agent-model"
              value={defaultModel}
              onChange={(event) => {
                setDefaultModel(event.target.value);
                saveModelPreference(event.target.value);
              }}
              disabled={models.length === 0}
              className="mt-2 h-10 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/60 disabled:opacity-50"
            >
              {models.length === 0 && <option value="">No models detected</option>}
              {models.map((model) => <option key={model.name} value={model.name}>{model.name}</option>)}
            </select>
            <p className="text-[11px] text-muted-foreground">Used when starting a new Agent chat. Existing chats keep their selected model.</p>
          </div>
          <p className="mt-5 border-t border-border pt-4 text-xs text-muted-foreground">
            Ollama parameters applied to new Agent chats. Leave optional fields blank to use the model's own defaults.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <NumField label="Temperature" hint="0 = focused, higher = more creative" value={gen.temperature} step="0.1" min={0} max={2} onChange={(v) => updateGen({ temperature: v })} />
            <NumField label="Context length (num_ctx)" hint="tokens of context; larger uses more memory" value={gen.num_ctx} step="512" min={256} onChange={(v) => updateGen({ num_ctx: v })} />
            <NumField label="top_p" hint="nucleus sampling — optional" value={gen.top_p} step="0.05" min={0} max={1} onChange={(v) => updateGen({ top_p: v })} />
            <NumField label="top_k" hint="optional" value={gen.top_k} step="1" min={0} onChange={(v) => updateGen({ top_k: v })} />
            <NumField label="Repeat penalty" hint="optional" value={gen.repeat_penalty} step="0.05" min={0} onChange={(v) => updateGen({ repeat_penalty: v })} />
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Keep alive</label>
              <Input
                value={gen.keep_alive ?? ""}
                onChange={(e) => updateGen({ keep_alive: e.target.value.trim() || undefined })}
                placeholder="e.g. 5m · -1 keeps loaded · 0 unloads"
                className="font-mono"
              />
              <p className="text-[11px] text-muted-foreground">How long the model stays loaded after a reply.</p>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
            <p className="text-[11px] text-muted-foreground">Saved automatically · applies to your next new chat.</p>
            <Button variant="outline" size="sm" onClick={resetGen}>
              <RotateCcw className="mr-1 h-3.5 w-3.5" /> Reset
            </Button>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Key className="h-4 w-4" />
          </div>
          <h2 className="text-sm font-semibold">GitHub Token</h2>
        </div>

        <div className="rounded-2xl border border-border bg-card p-5">
          <p className="text-xs text-muted-foreground">
            A personal access token lets the agent clone private repos and open pull requests. Create one at{" "}
            <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer" className="text-accent underline">github.com/settings/tokens</a>{" "}
            with <strong>repo</strong> scope.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Key className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="password"
                value={ghToken}
                onChange={(e) => setGhToken(e.target.value)}
                placeholder="ghp_xxxxxxxxxxxx"
                className="pl-9 font-mono"
              />
            </div>
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

function NumField({
  label,
  hint,
  value,
  step,
  min,
  max,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number | undefined;
  step: string;
  min?: number;
  max?: number;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <Input
        type="number"
        value={value ?? ""}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(e.target.value === "" || !Number.isFinite(n) ? undefined : n);
        }}
        className="font-mono"
      />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
