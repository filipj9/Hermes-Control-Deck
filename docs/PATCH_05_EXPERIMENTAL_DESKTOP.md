# Commit 5 — Experimental Codex Desktop hardening

## Scope

This commit affects only the explicitly enabled, unsupported Windows Codex Desktop experiment. The default Codex CLI adapter and its import boundary remain unchanged.

## What changes

- A turn managed by the JSONL SessionObserver cannot be completed by a transient disappearance of the visible STOP control.
- Matching observer terminal state remains authoritative.
- Native-only tasks retain the existing two-sample idle fallback.
- Approval buttons accept keyboard-hint suffixes used by newer Desktop builds, including `Enter`, `Return`, `Esc` and their glyph variants.
- Approval matching remains exact and rejects unrelated or ambiguous controls.

## Configuration

No new configuration is introduced. The experiment remains disabled unless all existing `CODEX_EXPERIMENTAL_DESKTOP_*` settings are intentionally configured.

## Verification

```powershell
node --test tests/codex-desktop-hardening.test.mjs tests/codex-desktop-factory.test.mjs
pnpm run check
pnpm test
```

Because Codex Desktop DOM and renderer contracts are unofficial, repeat a physical prompt, approval, STOP and session-switch test after every Desktop application update.

## Rollback

Revert this commit or disable `CODEX_EXPERIMENTAL_DESKTOP_ENABLED`. The default CLI runtime is unaffected.
