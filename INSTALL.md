# Installation

## Requirements

- Node.js version listed in `COMPATIBILITY.md`;
- a supported package manager;
- a separately installed Hermes WebUI/backend;
- a locally installed and authenticated Codex CLI;
- a workspace directory accessible to the Codex CLI process;
- a trusted local network or VPN for phone access.

Exact upstream Hermes and CLI versions must be confirmed before a public alpha
release. The current repository deliberately does not guess them.

## Setup

```powershell
Copy-Item .env.example .env
```

Set at least:

```text
CONTROL_AUTH_TOKEN=<random 32+ character token>
HERMES_BASE_URL=http://127.0.0.1:8787
HERMES_PASSWORD=<Hermes password>
CODEX_WORKDIR=C:\path\to\workspace
```

`CODEX_EXECUTABLE` may be empty when `codex` is discoverable through PATH. An
absolute executable path is recommended for reproducible deployments.

Start:

```powershell
npm start
```

The default bind is `127.0.0.1:4240`. No ports are automatically opened,
forwarded, or exposed by this project.
