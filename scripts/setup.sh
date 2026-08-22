#!/bin/sh
# One-command setup for Daygle AI:
#   - checks prerequisites (bun, curl, git, tar; zstd on Linux)
#   - installs JS dependencies
#   - installs the bundled Ollama server (skips if already present)
#   - optionally pulls a model
#   - optionally installs vLLM for Hugging Face models
#
# Usage:
#   sh scripts/setup.sh                                          # full setup
#   sh scripts/setup.sh --model qwen2.5-coder:7b                 # also pull a model
#   sh scripts/setup.sh --vllm                                   # install vLLM too
#   sh scripts/setup.sh --vllm Qwen/Qwen2.5-Coder-7B-Instruct   # install + serve model
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODEL=""
VLLM_MODEL=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --model)
      shift
      MODEL="${1:-}"
      if [ -z "$MODEL" ]; then
        echo "Error: --model requires a value (e.g. --model qwen2.5-coder:7b)" >&2
        exit 1
      fi
      ;;
    --model=*)
      MODEL="${1#--model=}"
      ;;
    --vllm)
      shift
      VLLM_MODEL="${1:-}"
      ;;
    --vllm=*)
      VLLM_MODEL="${1#--vllm=}"
      ;;
    *)
      echo "Error: unknown option: $1" >&2
      echo "Usage: sh scripts/setup.sh [--model <name>] [--vllm [MODEL]]" >&2
      exit 1
      ;;
  esac
  shift
done

echo "== Daygle AI setup =="
echo ""

# --- Prerequisites ---------------------------------------------------------
echo "Checking prerequisites…"
missing=0

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "  ✗ $1 not found"
    missing=1
  else
    echo "  ✓ $1"
  fi
}

need bun
need curl
need git
need tar
if ! command -v gh >/dev/null 2>&1; then
  echo "  ✗ gh not found (needed for agent)"
  missing=1
else
  echo "  ✓ gh"
fi

OS="$(uname -s)"
if [ ! -x "$ROOT/.ollama/bin/ollama" ] && [ "$OS" = "Linux" ] && ! command -v zstd >/dev/null 2>&1; then
  echo "  ✗ zstd not found (required to extract Ollama on Linux)"
  missing=1
fi

if [ "$missing" -eq 1 ]; then
  echo ""
  echo "Install the missing tools and re-run this script:"
  echo "  bun:   curl -fsSL https://bun.sh/install | bash   (then open a new shell)"
  echo "  curl:  sudo apt-get install curl   |   brew install curl"
  echo "  zstd:  sudo apt-get install zstd   |   brew install zstd"
  echo "  git:   https://git-scm.com/downloads"
  echo "  gh:    https://cli.github.com   (on Debian, scripts/install-debian.sh installs it for you)"
  exit 1
fi
echo "  ✓ prerequisites OK"

# --- JS dependencies -------------------------------------------------------
echo ""
echo "Installing JS dependencies…"
bun install

# --- Bundled Ollama --------------------------------------------------------
echo ""
if [ -x "$ROOT/.ollama/bin/ollama" ]; then
  echo "Bundled Ollama already present - skipping download."
else
  echo "Installing bundled Ollama…"
  sh scripts/install-ollama.sh
fi

# --- Optional model pull ---------------------------------------------------
if [ -n "$MODEL" ]; then
  echo ""
  echo "Pulling model $MODEL… (first pull downloads weights; this can take a while)"
  # Start Ollama server in background for the pull, then stop it.
  OLLAMA_HOST="127.0.0.1:11434" "$ROOT/.ollama/bin/ollama" serve &
  OLLAMA_PID=$!
  sleep 2  # give the server a moment to start
  trap 'kill $OLLAMA_PID 2>/dev/null || true' EXIT
  "$ROOT/.ollama/bin/ollama" pull "$MODEL"
  kill $OLLAMA_PID 2>/dev/null || true
  trap - EXIT
fi

# --- Optional vLLM (Hugging Face models) ----------------------------------
if [ -n "$VLLM_MODEL" ]; then
  echo ""
  sh scripts/install-vllm.sh --serve "$VLLM_MODEL"
elif command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then
  if [ ! -x "$ROOT/.venv-vllm/bin/python" ]; then
    echo ""
    echo "Installing vLLM (for Hugging Face models)…"
    sh scripts/install-vllm.sh
  fi
fi

# --- Next steps ------------------------------------------------------------
echo ""
echo "== Setup complete =="
echo ""
echo " 1. bun run ollama    # start the Ollama server (models in .ollama/models/)"
echo " 2. bun run dev       # start Daygle AI, then pull a model from the Models page"
echo " 3. bun run agent     # optional: start the coding agent server for the Agent page"
if [ -x "$ROOT/.venv-vllm/bin/python" ]; then
echo " 4. vllm serve MODEL  # start a Hugging Face model (e.g. vllm serve Qwen/Qwen2.5-Coder-7B-Instruct)"
echo "    Then in Settings → Cloud Provider, set Base URL to http://127.0.0.1:8000/v1"
fi
echo ""
echo "Agent page authentication (pick one):"
echo "   - GitHub App: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, then bun run agent"
echo "   - gh CLI:     gh auth login"
echo "   - Token:      enter a GitHub token in the Settings page of the UI"
