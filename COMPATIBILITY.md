# Compatibility

This file intentionally records only what the repository can establish.

| Component | Current status |
|---|---|
| Node.js | Version must be pinned before alpha release; `package.json` currently has no `engines` declaration. |
| Hermes WebUI/backend (`upstream-clean`) | Routes were compared against `nesquena/hermes-webui` master revision `f6265cc96293bc9ae16ab8d8e3d8bc2dc76d231f`; clean external-chat behavior still needs a real gateway-mode test. |
| Hermes OS Cat deployment | Separate operator-specific target. Its endpoint behavior must be tested with the read-only preflight and must not be treated as the upstream default. |
| Codex CLI | Requires `exec --json` JSONL behavior and the supported approval stdin contract. Exact minimum version must be verified with a fixture. |
| Windows | Process-tree cleanup uses `taskkill.exe`; test on every supported Windows release. |
| Linux/macOS | CLI process cleanup path exists but requires platform CI before support is claimed. |
| Mobile browser/PWA | Static shell and SSE client are present; authenticated mobile smoke test is required before release. |

Unsupported or unverified runtime capabilities must be displayed as unavailable,
not simulated by the UI.

## Hermes upstream notes

Hermes WebUI is installed separately and is not vendored here. The upstream
README documents in-process chat as the default and names gateway mode as the
supported external-chat path. This public adapter therefore distinguishes
route existence from a verified deployment contract. Record the exact WebUI
revision and configuration used for every clean-machine test in
`docs/UPSTREAM_LICENSE_AUDIT.md`.
