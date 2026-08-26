# Commit 2 — Authoritative lifecycle and session refresh

## Purpose

This commit prevents stale polling or delayed events from changing a task after it has reached a terminal state. It also ensures that a completed task visibly transitions from `DONE` to `READY` and that selecting a session refreshes the matching output.

## What changes

- Terminal task states reject delayed active events for the same turn.
- A different explicit turn may reuse an identifier without being suppressed.
- Task polling preserves a newer terminal state instead of restoring `RUNNING`.
- Active work refreshes tasks and approvals in addition to runtime health.
- Every successful terminal event schedules `DONE -> READY`.
- Approval denial becomes terminal; approval success returns to `RUNNING`.
- Session selection refreshes sessions, tasks, events and runtimes and focuses the selected conversation output.
- Runtime output is scoped to the selected runtime.

## Compatibility

The change operates on normalized runtime events and therefore applies to both Hermes and Codex CLI. The optional Desktop experiment receives a `select-session` action only when the runtime explicitly reports a Desktop surface.

## Verification

```powershell
node --test tests/ui-terminal-lifecycle.test.mjs
pnpm run check
pnpm test
```

## Rollback

Revert this commit. No persistent state schema or environment variable changes are introduced.
