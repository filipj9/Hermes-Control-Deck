# Hermes Control

> A mobile-first PWA control deck for Hermes WebUI and local Codex CLI runtimes.

<p align="center">
  <img src="docs/media/hermes-control-banner.png" alt="Hermes Control mobile control deck banner" width="100%">
</p>

<p align="center">
  <img src="docs/media/hermes-control-deck-mockup.png" alt="Hermes Control deck mockup" width="380">
</p>

Hermes Control is an event-driven control surface for monitoring and operating
AI runtimes from a browser, including a phone. It provides one normalized UI
for Hermes WebUI and Codex CLI while keeping runtime-specific integrations
behind separate adapters.

This repository is the **CLI-first open-source edition**. It is designed to be
useful as a local, single-user alpha and as a foundation for future community
development.

## Project Scope

The public edition supports:

- Hermes WebUI/backend as an external HTTP dependency;
- Codex CLI as a local child process;
- prompt submission and streamed runtime output;
- unified runtime, task, session, and event status;
- stop/cancel controls;
- Hermes sessions, profiles, approvals, models, and Kanban/task reads where
  the configured Hermes WebUI exposes compatible routes;
- Codex CLI task control, JSONL streaming, stop, continue/new actions, and
  in-memory conversation display;
- an installable mobile PWA shell with authenticated API and SSE connections.

Two optional Hermes integrations are also included, disabled by default:

- a WebSocket/TUI transport that resumes an existing Hermes Gateway session;
- an approval-event plugin transport with queued decisions and explicit ACKs.

These integrations require a compatible Hermes Agent/Gateway build. The core
Hermes WebUI + Codex CLI product does not depend on them.

The CLI-first core deliberately does **not** depend on:

- Codex Desktop integration;
- CDP or renderer automation;
- private Codex Micro events or protocols;
- application launching or workspace control through a desktop GUI;
- any private machine, IP address, password, token, or production deployment.

An optional Codex Desktop experiment is shipped in a quarantined directory and
is disabled by default. It is Windows-only, unofficial, unsupported, and may
break after any Codex Desktop update. The server dynamically imports it only
after explicit opt-in; CLI-first behavior remains the default. See
[docs/EXPERIMENTAL_CODEX_DESKTOP.md](docs/EXPERIMENTAL_CODEX_DESKTOP.md).

> Hermes Control is an independent community project. It is not sponsored by,
> endorsed by, or officially affiliated with OpenAI, Codex, Nous Research, or
> Hermes WebUI. Product names and marks belong to their respective owners.

## Status

This repository is an alpha release candidate: **v0.1.0-alpha**.

The current public tree has been checked with:

- 81 automated tests passing in the isolated release staging tree;
- JavaScript syntax checks passing for the application check list;
- local API smoke checks for health, runtimes, agents, tasks, sessions,
  approvals, and events;
- public-tree checks for secrets, machine-specific defaults, and private
  bridge imports.

See [PUBLIC_RELEASE_AUDIT.md](PUBLIC_RELEASE_AUDIT.md) for the complete local
release audit.

Two compatibility limits remain intentional:

1. Hermes WebUI is an external dependency, so its exact version and gateway
   configuration must be verified by each deployment.
2. The approval UI is wired to the normalized approval event, but not every
   `codex exec --json` version or sandbox/policy combination emits a live
   approval event. Verify the installed CLI before relying on unattended
   approval control.

## Architecture

```text
                          trusted browser or phone
                                     |
                                     v
                         +-------------------------+
                         | Hermes Control Server   |
                         | auth, API, SSE, EventBus|
                         +------------+------------+
                                      |
                    +-----------------+-----------------+
                    |                                   |
                    v                                   v
       +---------------------------+       +---------------------------+
       | Hermes Adapter            |       | Codex CLI Adapter          |
       | HTTP/SSE + optional WS    |       | local child process, JSONL |
       +-------------+-------------+       +-------------+-------------+
                     |                                   |
                     v                                   v
          Hermes WebUI/backend                         Codex CLI
          installed separately                     installed locally
```

Both adapters publish normalized domain events. The PWA consumes the control
server contract and does not need to know whether an event came from Hermes or
Codex.

## Requirements

- Node.js 20 or newer;
- a separately installed Hermes WebUI/backend, if Hermes is enabled;
- a locally installed and authenticated Codex CLI, if Codex is enabled;
- a writable workspace directory for Codex CLI;
- a trusted local network, VPN, or TLS reverse proxy for phone access.

Hermes WebUI and Codex CLI are user-owned runtime dependencies. Hermes Control
does not install, authenticate, update, or manage either runtime for you.

## Quick Start

### 1. Clone the repository

PowerShell:

```powershell
git clone https://github.com/filipj9/Hermes-Control-Deck.git
Set-Location -LiteralPath .\Hermes-Control-Deck
```

macOS or Linux:

```bash
git clone https://github.com/filipj9/Hermes-Control-Deck.git
cd Hermes-Control-Deck
```

### 2. Create a local configuration

PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS or Linux:

```bash
cp .env.example .env
```

Generate a control token and copy the output into `CONTROL_AUTH_TOKEN`:

```text
node scripts/generate-token.mjs
```

Never commit `.env`. It is intentionally ignored by Git.

### 3. Configure the runtimes

At minimum, set these values in `.env`:

```dotenv
CONTROL_AUTH_TOKEN=<random-token-at-least-32-characters>
HERMES_BASE_URL=http://127.0.0.1:8787
HERMES_PASSWORD=<your-Hermes-WebUI-password>
CODEX_MODE=cli
CODEX_SURFACE=cli
CODEX_WORKDIR=C:\path\to\your\codex\workspace
```

For macOS or Linux, use a native path for `CODEX_WORKDIR`, for example:

```dotenv
CODEX_WORKDIR=/home/you/codex-workspace
```

`CODEX_EXECUTABLE` may remain empty when `codex` is available through
`PATH`. Set an absolute executable path when you need deterministic
discovery.

The default control server is:

```text
http://127.0.0.1:4240
```

Change `CONTROL_SERVER_PORT` if that port is already used. Keep
`CONTROL_SERVER_HOST=127.0.0.1` unless the server is placed behind a
properly secured network boundary.

### 4. Start the server

```text
npm start
```

Open the printed local URL in a browser. The PWA requests the control token
and establishes an authenticated browser session.

### Updating an existing checkout

Stop the Hermes Control server, preserve your local `.env`, and update only
through a fast-forward pull:

```text
git pull --ff-only
npm install
npm run check
npm test
npm start
```

Review new keys in `.env.example` after every update and copy only the settings
you need into your existing `.env`. Updates never require committing `.env`.
The experimental Desktop add-on remains disabled unless it is explicitly
enabled again in local configuration.

## Hermes WebUI Setup

Hermes WebUI is installed separately and is not vendored into this repository.
Set `HERMES_BASE_URL` to the base URL only; keep the API prefix in
`HERMES_API_PREFIX` (default: `/api`). Set `HERMES_PASSWORD` to the
password used by the configured Hermes WebUI instance.

The Hermes adapter uses the configured WebUI contract for operations including:

- health and runtime status;
- profiles and model selection;
- session creation, listing, and loading;
- prompt submission and SSE streaming;
- stream cancellation;
- pending approval lookup and approval response;
- Kanban boards, statistics, and task reads where available.

For a compatible Hermes Gateway, the optional TUI relay can resume a selected
session and share its event stream with a terminal TUI. The optional approval
plugin can relay Gateway approval requests and return Allow/Deny decisions.
Both features require explicit opt-in configuration and separate secrets. See
[docs/HERMES_GATEWAY_TUI.md](docs/HERMES_GATEWAY_TUI.md).

Hermes Control does not modify Hermes WebUI. If a route, auth behavior, or
stream shape differs in the installed upstream version, the compatibility
matrix must be updated and the adapter contract re-tested.

## Codex CLI Setup

Codex runs locally on the machine running Hermes Control. The adapter launches
the configured CLI executable as a child process in `CODEX_WORKDIR` and reads
its JSONL output. It does not use a desktop GUI, CDP, renderer automation, or
private application events.

The CLI must be installed and authenticated separately using its official
instructions. Hermes Control does not store Codex login credentials.

Codex support includes prompt execution, streamed output, task status, stop,
new/continue actions, and normalized runtime events. Process cleanup and
concurrency limits are handled by the server adapter.

Approval behavior is runtime-dependent. The adapter and fixtures understand the
normalized approval event, but the installed CLI must actually emit that event
for a pending approval to appear. A successful fixture test is not proof that
every CLI version will produce a live approval request.

## Phone and PWA Access

The default bind is localhost-only. That is intentional.

For phone access, keep the application behind one of these boundaries:

- a trusted VPN such as a private tailnet;
- a TLS reverse proxy with an allowlist;
- a trusted LAN with explicit firewall controls.

When using a remote origin, set `CONTROL_ALLOWED_ORIGINS` to the exact browser
origin, configure TLS, and keep a strong `CONTROL_AUTH_TOKEN`. Do not expose
the server directly to the public Internet and do not use `*` for CORS.

Hermes Control does not configure Tailscale, port forwarding, firewall rules,
TLS certificates, or router settings automatically.

## Configuration Reference

Configuration is read from `.env` and process environment. The full template
is in [.env.example](.env.example). The most important values are:

| Variable | Purpose |
|---|---|
| `CONTROL_SERVER_HOST` | Server bind, default `127.0.0.1` |
| `CONTROL_SERVER_PORT` | Control server port, default `4240` |
| `CONTROL_AUTH_TOKEN` | Required local control token, minimum 32 characters |
| `CONTROL_ALLOWED_ORIGINS` | Explicit comma-separated browser origins |
| `HERMES_BASE_URL` | External Hermes WebUI base URL |
| `HERMES_PASSWORD` | Hermes WebUI password, kept in process memory |
| `HERMES_API_PREFIX` | Hermes API prefix, default `/api` |
| `HERMES_WS_ENABLED` | Enables the optional Hermes Gateway WebSocket transport |
| `HERMES_TUI_RELAY_ENABLED` | Enables the optional shared TUI relay |
| `HERMES_BRIDGE_ENABLED` | Enables the optional approval-event receiver |
| `HERMES_EXTERNAL_APPROVAL_MONITOR_ENABLED` | Enables bounded WebUI approval background polling |
| `CODEX_EXECUTABLE` | Codex CLI path, or empty for `PATH` discovery |
| `CODEX_WORKDIR` | Workspace used by local Codex CLI runs |
| `CODEX_MODEL` | Optional Codex model selection |
| `CODEX_SANDBOX` | Codex sandbox argument |
| `CODEX_EXPERIMENTAL_DESKTOP_ENABLED` | Explicitly enables the unsupported Windows Desktop experiment |
| `CODEX_APPROVAL_POLICY` | Codex approval policy |
| `CODEX_RUN_TIMEOUT_MS` | Maximum run duration |
| `CODEX_ALLOW_CONCURRENT_RUNS` | Whether multiple CLI runs may coexist |

See [CONFIGURATION.md](CONFIGURATION.md) for the complete list.

## Development and Verification

Syntax checks:

```text
npm run check
```

Automated tests:

```text
node --test tests/*.test.mjs
```

Local API smoke audit:

```text
npm run audit
```

The test suite covers the normalized EventBus, Hermes adapter contracts,
Codex CLI JSONL handling, stdout/stderr, stop/completion races, configuration,
auth token generation, and public-tree isolation.

Before publishing a change, also verify:

```text
git diff --check
git status --short
git ls-files
```

Confirm that `.env`, generated outputs, local backups, passwords, tokens, and
machine-specific paths are absent from the staged file list.

## Troubleshooting

### The control token is rejected

Check that the browser value exactly matches `CONTROL_AUTH_TOKEN` in the local
`.env`, then restart the server. Never paste that token into an issue or pull
request.

### Hermes returns 401 or stays offline

Verify `HERMES_BASE_URL`, `HERMES_API_PREFIX`, `HERMES_PASSWORD`, the
upstream health endpoint, and the auth mode of the installed Hermes WebUI.
Hermes is a separate service and must be running first.

### Codex CLI cannot be found

Run Codex directly from the configured workspace. Set `CODEX_EXECUTABLE` to an
absolute path if `PATH` discovery fails. Hermes Control does not install or
authenticate Codex.

### A prompt appears stuck

Check the runtime status and event stream, use STOP once, and inspect the
configured timeout. Restarting Hermes Control clears in-memory task and
conversation state; it does not recover a persistent CLI transcript.

### Phone cannot connect

The default server is localhost-only. Use a trusted VPN or TLS reverse proxy,
make sure the exact origin is allowed, and verify that the network path can
reach the selected port. The application does not change firewall or VPN
configuration for you.

### Approval controls stay idle

The controls require a pending normalized approval event. Some Codex CLI
versions and sandbox/policy combinations do not emit one through
`codex exec --json`. Check the installed CLI protocol before treating approval
control as available for unattended runs.

## Security and Privacy

Hermes Control is a privileged control plane. It can send prompts, stop local
processes, and forward approval decisions to configured runtimes.

Before any non-local access:

- use a strong control token;
- keep the server behind a trusted VPN or TLS proxy;
- configure explicit allowed origins;
- do not expose the default bind directly to the Internet;
- protect the Codex workspace and executable permissions;
- never commit `.env`, Hermes passwords, or runtime tokens.

The alpha release is a single-user control surface. It does not provide a
multi-user authorization model or a hardened public service boundary.

See [SECURITY.md](SECURITY.md) and [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Documentation

- [INSTALL.md](INSTALL.md) - installation and first run;
- [CONFIGURATION.md](CONFIGURATION.md) - complete environment reference;
- [COMPATIBILITY.md](COMPATIBILITY.md) - supported and unverified runtimes;
- [SECURITY.md](SECURITY.md) - security requirements and limitations;
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) - common runtime problems;
- [CONTRIBUTING.md](CONTRIBUTING.md) - contribution workflow;
- [ASSETS.md](ASSETS.md) - asset and branding notes;
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) - external notices;
- [PUBLIC_RELEASE_AUDIT.md](PUBLIC_RELEASE_AUDIT.md) - release verification;
- [docs/CLEAN_MACHINE_TEST.md](docs/CLEAN_MACHINE_TEST.md) - clean-machine test plan;
- [docs/HERMES_GATEWAY_TUI.md](docs/HERMES_GATEWAY_TUI.md) - optional Gateway/TUI and approval bridge;
- [docs/UPSTREAM_LICENSE_AUDIT.md](docs/UPSTREAM_LICENSE_AUDIT.md) - upstream audit.

## License

Project source is released under the MIT License. See [LICENSE](LICENSE).

Generated interface assets and third-party names or marks remain subject to
the policies and rights of their respective owners. See [ASSETS.md](ASSETS.md)
and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
