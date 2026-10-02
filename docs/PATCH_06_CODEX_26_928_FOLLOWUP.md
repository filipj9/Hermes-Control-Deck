# Patch 06: Codex 26.928 compatibility follow-up

This patch is an isolated update for the optional Codex Desktop experiment and
for bounded Hermes health reporting. The supported CLI-first adapter remains
the default.

## Changes

- Hermes health requests use a configurable short timeout and expose a clear
  remote-offline state without hiding the runtime.
- The Desktop compatibility probe recognizes the split `app-initial` and
  `app-shared` persistence layout observed in Codex Desktop
  `26.928.2636.0` / internal version `26.928.21956`.
- RUN resolves the registered `CODEX` keycap and `composer.submit` command,
  waits for the selected conversation's visible composer, and fails closed on
  ambiguous renderer contracts.
- Reasoning remains tied to the explicitly selected conversation.
- Session observation reads the requested background conversation and keeps
  STOP, denied approvals and terminal results authoritative.

## Public boundary

The patch does not include a launcher, automatic application management,
production ports, local paths, credentials, logs, backups, or deployment
state. The experiment stays disabled by default and accepts only a loopback
CDP endpoint managed by the user.

## Verification

The isolated candidate passed:

- 20/20 JavaScript syntax checks;
- 161/161 repository tests;
- 31/31 focused Desktop lifecycle, routing and public-boundary tests.

Repeat physical NEW, session selection, reasoning, empty RUN, prompted RUN,
PROMPT, STOP, approval allow and approval deny checks after every Codex Desktop
update. Renderer compatibility is observed behavior, not a stable API promise.

## Rollback

Revert this follow-up's commits in reverse order or apply the generated series
patch with `git apply -R`. Keep the CLI-first configuration enabled while the
experimental path is unavailable.
