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
export OLLAMA_HOST="${OLLAMA_HOST:-0.0.0.0:11434}"
export OLLAMA_ORIGINS="${OLLAMA_ORIGINS:-*}"

mkdir -p "$OLLAMA_MODELS"

echo "Starting Ollama…"
echo "  API:     http://localhost:11434"
echo "  Models:  $OLLAMA_MODELS"
exec "$OLLAMA" serve
