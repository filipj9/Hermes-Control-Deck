# Configuration

Configuration is read from `.env` and process environment. Never commit `.env`.

| Variable | Required | Meaning |
|---|---:|---|
| `CONTROL_SERVER_HOST` | no | default `127.0.0.1` |
| `CONTROL_SERVER_PORT` | no | default `4240` |
| `CONTROL_AUTH_TOKEN` | yes | random admin token, minimum 32 characters |
| `CONTROL_ALLOWED_ORIGINS` | no | comma-separated explicit origins |
| `CONTROL_MAX_BODY_BYTES` | no | request body cap |
| `CONTROL_RATE_LIMIT_MAX` | no | requests per rate window and source |
| `HERMES_BASE_URL` | yes when enabled | user-owned Hermes WebUI URL |
| `HERMES_PASSWORD` | yes for password auth | kept in process memory only |
| `HERMES_API_PREFIX` | no | default `/api` |
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

`CODEX_WORKDIR` is intentionally empty in `.env.example` because it is a
machine-specific path. Set it to an existing workspace before enabling Codex.
The default control port is `4240`; use another port if it is already bound.
