import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  describeError,
  getVersion,
  listModels,
  normalizeBaseUrl,
  type OllamaModel,
} from "../lib/ollama";
import { isAllowedOllamaUrl, ollamaProxyUrl, toBrowserOllamaUrl } from "../lib/utils";

const STORAGE_KEY = "daygle.ollamaUrl";
// Keep the bundled Ollama on IPv4 loopback. The LAN-facing UI talks to it
// through the Vite preview proxy, so browsers never connect to Ollama directly.
const DEFAULT_URL = ollamaProxyUrl();

interface OllamaContextValue {
  baseUrl: string;
  setBaseUrl: (url: string) => void;
  connected: boolean | null;
  version: string | null;
  models: OllamaModel[];
  error: string | null;
  loading: boolean;
  checking: boolean;
  checkConnection: () => Promise<void>;
  refreshModels: () => Promise<void>;
}

const OllamaContext = createContext<OllamaContextValue | null>(null);

export function OllamaProvider({ children }: { children: ReactNode }) {
  const [baseUrl, setBaseUrlState] = useState<string>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      // Migrate a stored direct-loopback URL to the same-origin proxy path so
      // the browser never connects to Ollama directly (which breaks POST/DELETE
      // calls like model pulls on a CORS preflight).
      return stored && isAllowedOllamaUrl(stored) ? toBrowserOllamaUrl(stored) : DEFAULT_URL;
    } catch {
      return DEFAULT_URL;
    }
  });
  const [connected, setConnected] = useState<boolean | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);

  const setBaseUrl = useCallback((url: string) => {
    const normalized = normalizeBaseUrl(url);
    if (!isAllowedOllamaUrl(normalized)) {
      setError("Only the local Ollama service or the UI's /api/ollama proxy is allowed.");
      return;
    }
    // Always reach Ollama through the same-origin proxy; a direct loopback URL
    // is migrated so cross-origin pulls never hit a CORS preflight.
    const browserUrl = toBrowserOllamaUrl(normalized);
    setBaseUrlState(browserUrl);
    try {
      localStorage.setItem(STORAGE_KEY, browserUrl);
    } catch {
      // localStorage unavailable (private mode etc.) - ignore
    }
  }, []);

  const checkConnection = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const v = await getVersion(baseUrl);
      setVersion(v);
      setConnected(true);
    } catch (err) {
      setVersion(null);
      setConnected(false);
      setError(describeError(err, baseUrl));
    } finally {
      setChecking(false);
    }
  }, [baseUrl]);

  const refreshModels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listModels(baseUrl);
      setModels(list);
      setConnected(true);
    } catch (err) {
      setConnected(false);
      setError(describeError(err, baseUrl));
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await checkConnection();
      if (!cancelled) await refreshModels();
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, checkConnection, refreshModels]);

  const value = useMemo<OllamaContextValue>(
    () => ({
      baseUrl,
      setBaseUrl,
      connected,
      version,
      models,
      error,
      loading,
      checking,
      checkConnection,
      refreshModels,
    }),
    [baseUrl, setBaseUrl, connected, version, models, error, loading, checking, checkConnection, refreshModels],
  );

  return <OllamaContext.Provider value={value}>{children}</OllamaContext.Provider>;
}

export function useOllama(): OllamaContextValue {
  const ctx = useContext(OllamaContext);
  if (!ctx) {
    throw new Error("useOllama must be used within an OllamaProvider");
  }
  return ctx;
}
