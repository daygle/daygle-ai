import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  checkModelUpdates,
  DEFAULT_AGENT_URL,
  searchHfModels,
  getHfModelFiles,
  type HfModel,
  type HfModelFile,
  type ModelUpdateInfo,
} from "../lib/agent";
import {
  Box,
  CircleAlert,
  Download,
  ExternalLink,
  HardDrive,
  Heart,
  Info,
  MessageSquare,
  RefreshCw,
  Search,
  Star,
  Trash2,
  TrendingDown,
  X,
} from "lucide-react";
import { useOllama } from "../context/OllamaProvider";
import {
  deleteModel,
  describeError,
  getAllModelCapabilities,
  showModel,
  type OllamaModel,
  type PullProgress,
} from "../lib/ollama";
import { startPull, subscribePull } from "../lib/pullManager";
import { formatBytes, shortDigest, timeAgo } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Progress } from "../components/ui/progress";
import { Spinner } from "../components/ui/spinner";
import { Modal } from "../components/ui/modal";
import { cn } from "../lib/utils";

const POPULAR = [
  "qwen2.5-coder:7b",
  "llama3.2",
  "deepseek-r1:8b",
  "mistral",
  "gemma3:4b",
  "codellama:13b",
  "phi4:14b",
];

export function ModelsPage() {
  const { baseUrl, connected, models, loading, refreshModels } = useOllama();
  const [pullName, setPullName] = useState("");
  const [pulling, setPulling] = useState(false);
  const [progress, setProgress] = useState<PullProgress | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);

  const [detailModel, setDetailModel] = useState<OllamaModel | null>(null);
  const [detailData, setDetailData] = useState<Record<string, unknown> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Hugging Face search state
  const [hfQuery, setHfQuery] = useState("");
  const [hfResults, setHfResults] = useState<HfModel[]>([]);
  const [hfSearching, setHfSearching] = useState(false);
  const [hfError, setHfError] = useState<string | null>(null);
  const [hfSort, setHfSort] = useState<"downloads" | "likes">("downloads");
  const [hfSelectedModel, setHfSelectedModel] = useState<string | null>(null);
  const [hfFiles, setHfFiles] = useState<HfModelFile[]>([]);
  const [hfFilesLoading, setHfFilesLoading] = useState(false);
  const [hfPullingFile, setHfPullingFile] = useState<string | null>(null);
  const hfSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Model update checks go through the local agent server only.
  const [agentUrl] = useState(DEFAULT_AGENT_URL);
  const [updates, setUpdates] = useState<Record<string, ModelUpdateInfo> | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updatesError, setUpdatesError] = useState<string | null>(null);

  // Model capabilities (e.g. vision, tools)
  const [capabilities, setCapabilities] = useState<Map<string, string[]>>(new Map());

  const sortedModels = useMemo(
    () => [...models].sort((a, b) => b.size - a.size),
    [models],
  );

  // Reflect the shared pull manager's state, so an in-progress download started
  // before navigating away shows live progress again when this page remounts.
  useEffect(() => {
    return subscribePull((state) => {
      setPulling(state.pulling);
      setProgress(state.progress);
      setPullError(state.error);
    });
  }, []);

  function handlePull(name: string) {
    const target = name.trim();
    if (!target || pulling) return;
    setPullName("");
    // The manager owns the stream and survives navigation; it refreshes the
    // model list on completion even if this page has unmounted.
    void startPull(baseUrl, target, refreshModels);
  }

  const doHfSearch = useCallback(
    async (query: string, sort: string) => {
      if (!query.trim()) {
        setHfResults([]);
        setHfError(null);
        return;
      }
      setHfSearching(true);
      setHfError(null);
      try {
        const results = await searchHfModels(agentUrl, query, {
          sort,
          direction: "-1",
          limit: 24,
        });
        setHfResults(results);
      } catch (err) {
        setHfError(err instanceof Error ? err.message : "Search failed.");
        setHfResults([]);
      } finally {
        setHfSearching(false);
      }
    },
    [agentUrl],
  );

  function handleHfSearch(query: string) {
    setHfQuery(query);
    if (hfSearchTimer.current) clearTimeout(hfSearchTimer.current);
    hfSearchTimer.current = setTimeout(() => {
      void doHfSearch(query, hfSort);
    }, 400);
  }

  function handleHfSortChange(sort: "downloads" | "likes") {
    setHfSort(sort);
    if (hfQuery.trim()) void doHfSearch(hfQuery, sort);
  }

  async function handleHfSelectModel(modelId: string) {
    if (hfSelectedModel === modelId) {
      setHfSelectedModel(null);
      setHfFiles([]);
      return;
    }
    setHfSelectedModel(modelId);
    setHfFilesLoading(true);
    try {
      const data = await getHfModelFiles(agentUrl, modelId);
      setHfFiles(data.files);
    } catch {
      setHfFiles([]);
    } finally {
      setHfFilesLoading(false);
    }
  }

  async function handleHfPull(modelId: string, file: HfModelFile) {
    const pullName = file.quantization
      ? `hf.co/${modelId}:${file.quantization}`
      : `hf.co/${modelId}`;
    setHfPullingFile(file.filename);
    setPullError(null);
    setProgress(null);
    // startPull resolves only its own pull completion; failures land in the
    // pull manager's shared error state, so there's nothing to catch here.
    await startPull(baseUrl, pullName, refreshModels);
    setHfPullingFile(null);
  }

  async function openDetails(model: OllamaModel) {
    setDetailModel(model);
    setDetailData(null);
    setDetailLoading(true);
    try {
      setDetailData(await showModel(baseUrl, model.name));
    } catch (err) {
      setDetailData({ error: describeError(err) });
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleDelete(name: string) {
    setDeleting(name);
    try {
      await deleteModel(baseUrl, name);
      setConfirmDelete(null);
      await refreshModels();
    } catch (err) {
      setPullError(describeError(err));
    } finally {
      setDeleting(null);
    }
  }

  async function runUpdateCheck() {
    if (!connected || models.length === 0 || checkingUpdates) return;
    setCheckingUpdates(true);
    setUpdatesError(null);
    try {
      const results = await checkModelUpdates(agentUrl, baseUrl, models.map((m) => m.name));
      const map: Record<string, ModelUpdateInfo> = {};
      for (const result of results) map[result.name] = result;
      setUpdates(map);
    } catch {
      setUpdates(null);
      setUpdatesError("Start the agent server (bun run agent) to check for model updates.");
    } finally {
      setCheckingUpdates(false);
    }
  }

  useEffect(() => {
    void runUpdateCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, models, baseUrl, agentUrl]);

  // Fetch model capabilities (vision, tools, etc.) when models load
  useEffect(() => {
    if (!connected || models.length === 0) return;
    let cancelled = false;
    async function fetchCapabilities() {
      try {
        const caps = await getAllModelCapabilities(baseUrl, models.map((m) => m.name));
        if (!cancelled) setCapabilities(caps);
      } catch {
        // Silently fail - capabilities are optional
      }
    }
    void fetchCapabilities();
    return () => { cancelled = true; };
  }, [connected, models, baseUrl]);

  const isPulling = pulling || progress?.status === "done";

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
          <Box className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Models</h1>
          <p className="text-sm text-muted-foreground">
            Pull open models from your Ollama server and manage what's installed.
          </p>
        </div>
      </header>

      {connected === false && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Can't reach your Ollama server at {baseUrl}</p>
            <p className="mt-1 text-destructive/80">
              Start it with <code className="font-mono">ollama serve</code>, then check{" "}
              <Link to="/settings" className="underline underline-offset-2">
                Settings
              </Link>
              .
            </p>
          </div>
        </div>
      )}

      {/* Pull form */}
      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Download className="h-4 w-4" />
          </div>
          <h2 className="text-sm font-semibold">Pull a Model</h2>
        </div>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Download className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={pullName}
              onChange={(event) => setPullName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handlePull(pullName);
              }}
              placeholder="e.g. qwen2.5-coder:7b"
              className="pl-9 font-mono"
              disabled={isPulling}
            />
          </div>
          <Button onClick={() => handlePull(pullName)} disabled={isPulling || !pullName.trim()} className="shrink-0">
            {pulling ? <Spinner /> : <Download className="h-4 w-4" />}
            {pulling ? "Pulling…" : "Pull"}
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Popular:</span>
          {POPULAR.map((name) => (
            <button
              key={name}
              onClick={() => handlePull(name)}
              disabled={isPulling}
              className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:border-accent/50 hover:text-foreground disabled:opacity-50"
            >
              {name}
            </button>
          ))}
        </div>

        {progress && progress.status !== "done" && (
          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-mono text-muted-foreground">{progress.status}</span>
              {typeof progress.percent === "number" && (
                <span className="font-mono text-foreground">{progress.percent}%</span>
              )}
            </div>
            <Progress value={progress.percent ?? 0} />
          </div>
        )}
        {progress?.status === "done" && (
          <p className="mt-4 text-xs text-accent">✓ Model pulled successfully.</p>
        )}
        {pullError && <p className="mt-4 text-xs text-destructive">{pullError}</p>}
      </section>

      {/* Hugging Face browser */}
      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-700 dark:text-amber-400">
            <Star className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold">Hugging Face</h2>
            <p className="text-xs text-muted-foreground">Browse GGUF models and pull them into Ollama</p>
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={hfQuery}
              onChange={(e) => handleHfSearch(e.target.value)}
              placeholder="Search models (e.g. llama, qwen, deepseek)"
              className="pl-9 font-mono"
            />
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-background p-1">
            <button
              onClick={() => handleHfSortChange("downloads")}
              className={cn(
                "flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs transition-colors",
                hfSort === "downloads"
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <TrendingDown className="h-3 w-3" />
              Downloads
            </button>
            <button
              onClick={() => handleHfSortChange("likes")}
              className={cn(
                "flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs transition-colors",
                hfSort === "likes"
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Heart className="h-3 w-3" />
              Likes
            </button>
          </div>
        </div>

        {hfSearching && (
          <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Searching Hugging Face…
          </div>
        )}
        {hfError && <p className="mt-4 text-xs text-destructive">{hfError}</p>}

        {!hfSearching && hfResults.length > 0 && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {hfResults.map((model) => (
              <div
                key={model.id}
                className={cn(
                  "flex flex-col gap-2 rounded-xl border bg-background p-3 transition-colors",
                  hfSelectedModel === model.id ? "border-accent" : "border-border hover:border-accent/40",
                )}
              >
                <button
                  onClick={() => void handleHfSelectModel(model.id)}
                  className="text-left"
                >
                  <h3 className="truncate font-mono text-xs font-semibold hover:text-accent transition-colors">
                    {model.id}
                  </h3>
                </button>
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-0.5">
                    <TrendingDown className="h-3 w-3" /> {model.downloads.toLocaleString()}
                  </span>
                  <span className="flex items-center gap-0.5">
                    <Heart className="h-3 w-3" /> {model.likes.toLocaleString()}
                  </span>
                  {model.pipelineTag && <Badge className="text-[10px]">{model.pipelineTag}</Badge>}
                </div>

                {hfSelectedModel === model.id && (
                  <div className="mt-1 space-y-2 border-t border-border pt-2">
                    {hfFilesLoading ? (
                      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                        <Spinner /> Loading files…
                      </div>
                    ) : hfFiles.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No GGUF files found for this model.</p>
                    ) : (
                      <div className="space-y-1">
                        <p className="text-[10px] font-medium text-muted-foreground">Quantization variants:</p>
                        <div className="flex flex-wrap gap-1">
                          {hfFiles.map((file) => (
                            <button
                              key={file.filename}
                              onClick={() => void handleHfPull(model.id, file)}
                              disabled={!!pulling || hfPullingFile === file.filename}
                              className={cn(
                                "inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 font-mono text-[10px] transition-colors",
                                hfPullingFile === file.filename
                                  ? "border-accent bg-accent/10 text-accent"
                                  : "hover:border-accent/50 hover:text-foreground text-muted-foreground",
                                "disabled:opacity-50",
                              )}
                            >
                              {hfPullingFile === file.filename ? (
                                <Spinner />
                              ) : (
                                <Download className="h-2.5 w-2.5" />
                              )}
                              {file.quantization ?? file.filename.split("/").pop()}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <a
                  href={`https://huggingface.co/${model.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-accent transition-colors"
                >
                  <ExternalLink className="h-2.5 w-2.5" /> View on Hugging Face
                </a>
              </div>
            ))}
          </div>
        )}

        {!hfSearching && hfResults.length === 0 && hfQuery.trim() && !hfError && (
          <p className="mt-4 text-xs text-muted-foreground">No GGUF models found for "{hfQuery}".</p>
        )}
      </section>

      {/* Model list */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            Installed <span className="text-muted-foreground">({models.length})</span>
          </h2>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void runUpdateCheck()}
              disabled={checkingUpdates || !connected || models.length === 0}
              title="Compare installed models with the latest on the registry"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", checkingUpdates && "animate-spin")} />
              {checkingUpdates ? "Checking…" : "Check updates"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => refreshModels()} disabled={loading}>
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              Refresh
            </Button>
          </div>
        </div>
        {updatesError && (
          <p className="mb-3 text-xs text-muted-foreground">
            <CircleAlert className="mr-1 inline h-3 w-3" />
            {updatesError}
          </p>
        )}

        {loading && models.length === 0 ? (
          <div className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-border py-16 text-sm text-muted-foreground">
            <Spinner /> Loading models…
          </div>
        ) : sortedModels.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-16 text-center">
            <Box className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No models installed yet.</p>
            <p className="max-w-sm text-xs text-muted-foreground/70">
              Pull your first model above, or run <code className="font-mono">ollama pull llama3.2</code> on your
              server.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sortedModels.map((model) => (
              <div
                key={model.name}
                className="group flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 transition-colors hover:border-accent/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate font-mono text-sm font-semibold">{model.name}</h3>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {model.details?.parameter_size && (
                        <Badge className="border-accent/30 bg-accent/10 text-accent">
                          {model.details.parameter_size}
                        </Badge>
                      )}
                      {model.details?.quantization_level && <Badge>{model.details.quantization_level}</Badge>}
                      {model.details?.family && <Badge>{model.details.family}</Badge>}
                      {capabilities.get(model.name)?.filter((c) => c !== "completion").map((cap) => (
                        <Badge key={cap} className="border-blue-600/40 bg-blue-400/10 text-blue-800 dark:border-blue-400/40 dark:text-blue-300">
                          {cap}
                        </Badge>
                      ))}
                      {updates?.[model.name]?.updateAvailable && (
                        <Badge className="border-amber-600/40 bg-amber-400/10 text-amber-800 dark:border-amber-400/40 dark:text-amber-300">
                          Update available
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mt-auto space-y-1 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <HardDrive className="h-3.5 w-3.5" />
                    {formatBytes(model.size)}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span>digest</span>
                    <span className="font-mono">{shortDigest(model.digest)}</span>
                  </div>
                  <div>updated {timeAgo(model.modified_at)}</div>
                </div>

                <div className="flex items-center gap-1.5 border-t border-border pt-3">
                  {updates?.[model.name]?.updateAvailable && (
                    <Button
                      onClick={() => handlePull(model.name)}
                      disabled={isPulling}
                      className="flex h-8 flex-1 items-center justify-center gap-2 px-3 text-xs"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Update
                    </Button>
                  )}
                  <Link
                    to={`/agent?model=${encodeURIComponent(model.name)}`}
                    className="flex h-8 flex-1 items-center justify-center gap-2 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent/90"
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    Chat
                  </Link>
                  <Button size="icon" variant="outline" onClick={() => openDetails(model)} aria-label="Details">
                    <Info className="h-3.5 w-3.5" />
                  </Button>
                  {confirmDelete === model.name ? (
                    <>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setConfirmDelete(null)}
                        aria-label="Cancel delete"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="destructive"
                        onClick={() => handleDelete(model.name)}
                        disabled={deleting === model.name}
                        aria-label="Confirm delete"
                      >
                        {deleting === model.name ? <Spinner /> : <Trash2 className="h-3.5 w-3.5" />}
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={() => setConfirmDelete(model.name)}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <Modal open={!!detailModel} onClose={() => setDetailModel(null)} title={detailModel?.name}>
        {detailLoading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner /> Loading model details…
          </div>
        ) : detailData?.error ? (
          <p className="text-sm text-destructive">{String(detailData.error)}</p>
        ) : detailModel ? (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-1.5">
              {detailModel.details?.parameter_size && <Badge>{detailModel.details.parameter_size}</Badge>}
              {detailModel.details?.quantization_level && <Badge>{detailModel.details.quantization_level}</Badge>}
              {detailModel.details?.format && <Badge>{detailModel.details.format}</Badge>}
              {detailModel.details?.family && <Badge>{detailModel.details.family}</Badge>}
              <Badge>{formatBytes(detailModel.size)}</Badge>
            </div>
            {typeof detailData?.license === "string" && detailData.license && (
              <div>
                <h4 className="mb-1 text-xs font-semibold text-muted-foreground">License</h4>
                <p className="text-sm">{detailData.license}</p>
              </div>
            )}
            {typeof detailData?.modelfile === "string" && detailData.modelfile && (
              <div>
                <h4 className="mb-1 text-xs font-semibold text-muted-foreground">Modelfile</h4>
                <pre className="max-h-72 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed text-muted-foreground scrollbar-thin">
                  {detailData.modelfile}
                </pre>
              </div>
            )}
            {!detailData && <p className="text-sm text-muted-foreground">No extra metadata returned.</p>}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
