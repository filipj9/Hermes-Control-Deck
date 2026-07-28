# Hermes upstream audit

Audit date: 2026-07-28

This project does not vendor Hermes WebUI or Hermes Agent. The public adapter
calls a configured Hermes WebUI HTTP interface. The URLs and revisions below
are the upstream references used for this audit; they are not runtime
dependencies pinned into this repository.

## Repositories

| Project | Repository | Branch/revision inspected | License evidence |
|---|---|---|---|
| Hermes WebUI | <https://github.com/nesquena/hermes-webui> | `master`, `f6265cc96293bc9ae16ab8d8e3d8bc2dc76d231f` | `LICENSE`, MIT, copyright 2025 Hermes Web UI Contributors |
| Hermes Agent | <https://github.com/NousResearch/hermes-agent> | `main`, `e581d924299d687fd61e138ed363e6c3f289ce4d` | `LICENSE`, MIT, copyright 2025 Nous Research |

The branch heads are moving targets. A release must record the exact upstream
revision actually tested, rather than treating `master` or `main` as a stable
API version.

## License findings

- Hermes WebUI declares MIT in `LICENSE` and in `pyproject.toml`.
- Hermes Agent declares MIT in `LICENSE` and the GitHub repository metadata.
- No Hermes source is copied into this repository. The public code contains
  only an adapter and endpoint contract tests.
- `THIRD_PARTY_NOTICES.md` carries the attribution text required when shipping
  a distribution that references these projects.
- This audit does not establish permission to use Hermes, Nous Research,
  Codex, OpenAI, or other marks as logos. See `ASSETS.md`.

## Upstream API facts used by the adapter

The inspected WebUI route dispatcher contains:

- `GET /health` and `GET /api/system/health`.
- `GET /api/auth/status` and the password login route
  `POST /api/auth/login`.
- `GET /api/models`.
- Profile, session, chat, SSE, cancellation, approval, and Kanban handlers
  under `/api/*`.
- `GET /api/chat/stream/status`, `GET /api/chat/cancel`, and
  `GET /api/chat/stream`.
- `POST /api/chat/start` and `POST /api/chat`.
- `POST /api/approval/respond`; the upstream handler accepts `once`,
  `session`, `always`, and `deny`.
- `/api/kanban/*` is delegated to `api.kanban_bridge`; the route dispatcher
  does not prove that every possible Kanban subpath exists. The public
  adapter therefore treats the configured `/api/kanban/tasks` route as a
  compatibility probe and does not claim universal Kanban support.

Evidence locations in the inspected upstream WebUI:

- `api/routes.py`: route dispatcher near lines 11505-11513, 11604-11639,
  12589-12649, 14452-14455, and approval handler near 22640-22647.
- `README.md`: default in-process chat and gateway-mode notes near lines
  131-146; external gateway mode requires
  `HERMES_WEBUI_CHAT_BACKEND=gateway`.
- `LICENSE` and `pyproject.toml`: MIT declaration and project identity.

## Compatibility conclusion

The endpoint names are real upstream WebUI routes, but route availability is
not the same as a stable external API promise. The current upstream README
states that normal WebUI chat runs the agent in-process; `HERMES_API_URL` is a
Tasks/cron health probe, not the default chat transport. A clean-machine test
must therefore use an explicitly supported gateway configuration or a WebUI
build whose API behavior matches the adapter. This is a release blocker until
tested and documented.
