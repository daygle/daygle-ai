#!/usr/bin/env bash
#
# Read-only preflight check for installing Daygle AI on Debian.
#
# This script does not install packages, create files, change services, or
# change network/GPU configuration. It reports blockers and warnings so it can
# be run safely on a server that already hosts other software.
#
# Usage:
#   bash scripts/check-debian.sh
#   curl -fsSL https://raw.githubusercontent.com/daygle/daygle-ai/main/scripts/check-debian.sh | bash
#
set -u

ROOT_DIR="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd 2>/dev/null || printf '%s' "")"
ERRORS=0
WARNINGS=0

if [ -t 1 ]; then
  BOLD=$'\033[1m'
  CYAN=$'\033[1;36m'
  GREEN=$'\033[1;32m'
  YELLOW=$'\033[1;33m'
  RED=$'\033[1;31m'
  RESET=$'\033[0m'
else
  BOLD=''; CYAN=''; GREEN=''; YELLOW=''; RED=''; RESET=''
fi

header() { printf '\n%s%s%s\n' "$BOLD" "$1" "$RESET"; }
ok() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { WARNINGS=$((WARNINGS + 1)); printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
fail() { ERRORS=$((ERRORS + 1)); printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"; }
info() { printf '  %s•%s %s\n' "$CYAN" "$RESET" "$1"; }

have() { command -v "$1" >/dev/null 2>&1; }

header "Daygle AI Debian preflight"
printf '  This check is read-only; it will not install or modify anything.\n'
printf '  Host: %s\n' "$(hostname 2>/dev/null || printf 'unknown')"
printf '  Time: %s\n' "$(date -Is 2>/dev/null || date)"

header "Operating system"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if [ "${ID:-}" = "debian" ] && [ "${VERSION_ID:-}" = "13" ]; then
    ok "Debian 13 (${VERSION_CODENAME:-trixie})"
  elif [ "${ID:-}" = "debian" ]; then
    warn "Detected Debian ${VERSION_ID:-unknown}, while this installer targets Debian 13"
  else
    warn "Detected ${PRETTY_NAME:-an unknown Linux distribution}; Debian 13 is the supported target"
  fi
else
  fail "Cannot read /etc/os-release"
fi

ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m 2>/dev/null || printf 'unknown')"
case "$ARCH" in
  amd64|x86_64) ok "Supported x86_64 architecture ($ARCH)" ;;
  arm64|aarch64) warn "ARM64 detected; the bundled GPU/Ollama path may differ from the x86_64 server instructions ($ARCH)" ;;
  *) fail "Unsupported or unknown architecture: $ARCH" ;;
esac

header "Resources"
if [ -r /proc/meminfo ]; then
  MEM_KIB="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || printf '0')"
  MEM_GIB=$((MEM_KIB / 1024 / 1024))
  if [ "$MEM_GIB" -ge 8 ]; then
    ok "RAM: approximately ${MEM_GIB} GiB"
  else
    warn "RAM: approximately ${MEM_GIB} GiB; small quantized models are recommended"
  fi
else
  warn "Could not read RAM information"
fi

DISK_LINE="$(df -Pk /opt 2>/dev/null | tail -n 1)"
DISK_KIB="$(printf '%s\n' "$DISK_LINE" | awk '{print $4}')"
if [ "${DISK_KIB:-0}" -gt 0 ] 2>/dev/null; then
  DISK_GIB=$((DISK_KIB / 1024 / 1024))
  if [ "$DISK_GIB" -ge 20 ]; then
    ok "Free space on /opt: approximately ${DISK_GIB} GiB"
  elif [ "$DISK_GIB" -ge 8 ]; then
    warn "Free space on /opt: approximately ${DISK_GIB} GiB; model downloads may require more"
  else
    fail "Free space on /opt is only approximately ${DISK_GIB} GiB"
  fi
else
  warn "Could not determine free space on /opt"
fi

header "Required host tools"
for tool in curl git tar zstd; do
  if have "$tool"; then
    ok "$tool is available"
  else
    warn "$tool is missing; the Debian installer will install it"
  fi
done

for tool in bun python3; do
  if have "$tool"; then
    ok "$tool is available"
  else
    warn "$tool is missing; the Debian installer will install the runtime needed by Daygle AI"
  fi
done

if have python3; then
  if python3 -m venv --help >/dev/null 2>&1; then
    ok "python3 can create virtual environments"
  else
    warn "python3-venv is missing or unusable; needed only for optional vLLM"
  fi
fi

if have gh; then
  ok "gh is available"
else
  warn "gh is missing; the Debian installer will install it for Agent GitHub operations"
fi

header "Network access"
for url in https://github.com https://bun.sh https://ollama.com; do
  if have curl && curl -fsSIL --max-time 10 "$url" >/dev/null 2>&1; then
    ok "Reachable: $url"
  else
    fail "Cannot reach: $url"
  fi
done

