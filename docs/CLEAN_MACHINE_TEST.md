# Clean-machine CLI-first test

This procedure validates the public copy only. It must be run on a disposable
or explicitly approved machine, never against the private production copy.

## Preconditions

- A fresh clone of this repository.
- Node.js 20 or newer.
- A separately installed Codex CLI, already authenticated by its own CLI flow.
- A separately installed Hermes WebUI at a revision recorded in
  `docs/UPSTREAM_LICENSE_AUDIT.md`.
- Hermes WebUI configured for an explicitly supported external gateway mode if
  chat is not running in the same WebUI process.
- A private network or HTTPS reverse proxy for phone access.

## Procedure

1. Copy `.env.example` to `.env`.
2. Set a new random `CONTROL_AUTH_TOKEN`; never reuse a production token.
3. Set `CODEX_WORKDIR` to a disposable workspace and verify its permissions.
4. Set `CODEX_EXECUTABLE` only when PATH discovery is insufficient.
5. Set `HERMES_BASE_URL` to the test WebUI, `HERMES_PASSWORD` through a local
   secret mechanism, and record the WebUI revision.
6. Set `CONTROL_SERVER_HOST` to loopback for the first test.
7. Run `npm install` or the package-manager command required by the checked-in
   lockfile, then run `npm run check`, `npm test`, and `npm run audit`.
8. Run the read-only Hermes preflight:

   ```text
   node scripts/verify-hermes-upstream.mjs --base-url <test-webui-url>
   ```

   Do not add `--allow-write-test` until the read-only report is understood.
9. Start the public server and authenticate to the control API.
10. Verify both runtime health cards, list sessions/models/tasks, and connect
    to `/events`.
11. Send one short Hermes prompt and verify token, completion, error, and
    reconnect events.
12. Send one short Codex CLI prompt and verify stdout JSONL mapping, stderr
    diagnostics, completion, and STOP.
13. Trigger a disposable approval in the Codex workspace and verify allow-once,
    deny, and timeout behavior. Repeat with Hermes only if its configured
    gateway exposes approvals.
14. Restart only the public server. Verify that no Desktop bridge, CDP port,
    or private process was started and that in-memory Codex history is correctly
    reported as non-persistent.
15. For phone testing, explicitly configure an allowed origin and use HTTPS or
    a trusted private tailnet. Repeat the smoke tests from the PWA.

## Pass criteria

- No private path, IP, secret, Desktop module, CDP listener, or Micro event is
  present in the public tree or runtime process list.
- Hermes read-only preflight reports the tested routes with redacted output.
- Hermes external chat mode is confirmed, not inferred from `/health` alone.
- Codex CLI prompt, streaming events, STOP, approvals, and errors all have
  observable results.
- The report records the exact upstream revisions and the OS/runtime versions.
