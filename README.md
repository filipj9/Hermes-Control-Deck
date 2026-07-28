# Hermes Control

Hermes Control is an alpha mobile PWA and local control server for two runtimes:

- Hermes WebUI/backend, configured as an external dependency;
- Codex CLI, executed locally on the machine running Hermes Control.

This public tree is **CLI-first**. It does not contain or support a GUI bridge,
CDP automation, private renderer mechanisms, or any other desktop-only runtime.

> Hermes Control is an independent community project. It is not officially
> endorsed by, sponsored by, or affiliated with OpenAI, Codex, Nous Research,
> or Hermes. Third-party names and marks identify compatible runtimes only.

## Status

This repository is `v0.1.0-alpha`: suitable for private clean-machine review
after configuration and testing. It is not a production security boundary yet.
Read [SECURITY.md](SECURITY.md) before exposing the server beyond localhost.

## Architecture

```text
Phone/PWA -> Hermes Control Server -> Hermes WebUI/backend
                              \----> local Codex CLI process
```

Both adapters publish the same domain events and the PWA does not need to know
which adapter produced a status or stream event.

## Quick start

1. Install a supported Node.js version and a package manager.
2. Install Hermes WebUI/backend separately and verify its own health endpoint.
3. Install and authenticate Codex CLI using its official instructions.
4. Copy `.env.example` to `.env`.
5. Set a random `CONTROL_AUTH_TOKEN` of at least 32 characters.
6. Set `HERMES_BASE_URL`, `HERMES_PASSWORD`, and optionally `CODEX_EXECUTABLE`.
7. Set `CODEX_WORKDIR` to the project workspace Codex CLI may use.
8. Run `npm start`.
9. Open the printed localhost URL. The PWA asks for the control token once and
   stores a local session preference in the browser.

See [INSTALL.md](INSTALL.md) and [CONFIGURATION.md](CONFIGURATION.md) for the
complete setup. For phone access, use a trusted LAN/VPN or a TLS reverse proxy;
do not bind to all interfaces without authentication and network controls.

## Hermes compatibility targets

There are two distinct validation targets:

- `upstream-clean`: a separately installed Hermes WebUI revision tested against
  the documented routes and external-chat configuration. The current upstream
  README says normal WebUI chat runs in-process; an external chat transport
  requires the supported gateway mode. See
  [docs/UPSTREAM_LICENSE_AUDIT.md](docs/UPSTREAM_LICENSE_AUDIT.md).
- `Hermes OS Cat deployment`: an operator-specific WebUI deployment can be
  smoke-tested separately with `scripts/verify-hermes-upstream.mjs`. Its local
  endpoint behavior is not a public default, and no private address or secret
  is part of this repository.

The read-only preflight is:

```text
node scripts/verify-hermes-upstream.mjs --base-url <test-webui-url>
```

It does not create a session, start a prompt, or cancel a stream. Those checks
require the explicit `--allow-write-test` flag and are documented in
[docs/CLEAN_MACHINE_TEST.md](docs/CLEAN_MACHINE_TEST.md).

## Supported actions

Hermes actions depend on the installed Hermes WebUI contract and include health,
profiles, sessions, prompt streaming, cancellation, approvals, models, and
Kanban/task reads where the backend exposes them.

Codex CLI actions include prompt, JSONL streaming, task status, stop, approval,
deny, new task, continue, and in-memory conversation display. CLI session
history is not promised to survive a Hermes Control restart.

There is no desktop surface or workspace-launch action in this public tree.

## Documents

- [INSTALL.md](INSTALL.md)
- [CONFIGURATION.md](CONFIGURATION.md)
- [SECURITY.md](SECURITY.md)
- [COMPATIBILITY.md](COMPATIBILITY.md)
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [ASSETS.md](ASSETS.md)
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- [docs/UPSTREAM_LICENSE_AUDIT.md](docs/UPSTREAM_LICENSE_AUDIT.md)
- [docs/CLEAN_MACHINE_TEST.md](docs/CLEAN_MACHINE_TEST.md)
- [OPEN_SOURCE_PREPARATION_REPORT.md](OPEN_SOURCE_PREPARATION_REPORT.md)

## License

Project source is released under the MIT License in [LICENSE](LICENSE).
Logos and third-party marks remain subject to their owners' policies.
