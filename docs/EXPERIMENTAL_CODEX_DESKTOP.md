# Experimental Codex Desktop Add-on

## Status and disclaimer

This integration is **Windows-only, experimental, unofficial, and
unsupported**. It is not an OpenAI API and is not affiliated with or endorsed
by OpenAI. It relies on an explicitly enabled, loopback-only Chrome DevTools
Protocol endpoint and on private renderer behavior that can change without
notice. Any Codex Desktop update may partially or completely break it.

Do not rely on this add-on for unattended, safety-critical, or production
automation. Codex CLI is the supported default surface in Hermes Control.

## Isolation guarantees

- `CODEX_EXPERIMENTAL_DESKTOP_ENABLED` defaults to `false`.
- When disabled, the Desktop modules are not dynamically imported.
- The CDP host must resolve to a loopback literal (`127.0.0.1`, `localhost`, or
  `::1`); configuration validation rejects remote hosts.
- The add-on never starts, restarts, or terminates Codex Desktop.
- No PowerShell launcher is included.
- Enabling the add-on selects Desktop as the Codex surface for this server
  process. Disable it and restart Hermes Control to return to CLI-first mode.

## Requirements

- Windows;
- Codex Desktop installed and authenticated by the user;
- a user-managed Codex Desktop instance exposing CDP on loopback;
- Node.js 20 or newer;
- a strong `CONTROL_AUTH_TOKEN` and the same trusted-network protections as the
  CLI-first server.

Hermes Control does not open the debug port. The exact command or supported
method for exposing CDP is intentionally not automated here because application
packaging and launch behavior can change between Codex Desktop releases.

## Configuration

Set the following only after starting a loopback CDP endpoint yourself:

```dotenv
CODEX_EXPERIMENTAL_DESKTOP_ENABLED=true
CODEX_EXPERIMENTAL_DESKTOP_CDP_HOST=127.0.0.1
CODEX_EXPERIMENTAL_DESKTOP_CDP_PORT=4248
CODEX_EXPERIMENTAL_DESKTOP_REQUEST_TIMEOUT_MS=6000
CODEX_EXPERIMENTAL_DESKTOP_CODEX_HOME=
CODEX_EXPERIMENTAL_DESKTOP_STATE_FILE=
```

Restart Hermes Control after changing the flag. Check `/healthz` and
`/api/runtimes`; the Codex runtime should report `surface: desktop`,
`experimental: true`, and a connected Desktop surface. If it does not, disable
the flag and return to CLI mode.

## Supported experimental controls

When the current Codex Desktop build still matches the bridge contracts, the
add-on can observe the visible task state, list visible sessions, submit a
prompt, stop the visible run, resolve the visible approval, and adjust reasoning
effort. All operations are best-effort and verify observable state before
reporting success.

## Failure and recovery

If a Codex Desktop update breaks the bridge:

1. Set `CODEX_EXPERIMENTAL_DESKTOP_ENABLED=false`.
2. Restart Hermes Control.
3. Confirm `/healthz` reports `surface: cli`.
4. Continue using Codex CLI.

Never expose the CDP port to a LAN, tailnet, or the public Internet. CDP grants
powerful control over the application renderer and must remain loopback-only.
