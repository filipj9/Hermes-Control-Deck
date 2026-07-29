# Hermes Control CLI-first Public Release Audit

Date: 2026-07-29
Scope: the isolated CLI-first open-source copy only.

The private production project was not modified during this preparation.
This tree contains Hermes WebUI and Codex CLI adapters only. Codex Desktop,
CDP, renderer automation, and private Micro mechanisms are outside the release.

## Executive Result

**Prepared for an alpha GitHub upload, with two documented compatibility limits.**

- Public working tree contains no local `.env`, password, auth token, or
  machine-specific helper.
- Syntax checks: **10/10 PASS**.
- Automated contract and functional tests: **13/13 PASS**.
- API audit: **7/7 PASS** (`health`, `runtimes`, `agents`, `tasks`, `sessions`,
  `approvals`, `events`).
- `git diff --check`: **PASS**; remaining output is only Git line-ending
  normalization warnings.
- Live Codex approval delivery remains **UNVERIFIED** for the installed
  `codex exec --json` protocol. The UI and adapter contract are covered by
  fixtures, but the runtime must emit an approval event for the controls to
  have a live pending approval to resolve.

## Audit 1 — Public Tree and Secrets

Result: **PASS**

Checks performed:

- `.env` removed from the public working tree; its contents were not read.
- `.env.example` remains as the only configuration template.
- Local helper scripts containing a machine path were removed from the public
  tree.
- `backups/` is ignored by Git and is not part of the release tree.
- Tracked-file scan found no `.env`, private IP, Tailscale address, password
  value, auth token value, or Windows user path.
- The only remaining password references are environment-variable names and
  code paths that read `HERMES_PASSWORD` at runtime.

The public repository must still be checked once more after copying it to the
Git hosting client. Never add the local backup directory or a generated `.env`.

## Audit 2 — Code, Tests, and Desktop Isolation

Result: **PASS**

- Every JavaScript source in the project check list passes `node --check`.
- All repository tests pass: **13 passed, 0 failed**.
- Codex CLI fixture covers JSONL output, stderr, completion, approval shape,
  and the STOP/completion race.
- Hermes fixture covers authentication, SSE, approval, and cancellation.
- Public-source boundary test confirms no private Desktop bridge source or
  import is shipped.
- Configuration tests confirm explicit `mode=cli` and no private defaults.

The tests prove the public contract and local mocks. They do not prove that an
arbitrary external Hermes deployment or every Codex CLI version exposes the
same optional events.

## Audit 3 — Runtime and API Smoke Test

Result: **PASS**

The local audit server returned HTTP 200 for all seven public smoke checks:

| Check | Result |
|---|---|
| `health` | PASS |
| `runtimes` | PASS |
| `agents` | PASS |
| `tasks` | PASS |
| `sessions` | PASS |
| `approvals` | PASS |
| `events` | PASS |

The server was exercised without a live `.env` in the public tree; test
configuration was supplied by the test harness. A new user must create their
own `.env` from `.env.example` before starting the application.

## Audit 4 — Portability and Configuration

Result: **PASS with documented setup requirements**

- Node.js requirement is declared as `>=20`.
- Hermes URL is configured through `HERMES_BASE_URL`.
- Codex executable is discovered through `PATH` or `CODEX_EXECUTABLE`.
- `CODEX_WORKDIR` is intentionally empty in the template and must be set by
  each user to an existing workspace.
- `CONTROL_SERVER_PORT` defaults to `4240` and is configurable.
- The default bind remains `127.0.0.1`; the project does not open ports,
  configure Tailscale, or change firewall rules.
- Hermes WebUI is an external dependency and is not copied or vendored.

The clean-install path is: install Node and the user's Hermes WebUI/Codex CLI,
copy `.env.example` to `.env`, set the local values, then run `npm start`.

## Audit 5 — Security and Release Readiness

Result: **PASS for localhost single-user alpha; NOT production hardened**

Verified baseline:

- localhost bind by default;
- required control token with minimum length validation;
- explicit CORS allowlist instead of `*`;
- body, prompt, rate, concurrency, and run limits;
- dedicated Codex workdir configuration;
- path-traversal protection;
- protected API/SSE routes;
- no secrets in the public tree;
- no Desktop/CDP/Micro runtime in the public tree.

Known limitations that must remain visible in the alpha documentation:

1. Live Codex approval was not confirmed with `codex exec --json`; fixture
   support is present, but runtime support depends on the installed CLI.
2. Hermes compatibility still depends on the user's WebUI version and its
   external-chat/gateway configuration.
3. Remote phone access requires a trusted VPN or TLS reverse proxy. Do not
   expose the default server directly to an untrusted network.
4. Cookie/TLS hardening such as `Secure`, CSP, HSTS, and frame-policy headers
   should be completed before treating the server as a public multi-user
   service.

## Release Decision

The isolated tree is ready to upload as **`v0.1.0-alpha`**, provided the
GitHub upload contains only tracked release files and the README keeps the
approval and alpha limitations above. It is not being presented as a
production-hardened public service, and it does not promise Codex Desktop.

Before pushing, run:

```text
git status --short
git ls-files
node --test tests/*.test.mjs
```

Confirm that `.env` and `backups/` are absent from the staged file list.
