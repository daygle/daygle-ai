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

const STORAGE_KEY = "daygle.ollamaUrl";
const DEFAULT_URL = "http://localhost:11434";

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
      return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_URL;
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
    setBaseUrlState(normalized);
    try {
      localStorage.setItem(STORAGE_KEY, normalized);
    } catch {
      // localStorage unavailable (private mode etc.) — ignore
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
      setError(describeError(err));
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
      setError(describeError(err));
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
