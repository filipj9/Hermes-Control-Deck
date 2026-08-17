# Installation

For the complete non-developer walkthrough, including runtime choices, a safe
first-run checklist, phone/PWA setup, updates, rollback, and troubleshooting,
use [`docs/CLEAN_INSTALLATION.md`](docs/CLEAN_INSTALLATION.md).

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

Clone the repository and enter its directory:

```powershell
git clone https://github.com/filipj9/Hermes-Control-Deck.git
Set-Location -LiteralPath .\Hermes-Control-Deck
```

Install the project dependencies:

```powershell
npm install
```

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

## Updating

Stop the running server and keep your local `.env` in place:

```powershell
git pull --ff-only
npm install
npm run check
npm test
npm start
```

Compare `.env.example` with your existing `.env` after the pull. Add newly
documented options deliberately; never replace a working `.env` blindly and
never commit it.

The optional Windows-only Codex Desktop experiment has a separate startup and
verification procedure in `docs/EXPERIMENTAL_CODEX_DESKTOP.md`. Complete and
verify the CLI-first setup before enabling it.
