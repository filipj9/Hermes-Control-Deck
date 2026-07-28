# Troubleshooting

## Control token error

Set `CONTROL_AUTH_TOKEN` in `.env`, restart the server, then enter the same
value when the PWA asks for it. Do not paste the token into a public issue.

## Hermes offline or 401

Check `HERMES_BASE_URL`, the upstream health endpoint, `HERMES_PASSWORD`, and
the configured API prefix. Hermes is installed and authenticated separately.

## Codex CLI unavailable

Run the CLI directly in the configured workspace. Set `CODEX_EXECUTABLE` to an
absolute path if PATH discovery does not find it. The server does not install
or authenticate Codex for you.

## Prompt stuck

Check the task and event list. A run is bounded by `CODEX_RUN_TIMEOUT_MS`.
Use STOP once; then verify the child process is gone. Restarting the server
clears in-memory CLI task/conversation state.

## Phone cannot connect

The default server is localhost-only. Use a documented trusted VPN or a TLS
reverse proxy and configure the exact origin/token. This project does not
automatically change firewall, VPN or port-forwarding settings.
