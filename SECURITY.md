# Security

Hermes Control can send prompts and approval decisions to powerful local or
remote runtimes. Treat it as a privileged control plane.

Before any non-local access:

- set a strong `CONTROL_AUTH_TOKEN`;
- keep the default localhost bind unless a trusted VPN/reverse proxy is used;
- configure explicit origins, not `*`;
- use TLS outside localhost;
- restrict the network path to known devices;
- never put Hermes passwords in source control;
- review `CODEX_WORKDIR` and executable permissions;
- keep run, body, prompt, rate and concurrency limits enabled.

The server protects API and SSE routes with a bearer token or an HttpOnly
same-site session cookie created by `/api/auth/session`. The browser prompt is
only a convenience for a local operator; it is not a substitute for TLS or
device authentication.

Known alpha limitations include in-memory task/conversation state and no
multi-user authorization model. Do not expose this version as a shared service.
