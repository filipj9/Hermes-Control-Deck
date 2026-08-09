# Installation

## Requirements

- Node.js version listed in `COMPATIBILITY.md`;
- a supported package manager;
- a separately installed Hermes WebUI/backend;
- a locally installed and authenticated Codex CLI;
- a workspace directory accessible to the Codex CLI process;
- a trusted local network or VPN for phone access.

The supported baseline is Node.js 20 or newer. Exact Hermes WebUI and Codex
CLI compatibility still depends on the runtime versions and must be recorded
in the clean-machine test report before a public alpha release.

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

The default server port is `4240`; change `CONTROL_SERVER_PORT` when another
local service already uses it. Keep `CODEX_WORKDIR` on a workspace intended
for Codex CLI runs and never publish `.env`.

Start:

```powershell
npm start
```

The default bind is `127.0.0.1:4240`. No ports are automatically opened,
forwarded, or exposed by this project.

The optional Hermes Gateway/TUI and approval-event integrations are installed
separately after the base WebUI + Codex CLI setup is verified. They are not
required for first run. See `docs/HERMES_GATEWAY_TUI.md`.