header "Daygle AI ports"
if have ss; then
  LISTENERS="$(ss -H -ltn 2>/dev/null || true)"
  for port in 5173 8787 11434; do
    if printf '%s\n' "$LISTENERS" | awk '{print $4}' | grep -Eq "(^|:)$port$"; then
      warn "TCP port $port is already listening; check the owning service before installation"
    else
      ok "TCP port $port is available"
    fi
  done
else
  warn "ss is unavailable; cannot check ports 5173, 8787, and 11434"
fi

if [ -n "$ROOT_DIR" ] && [ -d "$ROOT_DIR/.git" ]; then
  warn "The check is running inside an existing Daygle checkout at $ROOT_DIR"
fi
if [ -d /opt/daygle-ai ]; then
  warn "/opt/daygle-ai already exists; the installer will update/reuse that location"
else
  ok "/opt/daygle-ai is available for a fresh install"
fi

header "NVIDIA GPU"
if have nvidia-smi; then
  GPU_INFO="$(nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>/dev/null || true)"
  if [ -n "$GPU_INFO" ]; then
    ok "NVIDIA driver is responding"
    while IFS= read -r gpu; do
      [ -n "$gpu" ] && info "$gpu"
    done <<EOF
$GPU_INFO
EOF
    if printf '%s\n' "$GPU_INFO" | grep -qi 'Tesla P4'; then
      P4_DRIVER_VERSION="$(printf '%s\n' "$GPU_INFO" | awk -F',' 'tolower($1) ~ /tesla p4/ {gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}')"
      P4_DRIVER_MAJOR="${P4_DRIVER_VERSION%%.*}"
      P4_TOTAL_MEMORY="$(printf '%s\n' "$GPU_INFO" | awk -F',' 'tolower($1) ~ /tesla p4/ {gsub(/^[[:space:]]+|[[:space:]]+$/, "", $3); gsub(/[^0-9.]/, "", $3); print $3; exit}')"
      P4_USED_MEMORY="$(nvidia-smi --query-compute-apps=pid,name,used_memory --format=csv,noheader 2>/dev/null | awk -F',' '{gsub(/^[[:space:]]+|[[:space:]]+$/, "", $1); gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); gsub(/^[[:space:]]+|[[:space:]]+$/, "", $3); gsub(/[^0-9.]/, "", $3); if ($3+0 > 0) {total += $3; printf "- %s (PID %s): %s\n", $2, $1, $3}} END {printf "%.1f", total}')"
      info "Tesla P4 detected: compute capability 6.1; use bundled Ollama"
      if [ -n "$P4_DRIVER_VERSION" ] && [ "$P4_DRIVER_MAJOR" -ge 570 ] 2>/dev/null; then
        ok "Tesla P4 NVIDIA driver ${P4_DRIVER_VERSION} meets Ollama's 570+ requirement"
      else
        warn "Tesla P4 supports Ollama with NVIDIA driver 570+ (detected ${P4_DRIVER_VERSION:-unknown})"
      fi
      if [ -n "$P4_TOTAL_MEMORY" ] && [ -n "$P4_USED_MEMORY" ] && [ "$(awk -v used=\"$P4_USED_MEMORY\" -v total=\"$P4_TOTAL_MEMORY\" 'BEGIN {print ((used/total)*100) >= 50}')" = '1' ]; then
        warn "Tesla P4 has significant GPU memory in use (${P4_USED_MEMORY:-0} MiB / ${P4_TOTAL_MEMORY:-0} MiB); Ollama GPU performance may be limited or out-of-memory errors may occur while another GPU process is active"
        while IFS= read -r process_line; do
          [ -n "$process_line" ] && info "$process_line"
        done <<EOF
$(nvidia-smi --query-compute-apps=pid,name,used_memory --format=csv,noheader 2>/dev/null | awk -F',' '{gsub(/^[[:space:]]+|[[:space:]]+$/, "", $1); gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); gsub(/^[[:space:]]+|[[:space:]]+$/, "", $3); if ($3+0 > 0) printf "- %s (PID %s): %s\n", $2, $1, $3}')
EOF
      fi
      info "vLLM remains unsupported on the P4; its current GPU wheels require compute capability 7.5+"
    fi
  else
    fail "nvidia-smi is installed but cannot query the GPU/driver"
  fi
else
  warn "nvidia-smi is unavailable; Daygle AI can run CPU-only, but GPU acceleration is not ready"
fi

header "Result"
printf '\n'
if [ "$ERRORS" -eq 0 ]; then
  printf '%s%sPASS%s: no hard blockers detected (%s warning%s).\n' "$GREEN" "$BOLD" "$RESET" "$WARNINGS" "$([ "$WARNINGS" -eq 1 ] || printf 's')"
  printf 'The installer can proceed. Review warnings before starting model downloads.\n'
else
  printf '%s%sBLOCKED%s: %s error%s and %s warning%s detected.\n' "$RED" "$BOLD" "$RESET" "$ERRORS" "$([ "$ERRORS" -eq 1 ] || printf 's')" "$WARNINGS" "$([ "$WARNINGS" -eq 1 ] || printf 's')"
  printf 'Resolve the errors, then run this check again.\n'
fi

exit "$ERRORS"
