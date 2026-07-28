# Contributing

Keep the public tree CLI-first. Do not add private runtime integrations,
debugging ports, local IPs, secrets, generated state, or machine-specific
launchers.

Adapter changes must preserve the shared domain event shape in
`apps/server/src/domain/events.mjs`. Add mock/fixture coverage for endpoint and
process behavior. Run `npm run check` and the relevant tests before proposing a
change. Never test against a private installation or include its credentials.
