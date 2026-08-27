# Commit 4 — Opt-in Web Push for completed tasks

## Purpose

This commit adds background completion notifications for the installable Clean PWA. Notifications can arrive after the page has been suspended or closed, subject to browser and operating-system delivery rules.

## Security model

- Web Push is disabled by default.
- Subscription routes remain behind `CONTROL_AUTH_TOKEN` and additionally require same-origin browser requests.
- The VAPID private key is loaded only by the server and is never returned by an API.
- Subscription state contains browser endpoint and public subscription keys only.
- Only known Apple, Google, Mozilla and Windows browser push services are accepted.
- Notifications contain runtime name and terminal status only; prompts, responses and error details are never included.

## Configuration

Generate a VAPID key pair locally:

```powershell
pnpm exec web-push generate-vapid-keys --json
```

Copy the generated values into the local `.env`:

```dotenv
CONTROL_WEB_PUSH_ENABLED=true
CONTROL_WEB_PUSH_PUBLIC_KEY=<public-key>
CONTROL_WEB_PUSH_PRIVATE_KEY=<private-key>
CONTROL_WEB_PUSH_SUBJECT=https://github.com/your-name/Hermes-Control-Deck
```

Do not commit `.env` or either generated key.

Restart Hermes Control, open the PWA through HTTPS or localhost, then use the **Notify** control to opt in. iOS requires an installed Home Screen PWA for background Web Push.

## Verification

```powershell
node --test tests/web-push-notifications.test.mjs
pnpm run check
pnpm test
```

Verify a real notification with the PWA closed before relying on unattended delivery.

## Rollback

Revert this commit, set `CONTROL_WEB_PUSH_ENABLED=false`, restart the server and clear the browser notification permission/subscription if desired. Existing subscription state is not executable and may be deleted while the server is stopped.
