import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

const STORAGE_KEY = "daygle.cloudProvider";

type CloudProviderKind = "ollama" | "openai";

interface CloudProviderValue {
  kind: CloudProviderKind;
  baseUrl: string;
  apiKey: string;
  setKind: (kind: CloudProviderKind) => void;
  setBaseUrl: (baseUrl: string) => void;
  setApiKey: (apiKey: string) => void;
  save: () => void;
}

const CloudProviderContext = createContext<CloudProviderValue | null>(null);

let loadedMetadata: { kind: CloudProviderKind; baseUrl: string } | undefined;

function loadMetadata(): { kind: CloudProviderKind; baseUrl: string } {
  if (loadedMetadata) return loadedMetadata;
  loadedMetadata = { kind: "ollama", baseUrl: "" };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return loadedMetadata;
    const value = JSON.parse(raw) as { kind?: string; baseUrl?: unknown };
    // Remove keys written by older versions instead of carrying them forward.
    localStorage.removeItem(STORAGE_KEY);
    loadedMetadata = {
      kind: value.kind === "openai" ? "openai" : "ollama",
      baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
    };
  } catch {
    // Storage is optional; use the in-memory defaults.
  }
  return loadedMetadata;
}

function saveMetadata(kind: CloudProviderKind, baseUrl: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ kind, baseUrl }));
  } catch {
    // Storage is optional; the current session still retains the settings.
  }
}

export function CloudProviderProvider({ children }: { children: ReactNode }) {
  const [metadata] = useState(loadMetadata);
  const [kind, setKind] = useState<CloudProviderKind>(metadata.kind);
  const [baseUrl, setBaseUrl] = useState(metadata.baseUrl);
  const [apiKey, setApiKey] = useState("");

  const value = useMemo<CloudProviderValue>(
    () => ({
      kind,
      baseUrl,
      apiKey,
      setKind,
      setBaseUrl,
      setApiKey,
      save: () => saveMetadata(kind, baseUrl),
    }),
    [kind, baseUrl, apiKey],
  );

  return <CloudProviderContext.Provider value={value}>{children}</CloudProviderContext.Provider>;
}

export function useCloudProvider(): CloudProviderValue {
  const value = useContext(CloudProviderContext);
  if (!value) throw new Error("useCloudProvider must be used within CloudProviderProvider");
  return value;
}
