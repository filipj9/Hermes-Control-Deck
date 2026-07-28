# Compatibility

This file intentionally records only what the repository can establish.

| Component | Current status |
|---|---|
| Node.js | Version must be pinned before alpha release; `package.json` currently has no `engines` declaration. |
| Hermes WebUI/backend | External dependency. The exact upstream repository and minimum version are not proven by this tree. |
| Codex CLI | Requires `exec --json` JSONL behavior and the supported approval stdin contract. Exact minimum version must be verified with a fixture. |
| Windows | Process-tree cleanup uses `taskkill.exe`; test on every supported Windows release. |
| Linux/macOS | CLI process cleanup path exists but requires platform CI before support is claimed. |
| Mobile browser/PWA | Static shell and SSE client are present; authenticated mobile smoke test is required before release. |

Unsupported or unverified runtime capabilities must be displayed as unavailable,
not simulated by the UI.
