#!/bin/sh
# Starts the project-local Ollama server, storing models inside the project.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OLLAMA="$ROOT/.ollama/bin/ollama"

if [ ! -x "$OLLAMA" ]; then
  echo "Ollama is not installed. Run: bun run ollama:install" >&2
  exit 1
fi

export OLLAMA_MODELS="${OLLAMA_MODELS:-$ROOT/.ollama/models}"
# Ollama is local-only: the browser UI and agent reach it through loopback.
export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
export OLLAMA_ORIGINS="${OLLAMA_ORIGINS:-http://127.0.0.1:5173,http://localhost:5173}"

mkdir -p "$OLLAMA_MODELS"

# If a healthy Ollama is already serving on the port (e.g. the systemd unit),
# report that clearly instead of failing with a raw "address already in use".
if command -v curl >/dev/null 2>&1 && \
   curl -fsS --max-time 2 "http://127.0.0.1:11434/api/version" >/dev/null 2>&1; then
  echo "Ollama is already running on http://127.0.0.1:11434 - nothing to do."
  echo "If you didn't expect this, check: systemctl status daygle-ai-ollama"
  exit 0
fi

echo "Starting Ollama…"
echo "  API:     http://127.0.0.1:11434 (loopback only)"
echo "  Models:  $OLLAMA_MODELS"
exec "$OLLAMA" serve
