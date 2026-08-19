#!/bin/sh
# Installs Ollama into this project (./.ollama) without touching the system.
# Usage: sh scripts/install-ollama.sh [version]
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/.ollama"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

VERSION="${1:-}"
VER_PARAM="${VERSION:+?version=$VERSION}"

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

mkdir -p "$DEST"

case "$OS" in
  Linux)
    URL="https://ollama.com/download/ollama-linux-${ARCH}.tar.zst${VER_PARAM}"
    if ! command -v zstd >/dev/null 2>&1; then
      echo "zstd is required to extract Ollama on Linux." >&2
      echo "  Debian/Ubuntu: sudo apt-get install zstd" >&2
      echo "  macOS (Homebrew): brew install zstd" >&2
      exit 1
    fi
    echo "Downloading Ollama (Linux/${ARCH})…"
    curl -fsSL -o "$TMP/ollama.tar.zst" "$URL"
    zstd -dc "$TMP/ollama.tar.zst" | tar -xf - -C "$DEST"
    ;;
  Darwin)
    URL="https://ollama.com/download/ollama-darwin.tgz${VER_PARAM}"
    echo "Downloading Ollama (macOS)…"
    curl -fsSL -o "$TMP/ollama.tgz" "$URL"
    tar -xzf "$TMP/ollama.tgz" -C "$TMP"
    if [ -f "$TMP/ollama" ]; then
      mkdir -p "$DEST/bin"
      mv "$TMP/ollama" "$DEST/bin/ollama"
    elif [ -f "$TMP/bin/ollama" ]; then
      mkdir -p "$DEST"
      cp -R "$TMP/bin" "$DEST/"
    else
      echo "Could not locate the ollama binary in the archive." >&2
      exit 1
    fi
    ;;
  *)
    echo "Windows is not supported by this script. Use WSL2 or the official Ollama Windows installer." >&2
    exit 1
    ;;
esac

chmod +x "$DEST/bin/ollama" 2>/dev/null || true

echo ""
echo "✓ Ollama installed to $DEST/bin/ollama"
echo "  Start the server:   bun run ollama"
echo "  Pull a model:       $DEST/bin/ollama pull llama3.2"
