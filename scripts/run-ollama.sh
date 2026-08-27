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
# Keep loopback as the safe default. Set OLLAMA_HOST to a private LAN
# address (or 0.0.0.0) only when direct LAN clients are intentionally enabled.
export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
export OLLAMA_ORIGINS="${OLLAMA_ORIGINS:-http://127.0.0.1:5173,http://localhost:5173}"

case "$OLLAMA_HOST" in
  127.0.0.1:*|localhost:*) ;;
  *) echo "  LAN API: $OLLAMA_HOST (protect port 11434 with a firewall)" ;;
 esac

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
echo "  API:     http://$OLLAMA_HOST"
echo "  Models:  $OLLAMA_MODELS"
exec "$OLLAMA" serve
