# Security Policy

## Security posture

Daygle AI exposes only the web UI on the LAN. The UI proxies requests to Ollama
and the coding agent over loopback, so Ollama and the agent are not directly
reachable from other machines. The default backend address is `127.0.0.1`; this
is intentional because it unambiguously means the local IPv4 interface,
unlike hostname resolution through `localhost`.

The agent can hold a GitHub credential. The browser may submit or replace that
credential, but the agent API never returns the credential itself. It reports
only whether one is configured, stores the file with owner-only permissions,
and redacts the configured token from returned error messages. The agent's
CORS policy also allows only the configured UI origins by default.

The LAN UI and its proxy should be placed on a trusted network. The current
agent API is a local application API, not a general-purpose multi-user
authentication boundary: anyone who can use the LAN UI can request agent
operations. Do not forward the UI through the public internet without adding
application authentication and CSRF protection.

Do not change `HOST` or `OLLAMA_HOST` to `0.0.0.0`; only the UI should be
LAN-facing. If a different topology is required, design it as a separate
security boundary with authentication and an authenticated reverse proxy.

## Supported Versions

| Version | Supported |
| --- | --- |
| `main` | :white_check_mark: |

## Reporting a Vulnerability

Please report security issues privately through the repository's security
contact or GitHub Security Advisories. Include the affected version or commit,
steps to reproduce, impact, and any suggested mitigation. Do not include live
GitHub tokens, private keys, or other credentials in a report.
