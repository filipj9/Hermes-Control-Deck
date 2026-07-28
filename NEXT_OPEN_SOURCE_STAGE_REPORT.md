# Next open-source stage report

Date: 2026-07-28

Status: `READY FOR CONTROLLED CLEAN-MACHINE VALIDATION - NOT READY FOR PUBLIC RELEASE`

## Scope

This report concerns only the sibling public repository:

`work/hermes-control-open-source`

The private production repository remains outside the change set. No Desktop
bridge, CDP launcher, renderer automation, Micro event, private IP, password,
watchdog, or production runtime state is part of this tree.

## Two Hermes validation targets

### Target 1: upstream-clean

The public adapter was compared with the current upstream repositories and
their MIT notices. The exact revisions inspected are recorded in
`docs/UPSTREAM_LICENSE_AUDIT.md`.

The upstream WebUI route dispatcher contains the core route families used by
this adapter. However, the upstream README states that normal WebUI chat runs
the agent in-process. External chat requires the supported gateway mode. Route
names alone therefore do not prove that a clean installation is compatible.

### Target 2: Hermes OS Cat deployment

The operator has an existing Hermes OS Cat deployment whose chat, approval and
Kanban behavior has already been validated outside this public-copy audit. It
is a separate compatibility target, not a public default and not a source of
private configuration. Run the preflight against that deployment only when the
operator explicitly supplies the target URL and credentials through local
environment variables. Do not record its private address or secrets in this
repository.

## Completed in this stage

- Restricted Hermes adapter fallbacks to `/api/*` contracts supported by the
  inspected upstream route structure.
- Added a non-writing capability preflight that reports write-only routes as
  `not-tested` instead of falsely claiming success.
- Added `scripts/verify-hermes-upstream.mjs`; it uses GET checks by default,
  redacts the base URL path, never prints cookies/passwords, and requires
  `--allow-write-test` for session/chat/cancel checks.
- Added a local Hermes WebUI contract fixture covering auth, re-login after a
  401, profiles, sessions, models, Kanban, new session, SSE token/reasoning,
  approvals, and cancellation.
- Verified the public boundary: no desktop modules, private paths, private
  network defaults, or live `.env` were added.
- Added upstream MIT attribution and branding guidance.
- Added a clean-machine procedure that separates local mock tests from real
  Hermes and Codex runtime tests.

## Evidence

Local validation:

- Node syntax checks passed for changed JavaScript modules.
- `12` tests passed, `0` failed, including the local Hermes and Codex contract fixtures.
- The fixture binds only to an ephemeral loopback port and closes it after the
  test.
- No public remote is configured and no push was performed.

## Remaining P0 work

1. Run the read-only preflight against a clean Hermes WebUI test instance.
2. Confirm that instance is configured for the supported external chat/gateway
   path, or document that Hermes Control targets a specific WebUI fork/build.
3. Run the explicit write test against that disposable instance and verify
   session creation, short prompt, stream status, and cancellation.
4. Add a Codex CLI fixture that emits stdout JSONL, stderr, approval, exit,
   timeout, and failure events on each supported OS.
5. Run the documented clean-machine install on a second machine.
6. Complete the browser/PWA mobile smoke test through a private HTTPS or
   trusted tailnet boundary.
7. Resolve the project copyright-holder decision in `LICENSE` before public
   publication; the current contributor wording is a legal-review placeholder.
8. Generate release asset checksums and decide which unused mock/source variants
   belong in the public artifact.

## Release gate

The repository is suitable for controlled validation and code review. It is not
yet a public alpha release because the real clean-machine Hermes transport,
Codex CLI protocol, security boundary, and legal/branding review remain open.

Recommended next command, with no write side effects:

```text
node scripts/verify-hermes-upstream.mjs --base-url <disposable-hermes-webui-url>
```

Only after inspecting that output should an operator intentionally run:

```text
HERMES_PASSWORD=<local-secret> node scripts/verify-hermes-upstream.mjs --base-url <url> --allow-write-test --confirm-private-host
```

Do not use that second command against production unless the operator accepts
that it creates a session, starts a short chat, and cancels the resulting
stream.
