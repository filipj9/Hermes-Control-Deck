# Stability, task output and Web Push patch series

This guide describes the ordered update built on public commit `80eb366aec24f829d6b611674895d98cb857f0f1`.

## Commit order

| Order | Commit | Purpose | Detailed guide |
|---:|---|---|---|
| 1 | `47ac8f211faf09a7e67ffefbb23bf3ba53105a17` | Immediate, idempotent prompt submission | `PATCH_01_PROMPT_SAFETY.md` |
| 2 | `88c4d337c4c2a7f9af79e2cf64b21c158e452b93` | Authoritative terminal lifecycle and session refresh | `PATCH_02_LIFECYCLE_STABILITY.md` |
| 3 | `06290090028bc311b2803f84df80a0d98d06e488` | Completed-task full output reader | `PATCH_03_TASK_OUTPUT.md` |
| 4 | `d695eadbd63faa9762563701271f62799dc5751a` | Secure opt-in background Web Push | `PATCH_04_WEB_PUSH.md` |
| 5 | `09bb5b0f821ed15683dbfbdaa1965d4e8baafae1` | Optional experimental Desktop hardening | `PATCH_05_EXPERIMENTAL_DESKTOP.md` |

Apply or revert the commits in this order. The first four commits improve the supported Hermes and Codex CLI experience. Commit 5 affects only the disabled-by-default Desktop experiment.

## New installation

If this is your first Hermes Control installation, start with
[`CLEAN_INSTALLATION.md`](CLEAN_INSTALLATION.md). That walkthrough explains the
requirements, Hermes-only and Codex-only setups, the first harmless test, phone
and PWA access, normal start and stop, updates, rollback, and troubleshooting in
plain language. The commands below are the shorter checklist for users already
comfortable with Git, Node.js and a local `.env` file.

```powershell
git clone https://github.com/filipj9/Hermes-Control-Deck.git
Set-Location -LiteralPath .\Hermes-Control-Deck
Copy-Item .env.example .env
node scripts/generate-token.mjs
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm start
```

Copy the generated control token into `CONTROL_AUTH_TOKEN` in `.env`, then configure only the runtimes you use. Never commit `.env`.

For npm-only environments, use `npm install`, `npm run check`, `npm test` and `npm start`.

## Updating an existing installation

1. Stop only the Hermes Control server. Do not stop Hermes WebUI or Codex unless their own update requires it.
2. Back up `.env` and any local `data/` state.
3. Verify that the checkout has no uncommitted source changes:

```powershell
git status --short
```

4. Update and verify:

```powershell
git pull --ff-only
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm start
```

5. Hard-refresh or reopen the installed PWA so the Clean shell v2 service worker becomes active.

## Web Push setup

Web Push remains disabled unless explicitly configured. Generate VAPID keys locally:

```powershell
pnpm exec web-push generate-vapid-keys --json
```

Add the generated values to `.env` as described in `PATCH_04_WEB_PUSH.md`. Web Push requires HTTPS or localhost. On iOS, install the PWA on the Home Screen before enabling notifications.

Notifications intentionally exclude prompt text, assistant output and runtime error details. The device lock screen may still show the runtime name and terminal status.

## Experimental Desktop

No Desktop configuration is enabled by this series. The supported default remains Codex CLI. If the experiment is already enabled, repeat physical prompt, approval, STOP and session-selection tests after applying the series and after every Codex Desktop update.

## Required release verification

```powershell
git diff --check
pnpm run check
pnpm test
pnpm audit --prod
git status --short
```

Also verify:

- Hermes-only, Codex-only and combined configuration;
- prompt double-tap protection;
- terminal `RUNNING -> DONE -> READY` behavior;
- opening a completed task response;
- approval allow and deny;
- STOP during active work;
- PWA reload and background resume;
- a real Web Push notification with the PWA closed, when enabled.

## Rollback

Prefer `git revert` over destructive resets. Revert in reverse order:

If this six-commit series is still the newest change in your checkout, first
revert its documentation commit:

```powershell
git revert --no-edit HEAD
```

Then revert the five functional commits from newest to oldest:

```powershell
git revert --no-edit 09bb5b0f821ed15683dbfbdaa1965d4e8baafae1
git revert --no-edit d695eadbd63faa9762563701271f62799dc5751a
git revert --no-edit 06290090028bc311b2803f84df80a0d98d06e488
git revert --no-edit 88c4d337c4c2a7f9af79e2cf64b21c158e452b93
git revert --no-edit 47ac8f211faf09a7e67ffefbb23bf3ba53105a17
pnpm install --frozen-lockfile
pnpm run check
pnpm test
```

Do not use `HEAD` for the first command if newer unrelated commits have already
been added. In that case, find `docs: add installation and rollback guide for
the patch series` in `git log --oneline` and revert that exact commit instead.

Disable `CONTROL_WEB_PUSH_ENABLED` before reverting the Web Push commit. Browser subscriptions are inert without the server feature; users may also revoke the site notification permission.

## Public security checklist

- `.env`, VAPID keys, runtime tokens, local IP addresses and subscription state must remain untracked.
- The Desktop experiment must remain dynamically imported only after explicit opt-in.
- Push subscription changes must remain authenticated and same-origin.
- Do not include local screenshots, logs, backups or production state in a release commit.
