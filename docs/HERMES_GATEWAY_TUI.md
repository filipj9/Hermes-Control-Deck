# Optional Hermes Gateway and TUI Integration

This integration is optional and disabled by default. Start with the normal
Hermes WebUI adapter and enable this layer only after the base installation is
healthy.

## Components

The integration has three independent pieces:

1. `HermesWsClient` connects to a compatible Hermes Gateway and uses JSON-RPC
   methods such as `session.resume`, `session.status`, and `prompt.submit`.
2. `HermesTuiRelay` lets the Deck and one or more terminal TUI clients share a
   single upstream Gateway transport. It sends `gateway.ready` immediately,
   forwards requests and events, and resumes tracked sessions after reconnect.
3. `hermes-control-approval-bridge` is an optional Hermes Agent plugin. It
   relays approval events without network I/O in hook callbacks, long-polls for
   decisions, applies them through the Hermes resolver, and ACKs the result.

The approval plugin is not required for prompts or streaming. The TUI relay is
not required for ordinary Hermes WebUI HTTP/SSE use.

## Safety Defaults

- Every optional feature is disabled unless its `*_ENABLED` variable is true.
- Relay and approval traffic use separate tokens of at least 32 characters.
- Relay tokens are checked with constant-time comparison and are not logged.
- Approval event bodies are capped and normalized before persistence.
- Event IDs, run/task state, tracked relay sessions, and terminal approval
  history are bounded.
- The legacy WebUI approval monitor is disabled by default. When enabled, it
  scans only selected or demonstrably active sessions, is throttled, and never
  fans out across session history.

## Relay Configuration

Set these values in the local `.env`:

```dotenv
HERMES_TUI_RELAY_ENABLED=true
HERMES_TUI_RELAY_PATH=/api/tui-relay
HERMES_TUI_RELAY_TOKEN=<separate-random-token>
HERMES_TUI_RELAY_UPSTREAM_WS_URL=wss://your-hermes-host.example/api/ws
HERMES_TUI_RELAY_UPSTREAM_AUTH_BASE_URL=https://your-hermes-host.example
HERMES_TUI_RELAY_UPSTREAM_USERNAME=<your-user>
HERMES_TUI_RELAY_UPSTREAM_PASSWORD=<your-password>
HERMES_TUI_RELAY_UPSTREAM_SESSION_ID=<existing-session-id>
HERMES_WS_SESSION_ID=<existing-session-id>
```

The downstream TUI connects to the relay URL with its token. Keep that URL and
token out of shell history, screenshots, issue reports, and committed files.
Use TLS for every non-loopback connection.

The relay mints fresh upstream tickets through the configured auth endpoint.
Single-use upstream tickets are not stored as durable reconnect credentials.

## Approval Plugin

Enable the receiver in Hermes Control:

```dotenv
HERMES_BRIDGE_ENABLED=true
HERMES_BRIDGE_TOKEN=<another-separate-random-token>
```

Then follow
`integrations/hermes-control-approval-bridge/README.md` on the Hermes machine.
The plugin requires compatible upstream hooks and the
`resolve_gateway_approval` resolver. If those APIs are missing, leave the
plugin disabled.

The receiver preserves the exact top-level `session_id` from each
`approval_requested` event. The decision returned to Hermes echoes that value
unchanged; it is not replaced with a UI conversation id or a canonical TUI
session id.

## Verification

Verify in this order:

1. Base Hermes WebUI health and prompt streaming.
2. Gateway WebSocket connection and `gateway.ready`.
3. `session.resume` for an existing test session.
4. Harmless prompt streaming and terminal completion.
5. A harmless approval request, decision claim, resolver application, and ACK.
6. Reconnect after closing only the test TUI client.

Do not test with destructive commands. Do not expose the control server or
relay directly to the public Internet.

## Upstream Compatibility

Hermes Gateway/plugin APIs may change between releases. This project does not
patch or vendor Hermes Agent. Record the exact Hermes revision used during a
deployment test, and treat a missing method, hook, or resolver as an
incompatible version rather than bypassing upstream security checks.
