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

## Getting started

```bash
bun install
bun run ollama:install   # downloads Ollama into .ollama/ (Linux needs zstd)
bun run ollama           # starts it on http://localhost:11434
bun run agent            # starts the agent server on http://localhost:8787
bun run dev              # starts the daygle UI
```

Open the printed URL — daygle defaults to `http://localhost:11434`, so it should connect to the bundled server immediately. Pull a model from the **Models** page (or `.ollama/bin/ollama pull llama3.2`).

## Bundled Ollama

Ollama lives inside the project:

- **Binary:** `.ollama/bin/ollama`
- **Models:** `.ollama/models/` (gitignored)
- **Server:** `bun run ollama` binds to `0.0.0.0:11434` and sets `OLLAMA_ORIGINS="*"` so the browser can reach it

> On Linux, `bun run ollama:install` requires `zstd` to extract the download — `sudo apt-get install zstd`. On Windows, use WSL2 or the official Ollama installer.

You can also point daygle at an existing Ollama elsewhere: set the URL in **Settings**. Prefer a private tunnel (Tailscale/ngrok) over exposing an unauthenticated Ollama port to the internet.

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

> **Sandboxed commands.** The agent runs shell commands in the cloned repo on your machine. Destructive, network, and credential-accessing commands are hard-blocked; read-only inspection runs automatically; everything else (tests, builds, installs) pauses for your **Approve/Deny** click in the Agent page before it runs. Still, only point it at repos you trust and review the diff before merging.

**Cancellation & history.** A running job can be stopped from the Agent page (the **Stop** button aborts the loop and kills in-flight commands). Every run is persisted to `~/.daygle/history`, listed in the Agent page's **Run history** panel, and clickable to replay its full log.

## Sandboxing

`run_command` runs inside a container when one is available, so an untrusted repo can't touch your machine:

- **bubblewrap (preferred).** Reuses your host toolchain read-only, exposes only the repo (writable at `/work`) plus a fresh `/tmp`, and has no network. Install with `sudo apt install bubblewrap` (or `brew install bubblewrap`). If it's blocked on Ubuntu, allow unprivileged user namespaces: `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`.
- **Docker / Podman (fallback).** Runs the command in `node:22-slim` by default — set `DAYGLE_SANDBOX_IMAGE` to an image that contains the repo's toolchain.
- **Host (last resort).** If neither is available, commands run on your machine gated by the block/allow/approve policy.

Set `DAYGLE_SANDBOX_NETWORK=1` to allow network access inside the sandbox (off by default).

## Scripts

| Command                 | What it does                          |
| ----------------------- | ------------------------------------- |
| `bun run dev`           | Start the Vite dev server             |
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
    Chat.tsx               streaming chat playground
    Agent.tsx              repo agent: task in, pull request out
    Settings.tsx           server URL + setup guide

agent/
  tools.ts                tool definitions (list/read/search/write/run command)
  agent.ts                the agent loop (Ollama tool-calling)
  git.ts                  clone / branch / commit / gh pr create
  github.ts               GitHub App token minting + PR API
  sandbox.ts              bubblewrap / Docker / Podman runners
  history.ts              disk-backed run history
  server.ts               HTTP + SSE job server
```

## Roadmap

- [x] GitHub App auth (repo-scoped tokens), with `gh` CLI fallback
- [x] Command sandboxing (block / allow / approve policy + process-group limits)
- [x] Container isolation via bubblewrap / Docker / Podman (auto-detected)
- [x] Job cancellation and persistence of past runs
