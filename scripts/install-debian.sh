#!/usr/bin/env bash
#
# Daygle AI - one-line installer for a vanilla Debian 13 (trixie) machine.
#
#   curl -fsSL https://raw.githubusercontent.com/daygle/daygle-ai/main/scripts/install-debian.sh | sudo bash
#
# Installs everything from scratch: system packages, Bun, the bundled Ollama,
# the Daygle AI app (cloned + built), and systemd services for the UI, agent, and
# Ollama. Idempotent - safe to re-run to update an existing install.
#
# Configure via environment variables (pass them through sudo, e.g.
#   curl -fsSL …/install-debian.sh | sudo DAYGLE_MODEL=llama3.2 bash):
#
#   DAYGLE_DIR       install location            (default: /opt/daygle-ai)
#   DAYGLE_REPO      git repository to clone      (default: https://github.com/daygle/daygle-ai)
#   DAYGLE_REF       branch/tag/commit to check   (default: main)
#   DAYGLE_MODEL     model to pull on install     (default: qwen2.5-coder:7b; "" to skip)
#   DAYGLE_SERVICES  install systemd services     (default: 1; 0 to skip)
#
set -euo pipefail

REPO="${DAYGLE_REPO:-https://github.com/daygle/daygle-ai}"
REF="${DAYGLE_REF:-main}"
DIR="${DAYGLE_DIR:-/opt/daygle-ai}"
MODEL="${DAYGLE_MODEL:-qwen2.5-coder:7b}"
INSTALL_SERVICES="${DAYGLE_SERVICES:-1}"

# Run bun/ollama as this user (root here, matching the systemd units).
RUN_USER="root"
RUN_HOME="/root"
BUN_BIN="$RUN_HOME/.bun/bin/bun"

