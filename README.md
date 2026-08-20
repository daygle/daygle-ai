# daygle

A private AI workbench that runs on **your own [Ollama](https://ollama.com)** server. Pull open-source models, manage what's installed, and test them in a streaming chat playground — no cloud, no API bill, no vendor lock-in.

Ollama is **bundled into the project**: it installs into `.ollama/` and stores models there too, so the whole thing is self-contained.

It includes a self-hosted coding agent: point it at a GitHub repo, describe a task, and it scans, edits, and opens a pull request — all driven by your local models.

## Stack

- **React 18 + TypeScript + Vite**
- **Tailwind CSS** (dark, terminal-inspired theme)
- **Framer Motion** for micro-interactions
- **React Router** (hash-based, so it works on any static host)
- Talks directly to the **Ollama REST API** from the browser

## Installation

### Prerequisites

| Tool  | Why                                           | Install                                                      |
| ----- | --------------------------------------------- | ------------------------------------------------------------ |
| **bun** | Runtime for the app, agent server, and scripts | `curl -fsSL https://bun.sh/install \| bash`                    |
| **git**  | Cloning repos and opening PRs                  | https://git-scm.com/downloads                                |
| **curl** | Downloads the bundled Ollama binary            | `sudo apt-get install curl` / `brew install curl`            |
| **zstd** | Extracts Ollama on **Linux** only              | `sudo apt-get install zstd` / `brew install zstd`            |
| **gh**   | GitHub CLI for cloning repos and opening PRs   | See below                                                    |

**Linux (Ubuntu/Debian):**

```bash
sudo apt install curl zstd git unzip
curl -fsSL https://bun.sh/install | bash
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update && sudo apt install gh
```

**macOS:**

```bash
brew install curl zstd git unzip gh
curl -fsSL https://bun.sh/install | bash
```

> **Windows:** use **WSL2** — the setup scripts target Linux/macOS. The official Ollama Windows installer also works, but then point daygle's server URL at it in **Settings**.

### Clone & Install

```bash
sudo git clone https://github.com/daygle/daygle-ai.git /opt/daygle-ai
cd /opt/daygle-ai
bun run setup --model qwen2.5-coder:7b
```

### GitHub authentication (for the Agent)

The agent needs GitHub access to clone repos and open pull requests. Authenticate with:

```bash
gh auth login
```

Pick **GitHub.com** → **HTTPS** → **Paste an authentication token**. Create a token at https://github.com/settings/tokens with `repo` scope.

### Command sandbox (recommended)

The agent runs shell commands (tests, builds, installs) inside a sandbox for safety. Install one:

**bubblewrap (preferred, lightweight):**

```bash
sudo apt install bubblewrap
```

**Docker (fallback):**

```bash
sudo apt install docker.io
```

If neither is installed, commands run directly on the host (policy-gated, but no isolation).

You also need ~2 GB of free disk for the Ollama binary and your model weights.

### Install

```bash
bun run setup                                  # checks prereqs, installs deps + bundled Ollama
bun run setup --model qwen2.5-coder:7b         # …and pulls a model right away
```

The setup script is idempotent — re-running it only installs what's missing. The equivalent manual flow is:

```bash
bun install
bun run ollama:install   # downloads Ollama into .ollama/ (Linux needs zstd)
```

### Run

```bash
bun run ollama           # terminal 1: Ollama server on http://localhost:11434
bun run dev              # terminal 2: daygle UI
bun run agent            # terminal 3: agent server (needed for Agent pages)
```

Open the printed URL — daygle defaults to `http://localhost:11434`, so it should connect to the bundled server immediately. Pull a model from the **Models** page (or `.ollama/bin/ollama pull llama3.2`).

### Auto-start on boot (systemd)

For a always-on server, install the systemd services:

```bash
sudo bash systemd/install-services.sh
```

This starts Ollama, the UI, and the agent server on boot. Manage them with:

```bash
systemctl status daygle-ollama daygle-ui daygle-agent
sudo systemctl restart daygle-ollama daygle-ui daygle-agent
journalctl -u daygle-ui -f
```

### Model recommendations

- **Chat / everyday:** `llama3.2` (light) or `qwen2.5:7b`
- **Agent (tool-calling):** `qwen2.5-coder:7b` — the best small model for structured tool calls; larger coder models (14b/32b) are stronger if you have the RAM

### Agent page

A single **Agent** page covers three ways of working, chosen by how you start:

- **Just chat** — start with no repository to talk to your local model (no file access).
- **Repo chat** — connect a repository to have a conversation with file-access tools: ask questions, request changes, get explanations, with inline command approval and write diffs.
- **Run a task → PR** — from a connected repo, hand the agent a whole task; it works autonomously (multi-step loop → self-review → QA → commit) and opens a pull request.

Conversations are saved and can be resumed from the "Recent chats" list.

## Bundled Ollama

Ollama lives inside the project:

- **Binary:** `.ollama/bin/ollama`
- **Models:** `.ollama/models/` (gitignored)
- **Server:** `bun run ollama` binds to `0.0.0.0:11434` and sets `OLLAMA_ORIGINS="*"` so the browser can reach it

> On Linux, `bun run ollama:install` requires `zstd` to extract the download — `sudo apt-get install zstd`. On Windows, use WSL2 or the official Ollama installer.

You can also point daygle at an existing Ollama elsewhere: set the URL in **Settings**. Prefer a private tunnel (Tailscale/ngrok) over exposing an unauthenticated Ollama port to the internet.

**Model updates.** The Models page compares each installed model's digest against the current registry manifest and shows an **Update available** badge with a one-click **Update** button. The check runs through the local agent server (`bun run agent`) because the Ollama registry doesn't send CORS headers the browser could use directly.

## Agent

The **Agent** page drives a local agent server that does the actual work (the browser can't clone repos or run commands).

```bash
bun run agent   # starts the agent server on http://localhost:8787
```

**Authentication** — pick one:

- **GitHub App (recommended).** Create a GitHub App with *Contents: read/write* and *Pull requests: read/write* permissions, install it on your repos, then run the agent with:

  ```bash
  export GITHUB_APP_ID="123456"
  export GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----"
  bun run agent
  ```

  The agent mints a short-lived, repo-scoped installation token for each job and creates the pull request via the GitHub API. Optionally set `GITHUB_APP_INSTALLATION_ID` to skip the install lookup.

- **`gh` CLI (fallback).** If the App env vars aren't set, the agent uses your local `gh` auth — run `gh auth login` once.

Then open **Agent** in the UI, paste a repo URL and a task (e.g. "Review the codebase for bugs and fix the most important ones"). The agent will:

1. Clone the repo into a temp directory
2. Loop over your model with tools — `list_files`, `read_file`, `search`, `write_file`, `run_command`
3. Create a branch, commit the changes, push, and open a **pull request** for you to review

The run log streams the model's output token-by-token, and a **Changes** panel shows the working-tree diff live as files are edited — new files included, with a per-file `+/-` breakdown. **Advanced options** lets you tune temperature, context window, max steps, override the system prompt per job, and enable an **AI review gate** by picking a review model: after the agent finishes, that model reviews the diff before anything is committed — if it requests changes, the agent runs up to two fix rounds, and the review is included in the pull request body.

Every job also runs a **QA verification gate** before anything is committed: it installs dependencies, auto-detects `typecheck` / `test` / `build` from `package.json` (or use the **QA command** field to override), and sends failures back to the agent for up to two fix rounds. The result is included in the pull request body.

A **Workspace** panel keeps a persistent checkout (`~/.daygle/workspaces/`): connect a repo, then **Pull**, **Commit**, **Push**, and **Open PR** right from the UI, with a live diff and working-tree status. Tick **Run in the connected workspace** on a job to have the agent work in that checkout and leave changes uncommitted for you to review and deliver manually.

> **Sandboxed commands.** The agent runs shell commands in the cloned repo on your machine. Destructive, network, and credential-accessing commands are hard-blocked; read-only inspection runs automatically; everything else (tests, builds, installs) pauses for your **Approve/Deny** click in the Agent page before it runs. Still, only point it at repos you trust and review the diff before merging.

**Cancellation & history.** A running job can be stopped from the Agent page (the **Stop** button aborts the loop and kills in-flight commands). Every run is persisted to `~/.daygle/history`, listed in the Agent page's **Run history** panel, and clickable to replay its full log.

## Sandboxing

`run_command` runs inside a container when one is available, so an untrusted repo can't touch your machine:

- **bubblewrap (preferred).** Reuses your host toolchain read-only, exposes only the repo (writable at `/work`) plus a fresh `/tmp`, and has no network. Install with `sudo apt install bubblewrap` (or `brew install bubblewrap`). If it's blocked on Ubuntu, allow unprivileged user namespaces: `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`.
- **Docker / Podman (fallback).** Runs the command in `node:22-slim` by default — set `DAYGLE_SANDBOX_IMAGE` to an image that contains the repo's toolchain.
- **Host (last resort).** If neither is available, commands run on your machine gated by the block/allow/approve policy.

Set `DAYGLE_SANDBOX_NETWORK=1` to allow network access inside the sandbox (off by default).

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_APP_ID` | — | GitHub App ID (agent auth via App) |
| `GITHUB_APP_PRIVATE_KEY` | — | GitHub App private key (agent auth via App) |
| `GITHUB_APP_INSTALLATION_ID` | — | Optional: skip the App install lookup |
| `DAYGLE_SANDBOX_NETWORK` | off | Set `1` to allow network inside the sandbox |
| `DAYGLE_SANDBOX_IMAGE` | `node:22-slim` | Docker/Podman image for sandboxed commands |
| `OLLAMA_MODELS` | `.ollama/models` | Where Ollama stores model weights |
| `OLLAMA_HOST` | `0.0.0.0:11434` | Ollama bind address |
| `OLLAMA_ORIGINS` | `*` | Allowed browser origins (required for the UI) |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Agent server bind |

## Troubleshooting

- **`Ollama is not installed`** — run `bun run ollama:install` (or `bun run setup`).
- **UI can't connect / origin errors** — make sure `bun run ollama` is running with `OLLAMA_ORIGINS="*"` (the bundled script sets this).
- **Agent page says “Agent server not running”** — start it with `bun run agent`.
- **`zstd: command not found`** (Linux) — `sudo apt-get install zstd`, then re-run setup.
- **bubblewrap fails with “Operation not permitted”** (Ubuntu) — `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`, or let it fall back to Docker.
- **Windows** — use WSL2; the scripts don't run on native Windows.

## Scripts

| Command                 | What it does                          |
| ----------------------- | ------------------------------------- |
| `bun run dev`           | Start the Vite dev server             |
| `bun run setup`         | One-command install (deps + Ollama)   |
| `bun run ollama:install`| Download Ollama into `.ollama/`       |
| `bun run ollama`        | Start the bundled Ollama server       |
| `bun run agent`         | Start the local agent server          |
| `bun run build`         | Typecheck and build static output      |
| `bun run preview`       | Preview the production build           |
| `bun run typecheck`     | `tsc -b --noEmit`                     |

## Structure

```
src/
  lib/ollama.ts            Ollama REST client (list/pull/delete/show/chat-stream)
  context/OllamaProvider   server URL, connection status, installed models
  components/              app shell + UI primitives
  pages/
    Landing.tsx            marketing page
    Models.tsx             pull / manage / inspect models
    Agent.tsx              unified agent: plain chat, repo chat (tools), or task → PR
    Settings.tsx           server URL + setup guide

agent/
  tools.ts                tool definitions (list/read/search/write/run command)
  agent.ts                the agent loop (Ollama tool-calling)
  git.ts                  clone / branch / commit / gh pr create
  github.ts               GitHub App token minting + PR API
  sandbox.ts              bubblewrap / Docker / Podman runners
  history.ts              disk-backed run history
  updates.ts              model update detection (digest comparison)
  workspace.ts            persistent repo checkout + git actions
  chat.ts                 interactive agent chat with tool-calling
  server.ts               HTTP + SSE job server
```

## Roadmap

- [x] GitHub App auth (repo-scoped tokens), with `gh` CLI fallback
- [x] Command sandboxing (block / allow / approve policy + process-group limits)
- [x] Container isolation via bubblewrap / Docker / Podman (auto-detected)
- [x] Job cancellation and persistence of past runs
- [x] Streaming model output and per-job tuning knobs
- [x] AI review gate (separate reviewer model) + enforced QA verification
- [x] Model update detection (digest comparison via the agent server)
- [x] Persistent workspace with pull / commit / push / PR actions
