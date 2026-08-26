# Commit 1 — Prompt submission safety

## Purpose

This commit prevents accidental duplicate prompts and removes the visible delay between tapping **Run** and the UI acknowledging the submission.

## What changes

- The browser acquires a synchronous submission lock before the first asynchronous operation.
- The prompt sheet closes immediately and shows a `SENDING` state.
- Each submission receives a stable client ID and unique request ID.
- The server acknowledges opted-in requests with HTTP 202 and deduplicates repeated request IDs for five minutes.
- If delivery fails before acknowledgement, the original draft is restored.
- Runtime action buttons receive a short lock against accidental double taps.

## Compatibility

The existing synchronous `/api/messages` contract remains available. Async acknowledgement is enabled only when the client sends `asyncAck: true`, so third-party clients are not forced to migrate.

## Verification

```powershell
node --test tests/prompt-submit-ui.test.mjs
pnpm run check
pnpm test
```

## Rollback

Revert this commit. No state migration or environment change is required.
