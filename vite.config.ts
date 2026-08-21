import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const localServiceProxy = {
  "/api/ollama": {
    target: "http://127.0.0.1:11434",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/ollama/, ""),
    // Strip the browser Origin header so Ollama doesn't 403 on LAN IPs that
    // aren't in OLLAMA_ORIGINS (only localhost is allowed by default). The
    // proxy is the trusted same-origin boundary — Ollama is loopback-only.
    configure: (proxy: any) => {
      proxy.on("proxyReq", (proxyReq: any) => proxyReq.removeHeader("origin"));
    },
  },
  "/api/agent": {
    target: "http://127.0.0.1:8787",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/agent/, ""),
    // Same rationale: the agent's CORS allowlist only covers localhost, but
    // the proxy is the trusted boundary. Strip Origin so any LAN IP works.
    configure: (proxy: any) => {
      proxy.on("proxyReq", (proxyReq: any) => proxyReq.removeHeader("origin"));
    },
  },
};

// The UI is the only LAN-facing service. Ollama and Agent stay on loopback and
// are reached by the browser through these same-origin proxy paths.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    hmr: false,
    proxy: localServiceProxy,
  },
  preview: {
    host: "0.0.0.0",
    proxy: localServiceProxy,
  },
});
