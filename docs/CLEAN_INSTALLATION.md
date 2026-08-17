# Hermes Control Clean — installation from zero to ready

This guide is for people who already have Hermes WebUI and/or Codex CLI on
their computer and want to add the Hermes Control Clean browser deck.

Hermes Control does not replace, update, restart, or reconfigure Hermes or
Codex. It connects to the runtimes you explicitly enable in a local `.env`
file. Start with the local computer only. Add phone access after the local
installation works.

## What you will have at the end

- the white Clean control deck running in a browser;
- Codex CLI and Hermes WebUI shown as separate runtime panels;
- prompts, sessions, tasks, live output, approvals, STOP, and reasoning controls
  where the installed runtime exposes the required capability;
- an optional installable PWA on a phone;
- no change to your existing Hermes or Codex installation.

## Before you start

You need:

1. Git.
2. Node.js 20 or newer.
3. Hermes WebUI already running if you want to control Hermes.
4. Codex CLI already installed and authenticated if you want to control Codex.
5. One existing folder that Codex may use as its workspace.

Check the local tools.

PowerShell:

```powershell
git --version
node --version
codex --version
```

Linux, WSL, or macOS:

```bash
git --version
node --version
codex --version
```

`node --version` must report version 20 or newer. If you use only Hermes, the
Codex command may be unavailable; disable Codex in the configuration described
below. If you use only Codex, disable Hermes.

## 1. Download Hermes Control

Choose a normal folder for source projects. Do not clone the repository into a
Hermes state directory, a Codex configuration directory, or a folder containing
secrets.

PowerShell:

```powershell
git clone https://github.com/filipj9/Hermes-Control-Deck.git
Set-Location -LiteralPath .\Hermes-Control-Deck
```

Linux, WSL, or macOS:

```bash
git clone https://github.com/filipj9/Hermes-Control-Deck.git
cd Hermes-Control-Deck
```

## 2. Install the application dependencies

The project has no build step. Install the locked JavaScript dependencies:

```text
npm install
```

This installs dependencies only inside the cloned Hermes Control folder. It
does not install or modify Hermes Agent, Hermes WebUI, or Codex CLI.

## 3. Create the private local configuration

Copy the public template to `.env`.

PowerShell:

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
```

Linux, WSL, or macOS:

```bash
cp .env.example .env
```

Generate a new control token:

```text
node scripts/generate-token.mjs
```

Copy the generated value. It is the private password for your control deck.
Never post it in an issue, screenshot, chat, log, or commit.

Open `.env` in a text editor.

PowerShell example:

```powershell
notepad .env
```

Keep `.env` on this computer only. The repository already ignores it, but you
should still check `git status --short` before every commit.

## 4. Configure the simple CLI-first setup

For the first run, leave every optional bridge, relay, WebSocket, and Desktop
experiment disabled. The base product needs only Hermes WebUI HTTP and/or local
Codex CLI.

Use the following values as a checklist. Replace every value inside angle
brackets with your own local value. Do not keep the angle brackets.

```dotenv
CONTROL_SERVER_HOST=127.0.0.1
CONTROL_SERVER_PORT=4240
CONTROL_AUTH_TOKEN=<paste-the-new-generated-token>
CONTROL_ALLOWED_ORIGINS=

HERMES_ENABLED=true
HERMES_BASE_URL=<your-Hermes-WebUI-base-URL>
HERMES_AUTH_MODE=password
HERMES_PASSWORD=<your-Hermes-WebUI-password>
HERMES_API_PREFIX=/api
HERMES_WS_ENABLED=false
HERMES_WS_URL=
HERMES_TUI_RELAY_ENABLED=false
HERMES_BRIDGE_ENABLED=false
HERMES_EXTERNAL_APPROVAL_MONITOR_ENABLED=false

