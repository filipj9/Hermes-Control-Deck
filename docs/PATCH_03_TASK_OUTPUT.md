# Commit 3 — Completed task output reader

## Purpose

Completed tasks should remain useful after the live stream ends. This commit turns task rows into read-only response links and keeps a small, bounded response history in the browser.

## What changes

- Completed and failed task rows can be opened without invoking any runtime action.
- The selected response is focused in the existing Runtime Output panel.
- The task navigation button shows an unread completion badge.
- Up to 20 completion summaries are retained for seven days.
- Full output is retained only for the newest eight entries; older entries keep summaries only.
- If browser storage is unavailable or full, the UI falls back to summary-only persistence.

## Privacy

Saved responses use same-origin browser `localStorage`. They are not sent to a new server or third party. Users on shared devices should clear site data when response persistence is not appropriate.

## Verification

```powershell
node --test tests/completion-notice-ui.test.mjs
pnpm run check
pnpm test
```

## Rollback

Revert this commit. Existing browser completion entries become unused and may be removed by clearing site data.
