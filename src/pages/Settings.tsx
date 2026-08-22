import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, Cpu, Gauge, Key, PlugZap, RotateCcw, Server, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useOllama } from "../context/OllamaProvider";
import { describeError, getVersion } from "../lib/ollama";
import { DEFAULT_AGENT_URL, agentHealth, checkSandbox, saveGithubToken } from "../lib/agent";
import { isAllowedOllamaUrl } from "../lib/utils";
import { DEFAULT_GEN_OPTIONS, loadGenOptions, loadModelPreference, saveGenOptions, saveModelPreference, type GenOptions } from "../lib/genOptions";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import { AppUpdate } from "../components/AppUpdate";

const SANDBOX_LABELS: Record<string, string> = {
  bubblewrap: "Bubblewrap",
  docker: "Docker",
  podman: "Podman",
};

export function SettingsPage() {
  const { baseUrl, setBaseUrl, connected, checking, version, error, models } = useOllama();
  const [url, setUrl] = useState(baseUrl);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // The agent holds GitHub credentials and is intentionally loopback-only.
  const [agentUrl] = useState(DEFAULT_AGENT_URL);
  const [ghToken, setGhToken] = useState("");
  const [ghTokenConfigured, setGhTokenConfigured] = useState(false);
  const [ghTokenSaving, setGhTokenSaving] = useState(false);
  const [ghTokenResult, setGhTokenResult] = useState<{ ok: boolean; text: string } | null>(null);

  const [gen, setGen] = useState<GenOptions>(() => loadGenOptions());
  const [defaultModel, setDefaultModel] = useState(() => loadModelPreference());

  // These options autosave to the browser as you type (no Save button). A brief
  // "Saved" flash makes that obvious and keeps the cards consistent.
  const [savedFlash, setSavedFlash] = useState(false);
  const savedTimer = useRef<number | undefined>(undefined);
  function markSaved() {
    setSavedFlash(true);
    window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSavedFlash(false), 1500);
  }
  useEffect(() => () => window.clearTimeout(savedTimer.current), []);

  function updateGen(patch: Partial<GenOptions>) {
    setGen((prev) => {
      const next = { ...prev, ...patch };
      saveGenOptions(next);
      return next;
    });
    markSaved();
  }
  // Reset only the sampling params, leaving the CPU/performance fields alone.
  function resetGen() {
    updateGen({
      temperature: DEFAULT_GEN_OPTIONS.temperature,
      num_ctx: DEFAULT_GEN_OPTIONS.num_ctx,
      top_p: undefined,
      top_k: undefined,
      repeat_penalty: undefined,
      keep_alive: undefined,
    });
  }
  // Reset only the CPU/performance fields.
  function resetPerf() {
    updateGen({ num_thread: undefined, num_batch: undefined, num_gpu: undefined });
  }

  const [sandboxName, setSandboxName] = useState<string | null | undefined>(undefined);
  const [sandboxTesting, setSandboxTesting] = useState(false);
  const [sandboxResult, setSandboxResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    agentHealth(agentUrl)
      .then((health) => {
        setSandboxName(health.sandbox);
        setGhTokenConfigured(health.token);
      })
      .catch(() => setSandboxName(null));
  }, [agentUrl]);

  async function handleSandboxCheck() {
    setSandboxTesting(true);
    setSandboxResult(null);
    try {
      const result = await checkSandbox(agentUrl);
      setSandboxName(result.name);
      setSandboxResult({ ok: result.ok, text: result.output });
    } catch (err) {
      setSandboxName(null);
      setSandboxResult({ ok: false, text: describeError(err) });
    } finally {
      setSandboxTesting(false);
    }
  }

  useEffect(() => {
    if (models.length === 0 || (defaultModel && models.some((model) => model.name === defaultModel))) return;
    const next = models[0].name;
    setDefaultModel(next);
    saveModelPreference(next);
  }, [defaultModel, models]);

  async function handleTest() {
    const target = url.trim();
    if (!target) return;
    if (!isAllowedOllamaUrl(target)) {
      setTestResult({ ok: false, text: "Only the local Ollama service or the UI's /api/ollama proxy is allowed." });
      return;
    }
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
    const target = url.trim();
    if (!isAllowedOllamaUrl(target)) {
      setTestResult({ ok: false, text: "Only the local Ollama service or the UI's /api/ollama proxy is allowed." });
      return;
    }
    setBaseUrl(target);
    setTestResult(null);
  }

  async function handleSaveToken() {
    setGhTokenSaving(true);
    setGhTokenResult(null);
    try {
      await saveGithubToken(agentUrl, ghToken.trim());
      setGhTokenConfigured(Boolean(ghToken.trim()));
      setGhToken("");
      setGhTokenResult({ ok: true, text: ghToken.trim() ? "Token saved on the agent server." : "Token removed from the agent server." });
    } catch (err) {
      setGhTokenResult({ ok: false, text: describeError(err) });
    } finally {
      setGhTokenSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
          <SlidersHorizontal className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">
Use the local Ollama server and give the agent a GitHub token.
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
            Ollama Base URL
          </label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Server className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="ollama-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="http://127.0.0.1:11434"
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
                    ? `Disconnected - ${error}`
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
            <label htmlFor="default-agent-model" className="text-xs font-medium text-muted-foreground">Default Agent Model</label>
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
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <NumField label="Temperature" hint="0 = focused, higher = more creative" value={gen.temperature} step="0.1" min={0} max={2} onChange={(v) => updateGen({ temperature: v })} />
            <NumField label="Context Length (num_ctx)" hint="tokens of context; larger uses more memory" value={gen.num_ctx} step="512" min={256} onChange={(v) => updateGen({ num_ctx: v })} />
            <NumField label="top_p" hint="nucleus sampling - optional" value={gen.top_p} step="0.05" min={0} max={1} onChange={(v) => updateGen({ top_p: v })} />
            <NumField label="top_k" hint="optional" value={gen.top_k} step="1" min={0} onChange={(v) => updateGen({ top_k: v })} />
            <NumField label="Repeat Penalty" hint="optional" value={gen.repeat_penalty} step="0.05" min={0} onChange={(v) => updateGen({ repeat_penalty: v })} />
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Keep Alive</label>
              <Input
                value={gen.keep_alive ?? ""}
                onChange={(e) => updateGen({ keep_alive: e.target.value.trim() || undefined })}
                placeholder="e.g. 5m · -1 keeps loaded · 0 unloads"
                className="font-mono"
              />
              <p className="text-[11px] text-muted-foreground">How long the model stays loaded after a reply.</p>
            </div>
          </div>
          <AutosaveFooter saved={savedFlash} onReset={resetGen} />
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Gauge className="h-4 w-4" />
          </div>
          <h2 className="text-sm font-semibold">Performance</h2>
        </div>

        <div className="rounded-2xl border border-border bg-card p-5">
          <p className="text-xs text-muted-foreground">
            Tuning for CPU-only machines (no GPU). These pass straight through to Ollama on your next new chat. Leave blank to let Ollama choose.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <NumField
              label="CPU Threads (num_thread)"
              hint="threads used to generate; try your number of physical cores"
              value={gen.num_thread}
              step="1"
              min={1}
              onChange={(v) => updateGen({ num_thread: v })}
            />
            <NumField
              label="Batch Size (num_batch)"
              hint="prompt batch; smaller (e.g. 128–256) uses less RAM"
              value={gen.num_batch}
              step="32"
              min={8}
              onChange={(v) => updateGen({ num_batch: v })}
            />
            <NumField
              label="GPU Layers (num_gpu)"
              hint="0 forces pure CPU and avoids slow partial offload"
              value={gen.num_gpu}
              step="1"
              min={0}
              onChange={(v) => updateGen({ num_gpu: v })}
            />
          </div>
          <div className="mt-4 rounded-lg border border-border bg-background p-3 text-[11px] leading-relaxed text-muted-foreground">
            <p className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
              <Cpu className="h-3.5 w-3.5 text-accent" /> Tips for Slow, CPU-Only Machines
            </p>
            <ul className="ml-4 list-disc space-y-0.5">
              <li>Prefer smaller / quantized models (e.g. 3B–7B, <span className="font-mono">q4</span> builds) - the single biggest speedup.</li>
              <li>Lower the <span className="font-mono">Context Length</span> above; large contexts are much slower on CPU.</li>
              <li>Set <span className="font-mono">Keep Alive</span> to <span className="font-mono">-1</span> to keep the model loaded and skip reload lag between messages.</li>
            </ul>
          </div>
          <AutosaveFooter saved={savedFlash} onReset={resetPerf} />
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
            A personal access token lets the agent clone private repos and open pull requests. It is stored only on the local agent server and is never sent back to this browser. Create one at{" "}
            <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer" className="text-accent underline">github.com/settings/tokens</a>{" "}
            with <strong>repo</strong> scope. Only loopback Ollama URLs are accepted; the agent and Ollama are not remote services.
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
          <p className="mt-3 text-[11px] text-muted-foreground">
            {ghTokenConfigured ? "A token is configured on the agent server. Enter a new token to replace it, or leave blank and save to remove it." : "No token is configured."}
          </p>
          {ghTokenResult && (
            <p className={`mt-3 flex items-center gap-1.5 text-xs ${ghTokenResult.ok ? "text-accent" : "text-destructive"}`}>
              {ghTokenResult.ok ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : <CircleAlert className="h-3.5 w-3.5 shrink-0" />}
              {ghTokenResult.text}
            </p>
          )}
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <h2 className="text-sm font-semibold">Sandbox</h2>
        </div>

        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  sandboxName === undefined ? "bg-muted" : sandboxName ? "bg-accent" : "bg-destructive"
                }`}
              />
              <span
                className={
                  sandboxName === undefined
                    ? "text-muted-foreground"
                    : sandboxName
                      ? "text-accent"
                      : "text-destructive"
                }
              >
                {sandboxName === undefined
                  ? "Checking sandbox…"
                  : sandboxName
                    ? `${SANDBOX_LABELS[sandboxName] ?? sandboxName} active`
                    : "No sandbox backend detected"}
              </span>
            </span>
            <Button variant="outline" size="sm" onClick={handleSandboxCheck} disabled={sandboxTesting}>
              {sandboxTesting ? <Spinner /> : <ShieldCheck className="h-3.5 w-3.5" />}
              {sandboxTesting ? "Testing…" : "Test sandbox"}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {sandboxName
              ? "Commands the agent runs (tests, builds, and the QA gate) execute inside the sandbox - the repo is the only writable location and network is off by default."
              : "No sandbox backend detected - commands run directly on the host, gated by the block/allow/approve policy. Install bubblewrap, Docker, or Podman for isolation."}
          </p>
          {sandboxResult && (
            <pre
              className={`mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-relaxed ${
                sandboxResult.ok ? "text-accent" : "text-destructive/90"
              }`}
            >
              {sandboxResult.text}
            </pre>
          )}
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold">Updates</h2>
        </div>
        <AppUpdate serverUrl={agentUrl} />
      </section>
    </div>
  );
}

/** Consistent footer for the autosaving cards: a "saved" status and a Reset. */
function AutosaveFooter({ saved, onReset }: { saved: boolean; onReset: () => void }) {
  return (
    <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
      <p className={`flex items-center gap-1.5 text-[11px] ${saved ? "text-accent" : "text-muted-foreground"}`}>
        {saved && <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />}
        <span>{saved ? "Saved" : "Saved automatically"} · applies to your next new chat.</span>
      </p>
      <Button variant="outline" size="sm" onClick={onReset}>
        <RotateCcw className="mr-1 h-3.5 w-3.5" /> Reset
      </Button>
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