CODEX_ENABLED=true
CODEX_MODE=cli
CODEX_SURFACE=cli
CODEX_EXECUTABLE=
CODEX_WORKDIR=<absolute-path-to-your-Codex-workspace>
CODEX_SANDBOX=workspace-write
CODEX_APPROVAL_POLICY=on-request
CODEX_ALLOW_CONCURRENT_RUNS=false
CODEX_EXPERIMENTAL_DESKTOP_ENABLED=false

EVENT_STORE_DRIVER=memory
```

Important rules:

- `HERMES_BASE_URL` is the WebUI base URL, without `/api` at the end.
- `HERMES_PASSWORD` is the password accepted by that WebUI.
- `CODEX_WORKDIR` must be an existing folder where Codex is allowed to work.
- Leave `CODEX_EXECUTABLE` empty when `codex` works in the same terminal.
- Otherwise, set `CODEX_EXECUTABLE` to the absolute Codex CLI executable path.
- Keep the optional WebSocket, TUI relay, approval bridge, and Desktop
  experiment disabled until the base setup passes.

### Hermes only

Use:

```dotenv
HERMES_ENABLED=true
CODEX_ENABLED=false
```

The Codex workspace and executable may remain empty.

### Codex only

Use:

```dotenv
HERMES_ENABLED=false
CODEX_ENABLED=true
```

The Hermes URL and password may remain empty.

### Hermes and Codex together

Keep both `HERMES_ENABLED=true` and `CODEX_ENABLED=true`, then configure both
runtime sections.

## 5. Verify the configuration before starting

Run the syntax and automated tests:

```text
npm run check
npm test
```

Both commands must finish successfully. These tests do not send a real prompt
to your runtimes.

Confirm that the private configuration is not tracked:

```text
git status --short
git check-ignore .env
```

The second command should print `.env`. The first command must not list `.env`.

## 6. Start Hermes Control Clean

From the repository folder, run:

```text
npm start
```

Keep this terminal open. The final lines show the local Hermes Control URL.
Open that URL in a browser on the same computer.

On the first visit, enter the control token generated in step 3. This creates a
browser session cookie. The token is not your Hermes password and must not be
reused as one.

## 7. First-run checklist

Do these checks before sending important work:

1. The page loads with the white Clean hardware-style deck.
2. The top panels show only the runtimes enabled in `.env`.
3. STATUS returns without a red error state.
4. SESS shows sessions when the selected runtime supports session listing.
5. PROMPT opens the existing command sheet.
6. Enter a short harmless prompt and press RUN.
7. Confirm that live output appears and the task returns to a terminal state.
8. If the runtime asks for approval, confirm that ALLOW/OK and DENY/NO affect
   only the visible pending approval.
9. Test STOP on a disposable task before relying on it for long work.

Capabilities depend on the installed Hermes WebUI and Codex CLI versions. A
button may remain idle when the runtime does not expose the corresponding event
or endpoint. See `COMPATIBILITY.md` before treating approval handling as
unattended automation.

## 8. Use the Clean deck on a phone

Complete the local-computer checklist first.

For phone access, use a trusted private network or an HTTPS reverse proxy with
an allowlist. Do not expose Hermes Control directly to the public Internet. Do
not use a wildcard origin.

Set:

```dotenv
CONTROL_SERVER_HOST=<trusted-interface-address>
CONTROL_ALLOWED_ORIGINS=<exact-phone-browser-origin>
```

Restart only Hermes Control after changing `.env`. Hermes and Codex do not need
to be restarted.

Open the exact allowed origin on the phone and enter the same control token.

### Install on iPhone or iPad

1. Open the deck in Safari.
2. Use Share.
3. Choose Add to Home Screen.
4. Start Hermes Control from the new home-screen icon.

### Install on Android

1. Open the deck in the browser.
2. Open the browser menu.
3. Choose Install app or Add to Home screen.
4. Start Hermes Control from the installed icon.

Mobile browsers normally require HTTPS for a fully installable PWA outside a
local development origin. Network security, certificates, firewall rules, and
the private network are intentionally managed outside this repository.

## 9. Normal start and stop

Start:

```text
npm start
```

Stop Hermes Control by returning to its terminal and pressing `Ctrl+C` once.
Stopping Hermes Control does not stop Hermes WebUI or Codex processes that were
started independently. An active Codex child run is subject to the server's
normal stop and cleanup behavior.

## 10. Update safely

1. Stop Hermes Control with `Ctrl+C`.
2. Keep your existing `.env`.
3. Update only with a fast-forward pull.
4. Reinstall locked dependencies.
5. Run checks before starting again.

```text
git status --short
git pull --ff-only
npm install
npm run check
npm test
npm start
```

If `git status --short` lists source changes you did not intend to publish, do
not pull over them. Back them up and resolve them first. Never solve an update
problem by deleting `.env` or copying someone else's configuration.

After every update, compare `.env.example` with your `.env` and add only newly
required keys. Do not replace a working `.env` blindly.

## 11. Roll back an update

Before updating, record the current commit:

```text
git rev-parse HEAD
```

If a later update fails, stop Hermes Control and inspect the repository first:

```text
git status --short
git log --oneline -5
```

Do not use a destructive reset when you have local changes. Create a separate
checkout of the recorded commit or ask for help with the exact status output.
Your `.env` is local and must not be included in a support request.

## 12. Troubleshooting

### `node` or `npm` is not found

Install Node.js 20 or newer, close the terminal, open a new terminal, and check
`node --version` again.

### The server rejects `CONTROL_AUTH_TOKEN`

Generate a new token, paste it into `.env` without quotes or spaces, restart
Hermes Control, and enter the same value in the browser. Do not use the Hermes
password as the control token.

### Hermes is offline or returns 401

Confirm that Hermes WebUI is already running and accepts its own password.
Check `HERMES_BASE_URL`, `HERMES_API_PREFIX`, `HERMES_AUTH_MODE`, and
`HERMES_PASSWORD`. Hermes Control does not start Hermes WebUI for you.

### Codex CLI is unavailable

From the same terminal and workspace, run:

```text
codex --version
```

If that fails, fix the Codex CLI installation or set an absolute
`CODEX_EXECUTABLE`. Confirm that `CODEX_WORKDIR` exists and is writable.

### The selected port is already in use

Stop the unrelated local process or choose another unused
`CONTROL_SERVER_PORT`. Do not terminate a process until you have identified it.

### The phone cannot connect

Verify the private network path, exact allowed origin, listening interface,
firewall, and HTTPS configuration. Keep the computer browser working while you
diagnose phone access.

### A task remains running

Refresh the runtime status, inspect EVENTS, and use STOP once. Do not repeatedly
submit the same prompt. The default event store is in memory, so restarting
Hermes Control clears its local task display but does not rewrite upstream
Hermes session data.

### The iPhone shows native Safari input UI

The Clean prompt uses a standard 16-pixel textarea and requests focus directly.
Safari may still display native keyboard or text-editing controls. Installing
the PWA from the home screen can change browser chrome, but it is not guaranteed
to remove every native text-input element.

## 13. Optional integrations

Do not enable optional transports during the first setup.

- Hermes Gateway/TUI and approval bridge: `docs/HERMES_GATEWAY_TUI.md`
- Experimental Codex Desktop add-on: `docs/EXPERIMENTAL_CODEX_DESKTOP.md`
- Complete variable reference: `CONFIGURATION.md`
- General diagnostics: `TROUBLESHOOTING.md`

These integrations have separate compatibility and security requirements. The
Clean UI does not require them.

## 14. Remove Hermes Control

1. Stop Hermes Control with `Ctrl+C`.
2. Remove the installed PWA shortcut if you created one.
3. Delete only the cloned Hermes Control folder after verifying the exact path.

Removing this repository does not uninstall Hermes WebUI or Codex CLI and does
not remove their session data.