c_info='\033[1;36m'; c_ok='\033[1;32m'; c_warn='\033[1;33m'; c_err='\033[1;31m'; c_off='\033[0m'
log()  { printf "${c_info}==>${c_off} %s\n" "$*"; }
ok()   { printf "${c_ok}  ✓${c_off} %s\n" "$*"; }
warn() { printf "${c_warn}  !${c_off} %s\n" "$*" >&2; }
die()  { printf "${c_err}  ✗${c_off} %s\n" "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root (pipe to 'sudo bash')."

if [ -r /etc/os-release ]; then
  . /etc/os-release
  [ "${ID:-}" = "debian" ] || warn "This installer targets Debian; detected '${ID:-unknown}'. Continuing anyway."
fi

# --- 1. System packages ----------------------------------------------------
log "Installing system packages…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl git unzip zstd tar xz-utils build-essential procps
ok "base packages installed"

# GitHub CLI - used by the agent to open pull requests (optional but recommended).
if ! command -v gh >/dev/null 2>&1; then
  log "Installing GitHub CLI (gh)…"
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | tee /usr/share/keyrings/githubcli-archive-keyring.gpg >/dev/null
  chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq && apt-get install -y -qq gh || warn "gh install failed; the agent can still use a token or GitHub App."
  command -v gh >/dev/null 2>&1 && ok "gh installed"
else
  ok "gh already present"
fi

# --- 2. Bun ----------------------------------------------------------------
if [ ! -x "$BUN_BIN" ]; then
  log "Installing Bun…"
  export HOME="$RUN_HOME"
  curl -fsSL https://bun.sh/install | bash >/dev/null
  [ -x "$BUN_BIN" ] || die "Bun install did not produce $BUN_BIN"
  ok "Bun installed"
else
  ok "Bun already present"
fi
ln -sf "$BUN_BIN" /usr/local/bin/bun

# --- 3. Clone / update the app ---------------------------------------------
if [ -d "$DIR/.git" ]; then
  log "Updating existing checkout at $DIR…"
  git -C "$DIR" fetch --depth 1 origin "$REF"
  git -C "$DIR" checkout -f FETCH_HEAD
else
  log "Cloning $REPO ($REF) into $DIR…"
  install -d -m 0755 "$(dirname "$DIR")"
  git clone --depth 1 --branch "$REF" "$REPO" "$DIR" 2>/dev/null \
    || git clone --depth 1 "$REPO" "$DIR"  # fall back if REF is a commit
fi
ok "source ready at $DIR"

# --- 4. Dependencies + build ----------------------------------------------
log "Installing JS dependencies…"
( cd "$DIR" && HOME="$RUN_HOME" "$BUN_BIN" install )
ok "dependencies installed"

log "Building the web app…"
( cd "$DIR" && HOME="$RUN_HOME" "$BUN_BIN" run build )
ok "build complete"

# --- 5. Bundled Ollama -----------------------------------------------------
if [ ! -x "$DIR/.ollama/bin/ollama" ]; then
  log "Installing bundled Ollama…"
  ( cd "$DIR" && sh scripts/install-ollama.sh )
  ok "Ollama installed"
else
  ok "Ollama already present"
fi

# --- 6. systemd services ---------------------------------------------------
if [ "$INSTALL_SERVICES" = "1" ]; then
  log "Installing systemd services…"

  write_unit() { # name, contents
    printf '%s\n' "$2" > "/etc/systemd/system/$1"
  }

  write_unit daygle-ollama.service "[Unit]
Description=Daygle AI - Ollama Server
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$DIR
ExecStart=$DIR/.ollama/bin/ollama serve
Environment=HOME=$RUN_HOME
Environment=OLLAMA_HOST=127.0.0.1:11434
Environment=OLLAMA_ORIGINS=*
Environment=OLLAMA_MODELS=$DIR/.ollama/models
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target"

  write_unit daygle-agent.service "[Unit]
Description=Daygle AI - Agent Server
After=network.target daygle-ollama.service
Wants=daygle-ollama.service

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$DIR
ExecStart=$BUN_BIN run agent
Environment=HOME=$RUN_HOME
Environment=HOST=127.0.0.1
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target"

  write_unit daygle-ui.service "[Unit]
Description=Daygle AI - Web UI
After=network.target daygle-ollama.service
Wants=daygle-ollama.service

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$DIR
ExecStart=$BUN_BIN run dev
Environment=HOME=$RUN_HOME
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target"

  systemctl daemon-reload
  systemctl enable --now daygle-ollama.service daygle-agent.service daygle-ui.service
  ok "services enabled and started"
else
  warn "Skipping systemd services (DAYGLE_SERVICES=0)."
fi

# --- 7. Pull a model -------------------------------------------------------
if [ -n "$MODEL" ]; then
  log "Waiting for Ollama to come up…"
  started=""
  if [ "$INSTALL_SERVICES" != "1" ]; then
    OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MODELS="$DIR/.ollama/models" \
      "$DIR/.ollama/bin/ollama" serve >/dev/null 2>&1 &
    started=$!
  fi
  for _ in $(seq 1 60); do
    curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
    sleep 1
  done
  if curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    log "Pulling model '$MODEL' (this can take a while)…"
    OLLAMA_HOST=127.0.0.1:11434 "$DIR/.ollama/bin/ollama" pull "$MODEL" \
      && ok "model '$MODEL' ready" || warn "Model pull failed - pull later from the Models page."
  else
    warn "Ollama did not become reachable - skipping model pull."
  fi
  [ -n "$started" ] && kill "$started" 2>/dev/null || true
fi

# --- Done ------------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
: "${IP:=<server-ip>}"
printf "\n${c_ok}== Daygle AI is installed ==${c_off}\n\n"
cat <<EOF
Open the UI:        http://$IP:5173
Ollama API:         http://127.0.0.1:11434 (localhost only)
Agent server:       http://127.0.0.1:8787 (localhost only)

Service control:
  systemctl status  daygle-ui daygle-agent daygle-ollama
  journalctl -fu daygle-ui        # (or daygle-agent / daygle-ollama)
  systemctl restart daygle-ui

Note: the browser talks to Ollama and the agent directly. Both listen on
127.0.0.1 only, so the UI, chat, model pulls, and GitHub token are available
from this machine (http://localhost:5173), not from other computers. To open
PRs from the Agent page, authenticate once with:
  gh auth login   (or set a token in Settings).
EOF
