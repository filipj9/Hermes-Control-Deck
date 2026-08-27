# Configuration

Configuration is read from `.env` and process environment. Never commit `.env`.

| Variable | Required | Meaning |
|---|---:|---|
| `CONTROL_SERVER_HOST` | no | default `127.0.0.1` |
| `CONTROL_SERVER_PORT` | no | default `4240` |
| `CONTROL_AUTH_TOKEN` | yes | random admin token, minimum 32 characters |
| `CONTROL_ALLOWED_ORIGINS` | no | comma-separated explicit origins |
| `CONTROL_WEB_PUSH_ENABLED` | no | enables opt-in PWA completion notifications; default false |
| `CONTROL_WEB_PUSH_PUBLIC_KEY` | with Web Push | VAPID public key exposed to the authenticated PWA |
| `CONTROL_WEB_PUSH_PRIVATE_KEY` | with Web Push | private VAPID key; server-only and never committed |
| `CONTROL_WEB_PUSH_SUBJECT` | with Web Push | HTTPS or `mailto:` VAPID contact URI |
| `CONTROL_WEB_PUSH_STATE_FILE` | no | local subscription-state path |
| `CONTROL_MAX_BODY_BYTES` | no | request body cap |
| `CONTROL_RATE_LIMIT_MAX` | no | requests per rate window and source |
| `HERMES_BASE_URL` | yes when enabled | user-owned Hermes WebUI URL |
| `HERMES_PASSWORD` | yes for password auth | kept in process memory only |
| `HERMES_API_PREFIX` | no | default `/api` |
| `HERMES_WS_ENABLED` | no | enables optional Hermes Gateway WebSocket transport |
| `HERMES_WS_URL` | when WS enabled | Gateway WebSocket endpoint |
| `HERMES_WS_SESSION_ID` | recommended for TUI | existing session to resume |
| `HERMES_TUI_RELAY_ENABLED` | no | enables one shared upstream transport for Deck and TUI |
| `HERMES_TUI_RELAY_TOKEN` | when relay enabled | separate 32+ character relay token |
| `HERMES_TUI_RELAY_UPSTREAM_WS_URL` | when relay enabled | upstream Hermes Gateway WebSocket endpoint |
| `HERMES_BRIDGE_ENABLED` | no | enables approval event/decision transport |
| `HERMES_BRIDGE_TOKEN` | when bridge enabled | separate 32+ character bridge token |
| `HERMES_BRIDGE_STATE_FILE` | no | local receiver state; defaults under ignored `.runtime/` |
| `HERMES_EXTERNAL_APPROVAL_MONITOR_ENABLED` | no | enables bounded background polling of the selected/active WebUI session |
| `CODEX_EXECUTABLE` | no | Codex executable; otherwise PATH discovery |
| `CODEX_WORKDIR` | recommended | canonical workspace for Codex CLI |
| `CODEX_MODEL` | no | model passed to supported CLI |
| `CODEX_SANDBOX` | no | CLI sandbox argument |
| `CODEX_APPROVAL_POLICY` | no | CLI approval policy |
| `CODEX_RUN_TIMEOUT_MS` | no | run deadline |
| `CODEX_STOP_TIMEOUT_MS` | no | stop/cleanup deadline |
| `CODEX_ALLOW_CONCURRENT_RUNS` | no | default false |

The public adapter always uses the CLI surface. Desktop/CDP settings are not
valid configuration in this repository.

All Gateway/TUI and approval bridge settings default to disabled. Do not reuse
`CONTROL_AUTH_TOKEN`, the Hermes WebUI password, or either bridge token for a
different purpose. The TUI and approval plugin requirements are documented in
`docs/HERMES_GATEWAY_TUI.md`.

`CODEX_WORKDIR` is intentionally empty in `.env.example` because it is a
machine-specific path. Set it to an existing workspace before enabling Codex.
The default control port is `4240`; use another port if it is already bound.
