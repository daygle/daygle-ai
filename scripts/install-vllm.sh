#!/bin/sh
# Installs vLLM into this project (./.venv-vllm) for running Hugging Face
# models locally with an OpenAI-compatible API server.
#
# Usage:
#   sh scripts/install-vllm.sh                         # install only
#   sh scripts/install-vllm.sh --serve MODEL_NAME      # install + start server
#
# Examples:
#   sh scripts/install-vllm.sh --serve Qwen/Qwen2.5-Coder-7B-Instruct
#   sh scripts/install-vllm.sh --serve meta-llama/Llama-3.1-8B-Instruct
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/.venv-vllm"
SERVE_MODEL=""
API_KEY="daygle-local"
PORT=8000

while [ "$#" -gt 0 ]; do
  case "$1" in
    --serve)
      shift
      SERVE_MODEL="${1:-}"
      if [ -z "$SERVE_MODEL" ]; then
        echo "Error: --serve requires a model name (e.g. --serve Qwen/Qwen2.5-Coder-7B-Instruct)" >&2
        exit 1
      fi
      ;;
    --serve=*)
      SERVE_MODEL="${1#--serve=}"
      ;;
    --port)
      shift
      PORT="${1:-8000}"
      ;;
    --port=*)
      PORT="${1#--port=}"
      ;;
    --api-key)
      shift
      API_KEY="${1:-daygle-local}"
      ;;
    --api-key=*)
      API_KEY="${1#--api-key=}"
      ;;
    *)
      echo "Error: unknown option: $1" >&2
      echo "Usage: sh scripts/install-vllm.sh [--serve MODEL] [--port 8000] [--api-key KEY]" >&2
      exit 1
      ;;
  esac
  shift
done

# --- Check Python -----------------------------------------------------------
if ! command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then
  echo "Error: Python 3 is required for vLLM." >&2
  echo "  Debian/Ubuntu: sudo apt-get install python3 python3-venv python3-pip" >&2
  echo "  macOS:         brew install python@3.11" >&2
  echo "  Windows (WSL): sudo apt-get install python3 python3-venv python3-pip" >&2
  exit 1
fi

PYTHON="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
PYVER="$("$PYTHON" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
echo "Python: $PYTHON ($PYVER)"

# --- Create virtual environment ---------------------------------------------
if [ ! -x "$VENV/bin/python" ]; then
  echo ""
  echo "Creating virtual environment in $VENV …"
  "$PYTHON" -m venv "$VENV"
fi

# --- Install vLLM -----------------------------------------------------------
# Check if vllm is already installed in the venv
if "$VENV/bin/python" -c "import vllm" 2>/dev/null; then
  echo "vLLM already installed — skipping."
else
  echo ""
  echo "Installing vLLM (this may take a few minutes)…"
  "$VENV/bin/pip" install --upgrade pip
  "$VENV/bin/pip" install vllm

  # Also install huggingface_hub for model downloads
  "$VENV/bin/pip" install huggingface_hub
fi

echo ""
echo "✓ vLLM installed to $VENV"

# --- Optionally serve a model -----------------------------------------------
if [ -n "$SERVE_MODEL" ]; then
  echo ""
  echo "Starting vLLM server with model: $SERVE_MODEL"
  echo "  API:  http://127.0.0.1:$PORT/v1"
  echo "  Key:  $API_KEY"
  echo ""
  echo "  Tip: Set these in Settings → Cloud Provider:"
  echo "    Base URL: http://127.0.0.1:$PORT/v1"
  echo "    API Key:  $API_KEY"
  echo ""
  echo "  Press Ctrl+C to stop the server."
  echo ""

  "$VENV/bin/python" -m vllm.entrypoints.openai.api_server \
    --model "$SERVE_MODEL" \
    --port "$PORT" \
    --api-key "$API_KEY" \
    --trust-remote-code
else
  echo ""
  echo "To serve a model, run:"
  echo "  sh scripts/install-vllm.sh --serve Qwen/Qwen2.5-Coder-7B-Instruct"
  echo ""
  echo "Or start manually:"
  echo "  $VENV/bin/python -m vllm.entrypoints.openai.api_server \\"
  echo "    --model MODEL_NAME --port $PORT --api-key $API_KEY"
fi
