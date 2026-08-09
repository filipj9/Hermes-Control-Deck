# Hermes Control Approval Bridge

Opt-in Hermes Agent plugin that exposes native **Hermes Gateway** approvals and
an explicitly enabled Hermes CLI remote-approval path to Hermes Control Deck.
It uses the official synchronous
`pre_approval_request` / `post_approval_response` hooks and the official
`tools.approval.resolve_gateway_approval()` resolver.

The hook callbacks never perform network I/O. They enqueue sanitized metadata
and return immediately. One daemon worker posts approval events, long-polls for
Deck decisions, resolves the matching Gateway approval, ACKs the decision, and
emits the final `approval_resolved` event.

## Requirements

- Hermes Agent with plugin hooks and `resolve_gateway_approval` support.
- Hermes Control Server with the Gateway approval routes enabled.
- An HTTPS URL reachable from the Hermes Gateway machine.
- A bridge token shared with Hermes Control. The plugin never logs this token.

## Install

Copy this directory to the Hermes user plugin directory:

```text
~/.hermes/plugins/hermes-control-approval-bridge/
```

Create `~/.hermes/hermes-control-approval-bridge.env` with mode `0600`:

```bash
HERMES_CONTROL_URL="https://your-control-host.example"
HERMES_CONTROL_BRIDGE_TOKEN="replace-with-your-bridge-token"
HERMES_CONTROL_GATEWAY_ID="my-hermes-gateway"
```

Process environment variables with the same names override this file.

Enable the plugin and restart the Hermes Gateway once:

```bash
hermes plugins enable hermes-control-approval-bridge
```

Verify installation before testing the Deck:

```bash
hermes plugins list
```

The plugin must be listed as enabled. If the installed Hermes version does not expose `pre_approval_request`, `post_approval_response`, and `resolve_gateway_approval`, upgrade Hermes before continuing; the plugin fails closed and cannot provide approval control on that version.

Do not put the token in `plugin.yaml`, shell history, screenshots, or logs.

## HTTP contract

The worker uses:

```text
POST /api/hermes/events
GET  /api/hermes/approval-decisions/claim?gateway_id=...&limit=1&wait_ms=1000
POST /api/hermes/approval-decisions/:decisionId/ack
```

All requests send `Authorization: Bearer <HERMES_CONTROL_BRIDGE_TOKEN>`.

`approval_requested` events contain `approval_id`, `gateway_id`, `command`,
`question`, and `surface`. `approval_resolved` additionally contains
`decision_id`, `choice`, and `status`. Event IDs are deterministic, so retries
are idempotent at the Hermes Control receiver.

Approvals with `surface == "gateway"` are always relayed. Approvals with
`surface == "cli"` are relayed only when the Hermes process has
`HERMES_CLI_REMOTE_APPROVAL=1`. That flag must be consumed by the upstream
Hermes approval handler so an interactive stdin prompt is replaced by its
gateway-queue decision path. The plugin alone cannot convert a prompt that
Hermes has already handled locally on stdin.

Set the flag in the environment of the Hermes process (for example, the
systemd user service environment), not only in the bridge plugin config file.
Do not enable it until the upstream Hermes build contains the corresponding
remote-approval branch and the resolver has been verified on a harmless task.

The passive Hermes World/state relay is not a substitute for this plugin. It can report run lifecycle but cannot resolve an approval.

## Test

The tests use fake HTTP and a fake resolver. They do not contact Hermes Control
or resolve a real approval.

```bash
python -m unittest -v test_plugin.py
```

## Operational behavior

- Network failures are retried with exponential backoff: the default delay
  grows from 1 second to a maximum of 60 seconds while the Deck is offline.
- The first outage is logged as a warning, repeated outage warnings are
  rate-limited to once per minute, and a single informational message is
  emitted when the connection is restored. This prevents a sleeping Deck from
  producing a log entry every second or needlessly waking the CPU.
- Hook callbacks stay non-blocking even if Hermes Control is offline.
- A failed or unmatched resolver call is ACKed as `failed` and does not emit a
  false resolved event.
- The worker is daemonized so it cannot prevent Hermes from exiting.
- Hermes has no plugin shutdown lifecycle; an `atexit` stop handler is included
  as a best-effort cleanup.
