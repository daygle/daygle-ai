import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const localServiceProxy = {
  "/api/ollama": {
    target: "http://127.0.0.1:11434",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/ollama/, ""),
  },
  "/api/agent": {
    target: "http://127.0.0.1:8787",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/agent/, ""),
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
