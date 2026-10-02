# Hermes Control public release audit

Date: 2026-10-02
Scope: isolated public checkout only.

The private production deployment was not modified during this preparation.
Nothing from this checkout has been pushed, released, deployed, or applied to
the production installation.

## Result

The local public branch is ready for owner review as an alpha patch candidate.

- JavaScript syntax checks: **20/20 passed**.
- Automated tests: **161/161 passed**.
- Focused Codex Desktop lifecycle and routing tests: **31/31 passed**.
- CLI-first boundary tests: **4/4 passed**.
- `git diff --check`: **passed**.
- The optional Desktop add-on remains disabled by default and quarantined from
  the supported CLI-first runtime.

These results cover deterministic tests and local fixtures. The experimental
Desktop add-on still needs physical verification after every Codex Desktop
update because renderer bundles are not a stable public API.

## Included follow-up

The candidate adds three independent fixes:

1. Bounded Hermes health requests return a structured offline state instead of
   leaving the control panel waiting indefinitely.
2. The disabled-by-default Desktop experiment recognizes the Codex
   `26.928.2636.0` renderer contracts, including split persistence assets and
   the registered `CODEX` / `composer.submit` path.
3. Background Desktop tasks retain the correct RUN, STOP, DENY, ALLOW and
   terminal state when another conversation is selected.

The public implementation does not contain the private launcher, production
ports, deployment scripts, credentials, logs, backups, or runtime state. It
does not start, stop, restart, or terminate Codex Desktop.

## Security boundary

- The server binds to `127.0.0.1` by default.
- Mutating requests require the control token and JSON content type.
- Host and origin checks fail closed unless explicitly configured.
- The Desktop CDP endpoint is restricted to loopback literals.
- `.env.example` is a template; a live `.env` must never be committed.
- Public responses sanitize credentials and raw transport payloads.
- Optional Hermes gateway and Web Push integrations remain opt-in.

This is a localhost, single-user alpha. Remote access still requires a trusted
VPN or a correctly configured TLS reverse proxy. Do not expose the default
server directly to an untrusted network.

## Compatibility limits

1. Hermes WebUI is external and deployments can expose different route and
   gateway contracts.
2. Codex CLI approval events depend on the installed CLI version and policy.
3. Codex Desktop support is Windows-only, unofficial, unsupported, and may
   break after any update.
4. Passing fixtures do not replace a physical end-to-end check of the exact
   installed Desktop build.

## Reproduce the checks

From a clean checkout with Node.js 20 or newer and dependencies installed:

```powershell
npm run check
npm test
git diff --check
git status --short
```

Before any push, inspect the complete tracked-file list and run the release
secret audit against both the working tree and generated patch artifacts.