# Codex update hardening

This update keeps the supported CLI-first runtime unchanged and limits all
Codex Desktop renderer work to the disabled-by-default experimental add-on.

## Included changes

- API and SSE output remove nested credentials and raw transport data.
- Control routes validate the request hostname and browser origin before auth.
- Static file traversal and non-JSON mutation requests fail closed.
- The UI displays the active Codex model and reasoning as compact, read-only
  text, including on a narrow phone layout.
- Experimental Desktop reasoning activates and verifies the explicitly
  selected conversation before changing the current effort.
- Experimental Desktop RUN uses the composer-submit HID path, verifies one
  visible composer, rejects unknown keycaps and rejects ambiguous command
  runners.
- Terminal observer state cannot be revived by late output from an older turn.
- Hermes slow chat starts retain a bounded identity window, explicit reasoning
  fallback state, per-session WebSocket reasoning and cancelled DENY results.

## Security boundaries

- `CONTROL_SERVER_HOST` remains `127.0.0.1` by default.
- Custom proxy hostnames must be listed explicitly in `CONTROL_TRUSTED_HOSTS`.
- `CONTROL_ALLOWED_ORIGINS` remains the explicit CORS allowlist.
- The experimental CDP host remains loopback-only and the add-on remains off by
  default.
- No `.env`, key, password, token, subscription state, local path, log, backup
  or production runtime state belongs in the patch.

## Verification

Run the following from a clean checkout:

```powershell
pnpm run check
pnpm test
git diff --check
git status --short
```

When the Desktop experiment is enabled, also repeat physical session A/B
reasoning, empty RUN, prompted RUN, PROMPT, STOP, NEW and approval allow/deny
checks after every Codex Desktop update. Keep the CLI-first path enabled for the
normal public release unless the experiment is being tested intentionally.
