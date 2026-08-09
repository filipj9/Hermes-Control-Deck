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

## How it works

When the feature flag is enabled, Hermes Control dynamically imports the
experimental Desktop adapter instead of the default Codex CLI adapter. The
bridge reads the loopback CDP target list, connects to the visible Codex
renderer, observes its current task and approval state, and invokes the same
renderer actions a user can see in the Desktop interface. It does not use an
OpenAI API and it does not receive a stable compatibility guarantee.

Codex Desktop must remain open and its loopback CDP endpoint must remain
available while Hermes Control is using this surface. The bridge does not store
Codex account credentials. Enabling Desktop mode disables Codex CLI control for
that Hermes Control server process until the flag is turned off and the server
is restarted.

## Start Codex Desktop with loopback CDP

First open Codex Desktop normally and sign in. Keep it open while the command
below discovers its executable. The command then pauses and asks you to exit
Codex Desktop yourself. CDP launch flags are only reliable when no existing
Codex Desktop process is re-used.

Run this in a regular PowerShell window. It prefers the path of the visible
Codex process and falls back to Microsoft Store package discovery. It never
terminates the application automatically:

```powershell
$running = Get-Process ChatGPT -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and (Test-Path -LiteralPath $_.Path) } |
  Select-Object -First 1
$exe = $running.Path

if (-not $exe) {
  $package = Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($package) {
    $exe = Join-Path $package.InstallLocation "app\ChatGPT.exe"
  }
}

if (-not $exe -or -not (Test-Path -LiteralPath $exe)) {
  throw "Codex Desktop executable was not found. Open Codex Desktop and run this command again."
}

Write-Host "Codex executable: $exe"
Read-Host "Fully exit Codex Desktop, then press Enter"

if (Get-Process ChatGPT -ErrorAction SilentlyContinue) {
  throw "Codex Desktop is still running. Exit it completely and retry."
}

Start-Process -FilePath $exe -ArgumentList @(
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=4248"
)
```

The command only starts the new CDP-enabled process after confirming that the
old process is gone.

Verify that CDP is available only on loopback:

```powershell
$targets = Invoke-RestMethod -Uri "http://127.0.0.1:4248/json/list" -TimeoutSec 3
$targets |
  Where-Object { $_.type -eq "page" -and $_.url -like "app://*" } |
  Select-Object title, url, webSocketDebuggerUrl
```

At least one `app://` page with a `webSocketDebuggerUrl` must be returned. Do
not continue if the endpoint is bound to a non-loopback address.

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

The complete startup order is:

1. Fully exit any existing Codex Desktop process.
2. Start Codex Desktop with the loopback CDP PowerShell command above.
3. Confirm `http://127.0.0.1:4248/json/list` returns an `app://` target.
4. Set the experimental environment values in the local `.env`.
5. Start Hermes Control with `npm start`.
6. Sign in to the PWA and confirm the Codex runtime reports the Desktop surface.

After a Codex Desktop update, repeat the verification before relying on the
bridge. If the renderer contract no longer matches, disable the add-on and use
Codex CLI.

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
Only the authenticated Hermes Control server may be placed behind a trusted VPN
or TLS reverse proxy; port `4248` must never be proxied.
