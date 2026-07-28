# Hermes Control: CLI-First Open Source Preparation Report

Status: `NOT READY - BLOCKERS REMAIN`

Date: 2026-07-28

This report describes the isolated public copy prepared for a first alpha release. It is intentionally separate from the private production application. No public push was performed and no private production files were changed.

## 1. Scope and isolation

Private production source was a sibling directory used only as a read-only
reference during preparation. Its author-specific absolute path is intentionally
omitted from this public report.

The public working copy is the repository containing this report. It is a
separate sibling of the private production copy.

Isolation evidence:

- The public copy is a sibling directory, not a child of production.
- The public copy has a new empty Git history and no configured remote.
- No `.git`, `.env`, `node_modules`, build output, runtime state, private launcher, password, watchdog, or private bridge file was copied.
- The private production repository status was checked before and after preparation. Its existing status remained `main` with the same two pre-existing untracked audit files; no production file was edited.
- The public copy excludes `CodexDesktopBridge.mjs`, `CodexApiClient.mjs`, `CodexAppServerClient.mjs`, `scripts/start-codex-desktop-bridge.ps1`, `scripts/inspect-codex-desktop.mjs`, and `scripts/verify-codex-desktop-contracts.mjs`.

The public runtime imports `CodexCliClient` from `apps/server/src/adapters/codex/CodexRuntimeAdapter.mjs`. There is no public runtime import of a desktop bridge, CDP client, renderer automation, or private event protocol.

## 2. Target product

The intended alpha is:

> A mobile PWA control panel for Hermes WebUI and a local Codex CLI runtime, without desktop integration.

The public server is the only process exposed to the phone. It normalizes both adapters into the same runtime, task, conversation, approval, and event shapes.

## 3. Capability matrix

| Function | Hermes | Codex CLI | Desktop-only | CLI-first state |
|---|---|---|---|---|
| Send prompt | Confirmed: `HermesRuntimeAdapter.sendMessage()` | Confirmed: `CodexRuntimeAdapter.startCliRun()` | No | Available |
| Receive answer | Confirmed through chat response and SSE mapper | Confirmed from JSONL stdout item events | No | Available, subject to CLI JSONL compatibility |
| Streaming | Confirmed: `HermesApiClient.streamSse()` and `/chat/stream` | Confirmed as process stdout line streaming in `CodexCliClient.start()` | No | Available |
| Session list | Confirmed through `/sessions/search`, `/sessions`, and fallback `/conversations` | Only in-memory conversations created by this server | No | Hermes available; Codex limited |
| New session | Confirmed: `/session/new` | New CLI run with a new in-memory task/conversation | No | Available |
| Switch session | Confirmed if upstream returns session ids | `continue` resumes CLI last run; arbitrary historical session restore is not implemented | No | Hermes available; Codex limited |
| STOP/cancel | Confirmed: `/chat/cancel?stream_id=` and local stream state | Confirmed: child process tree termination in `CodexCliClient.stop()` | No | Available |
| Approvals | Confirmed: `/approval/pending` and `/approval/respond` | Supported only when CLI emits a recognized approval event and accepts the documented stdin response | No | Hermes available; Codex requires compatibility fixture |
| Deny | Confirmed through `/approval/respond` with deny choice | Confirmed as `deny\n` to the active CLI stdin when a pending approval exists | No | Available with the approval caveat |
| Reasoning | Confirmed as Hermes stream event handling and configured UI level | Implemented as a prompt directive in `withReasoningDirective()`; not a native CLI reasoning-level API | No | Available as a best-effort behavior, not a measured model parameter |
| Models | Confirmed through `/models`, `/v1/models` fallback | Not implemented as a stable list contract | No | Hermes available; Codex unavailable |
| Work status | Confirmed through health, task mapping, stream events | Confirmed through task lifecycle and CLI event mapping | No | Available |
| Conversation history | Confirmed through upstream session/conversation response | In-memory only; not persisted across server restart | No | Hermes available; Codex limited |
| Reconnect | HTTP retries login after a 401 and fallback routes are attempted | No automatic resurrection of a lost process; reconnect means start/continue a new run | No | Partial |
| Timeout/error state | Adapter and stream deadlines are configured | Run timeout, process error, non-zero exit, and stderr error events are mapped | No | Available |
| Desktop control | Not applicable | Not applicable | Required by private Desktop bridge | Deliberately absent |

Facts above are based on the functions named in the table. Where the upstream CLI approval protocol or historical session semantics are not verified in this repository, the limitation is stated explicitly rather than inferred.

## 4. Runtime architecture

```text
Phone browser / PWA
        |
        | HTTPS or private tailnet HTTP
        v
Hermes Control Server
  auth + limits + same-origin API + SSE EventBus
        |
        +--> HermesRuntimeAdapter
        |       |
        |       +--> HermesApiClient
        |               |
        |               +--> Hermes WebUI /api/* and /health
        |
        +--> CodexRuntimeAdapter
                |
                +--> CodexCliClient
                        |
                        +--> local Codex CLI child process
                             stdin prompt/approval
                             stdout JSONL events
                             stderr diagnostics
```

Request flow:

1. The PWA authenticates once with `POST /api/auth/session` using the control token.
2. The server accepts only authenticated API, health, and event requests.
3. The server resolves `source` to an adapter in `RuntimeRegistry`.
4. The adapter calls Hermes HTTP/SSE or starts one local Codex CLI process.
5. Adapter events are normalized and published to `EventBus`.
6. `EventBus` emits unified SSE frames at `/events`; the UI never needs to inspect the origin-specific wire protocol.
7. Cached list calls are bounded, and event history is limited to 15 minutes / 300 retained events.

The shared contract is visible in `apps/server/src/application/RuntimeRegistry.mjs`, `apps/server/src/application/useCases.mjs`, `apps/server/src/domain/events.mjs`, and the adapter methods `health`, `listAgents`, `listTasks`, `listWorkers`, `listApprovals`, `listConversations`, `startTask`, `sendMessage`, `cancelTask`, `decideApproval`, `runAction`, and `subscribeEvents`.

## 5. Hermes WebUI integration inventory

The adapter is in `apps/server/src/adapters/hermes/HermesRuntimeAdapter.mjs`; HTTP behavior is in `apps/server/src/adapters/hermes/HermesApiClient.mjs`.

| Method | Endpoint | Calling function | Auth | Request/response | Timeout/fallback | Portability |
|---|---|---|---|---|---|---|
| GET | `/health` | `HermesApiClient.health()` | Anonymous upstream health | JSON health object | `HERMES_TIMEOUT_MS`; no fallback | Standard-looking, must verify upstream version |
| GET | `${apiPrefix}/auth/status` | `HermesApiClient.authStatus()` | Anonymous | Auth status JSON | `HERMES_TIMEOUT_MS` | Implemented client method; not required by every list path |
| POST | `${apiPrefix}/auth/login` | `HermesApiClient.ensureLogin()` | Password body, receives cookie | `{password}`; `Set-Cookie` captured in memory | Timeout; re-login after upstream 401 | Requires password auth enabled upstream |
| GET | `${apiPrefix}/profiles` | `listAgents()`, `preflight()` | Hermes cookie | Profiles JSON mapped to agents | Fallback `/profiles` | Depends on prefix and upstream profile route |
| GET | `${apiPrefix}/sessions/search?limit=50` | `listConversations()` | Hermes cookie | Sessions JSON | Fallback `${apiPrefix}/sessions`, `${apiPrefix}/conversations` | Version-dependent fallback |
| GET | `${apiPrefix}/sessions/search?limit=1` | `preflight()` | Hermes cookie | Probe only | Fallback `${apiPrefix}/sessions` | Version-dependent |
| POST | `${apiPrefix}/session/new` | `ensureSession()` | Hermes cookie | Profile/model body; session id response | Request timeout | Required for prompt flow |
| GET | `${apiPrefix}/session?session_id=` | Session lookup in adapter | Hermes cookie | Session/messages JSON | Request timeout | Requires session route |
| POST | `${apiPrefix}/chat/start` | `startStream()` | Hermes cookie | Session/message/profile/model JSON; stream id response | Falls back to `${apiPrefix}/chat` | Version-dependent stream contract |
| POST | `${apiPrefix}/chat` | `sendMessage()` fallback | Hermes cookie | Session/message/profile JSON | Request timeout | Fallback only |
| GET | `${apiPrefix}/chat/stream?stream_id=` | `streamSse()` | Hermes cookie | SSE `token`, `reasoning`, `tool`, `approval`, `done` etc. | `HERMES_STREAM_TIMEOUT_MS`, zero means no deadline | Requires upstream SSE support |
| GET | `${apiPrefix}/chat/cancel?stream_id=` | `cancelTask()` | Hermes cookie | No body; status checked | Request timeout | Requires upstream cancel route |
| GET | `${apiPrefix}/approval/pending?session_id=` | `listApprovals()` / approval lookup | Hermes cookie | Pending approval JSON | Request timeout | Requires upstream approvals |
| POST | `${apiPrefix}/approval/respond` | `decideApproval()` | Hermes cookie | session, approval id, choice | Request timeout | Choice names follow observed upstream contract |
| GET | `${apiPrefix}/models` | `listModels()`, `preflight()` | Hermes cookie | Models JSON | Fallback `/v1/models`, `/models` | Version-dependent |
| GET | `${apiPrefix}/v1/models` | model fallback | Hermes cookie | Models JSON | Fallback only | Version-dependent |
| GET | `${apiPrefix}/kanban/tasks?status=all&sort=updated` | `listTasks()`, `preflight()` | Hermes cookie | Kanban task JSON | Fallback `/kanban/tasks`, `${apiPrefix}/tasks`, `/tasks`; health run fallback | Version-dependent |
| GET | `${apiPrefix}/system/metrics` | `runAction("metrics")` | Hermes cookie | Metrics JSON | Fallback unavailable | Optional/version-dependent |

The Hermes client sends the upstream password only to the configured Hermes base URL. It stores the upstream session cookie in the adapter process memory. It does not write that cookie to the public repository. The public control API itself is protected separately by `CONTROL_AUTH_TOKEN` and an HttpOnly same-site session cookie.

The repository does not vendor Hermes WebUI. It treats it as an external dependency configured by `HERMES_BASE_URL`. Whether every fallback is a stable upstream contract cannot be proven from this repository alone; a compatibility matrix against a clean upstream Hermes WebUI is a P0 task.

## 6. Codex CLI integration inventory

The CLI boundary is intentionally narrow and is implemented by `CodexCliClient` and `CodexRuntimeAdapter`.

| Action | Command / arguments | Function | Input | Output | Risk / portability |
|---|---|---|---|---|---|
| Discover executable | configured `CODEX_EXECUTABLE`, newest `%LOCALAPPDATA%\\OpenAI\\Codex\\bin\\*\\codex.exe`, or `codex` PATH lookup | `resolveCodexExecutable()` | Environment | executable availability | WARNING: discovery rules need Linux/macOS fixtures |
| Version | `<executable> --version` | `CodexCliClient.version()` | none | version text | FACT: version probe; exact minimum is configurable |
| Start run | `<exe> -C <workdir> --sandbox <sandbox> --ask-for-approval <policy> [--model] [--profile] exec [resume --last] --json --skip-git-repo-check -` | `buildArgs()` and `start()` | prompt on stdin | JSONL stdout, stderr, exit | HIGH: CLI flags must be tested against supported Codex CLI versions |
| Stream | one JSON object per stdout line | `CodexCliClient.start()` / `handleCliEvent()` | process stdout | unified task/message/progress events | Requires JSONL mode |
| Diagnostics | one stderr line at a time | `handleCliStderr()` | process stderr | redacted runtime error event | Prompt/tool text may still contain sensitive data |
| STOP | Windows `taskkill.exe /pid /t /f`, Unix SIGTERM | `CodexCliClient.stop()` / `cancelTask()` | task id | process close and cancelled event | Process-tree behavior must be tested on target OS |
| Timeout | configured `CODEX_RUN_TIMEOUT_MS` | `start()` / `onTimeout` | elapsed time | failed task event | Bounded; no automatic resume |
| Approval | stdin `once\\n`, `always\\n`, or `deny\\n` | `decideApproval()` | approval id/decision | approval resolved event | UNKNOWN until a real CLI approval fixture confirms protocol |
| Continue | adds `resume --last` | `runAction("continue")` | prompt/options | new local task for resumed CLI run | Does not restore arbitrary old server conversations |

The child process is spawned with `shell: false`, an explicit `cwd`, inherited environment plus `FORCE_COLOR=0`, and separate stdin/stdout/stderr pipes. User content is passed through stdin, not concatenated into a shell command. `CodexCliClient.stop()` waits for close after killing the tree. Concurrent runs are rejected unless `CODEX_ALLOW_CONCURRENT_RUNS=true`.

The adapter records task metadata in memory, including a prompt field. This is useful for the running PWA but is not a durable session store and must be treated as sensitive process memory.

## 7. Public boundary and private mechanisms

The public copy does not import or execute private bridge modules. It also does not expose a desktop launcher, CDP port, renderer hook, Micro event, HID action, or application-opening action. The only supported Codex surface in `config.mjs`, `.env.example`, and runtime health is `mode=cli`, `surface=cli`.

The old UI control that represented an application/workspace launch is not part of the public CLI capability set. The CLI adapter returns an explicit unsupported-capability error for those legacy action names instead of attempting to open another application.

Recommended repository strategy: **C - keep desktop integration in a private repository or private branch**.

Reasons:

- A missing module is safer than a dormant privileged bridge that can be enabled accidentally.
- The public tree and dependency graph are easier to audit.
- Public users receive an unambiguous CLI-only product contract.
- A future private integration can be reintroduced without making the public branch depend on private paths.
- A flag-only design would still create an accidental activation and supply-chain review burden.

## 8. Portability review

| Dependency | Classification | Evidence / later action |
|---|---|---|
| Hermes base URL | SAFE after configuration | `loadConfig()` reads `HERMES_BASE_URL`; no private IP default remains. |
| Hermes password | WARNING | `.env` only; document secret handling and test password auth on a clean upstream instance. |
| Codex executable | WARNING | `CODEX_EXECUTABLE` or PATH discovery; add clean Windows/macOS/Linux fixtures. |
| Codex workdir | WARNING | `CODEX_WORKDIR` is required by the runtime; validate permissions and workspace policy. |
| Host / port | SAFE | `CONTROL_SERVER_HOST`, `CONTROL_SERVER_PORT`; default is loopback. |
| Phone access | WARNING | User must explicitly bind to a private LAN/tailnet address and configure allowed origins/TLS. |
| Private IP/Tailscale address | SAFE | No author-specific IP occurs in public source/config. |
| Windows user path | SAFE | No author-specific path occurs in public source/config. |
| Existing sessions/state | WARNING | Hermes state is upstream-owned; Codex public server history is in-memory only. |
| Desktop bridge | SAFE | Excluded from public tree and package scripts. |
| Dependencies | BLOCKER before release | Must run a clean install and lockfile audit on another machine. |

## 9. Security review

| Risk | Severity | Scenario | Required before public release |
|---|---|---|---|
| Control token exposure | HIGH | Anyone holding the token can control both runtimes. | Generate a unique token, never commit `.env`, and document rotation. |
| Plain HTTP on an untrusted network | HIGH | A tailnet/LAN observer can read prompts and use the API. | Require HTTPS reverse proxy or a private trusted network; document the boundary. |
| Codex tool execution | HIGH | A prompt can cause Codex CLI to perform workspace operations under its configured policy. | Show explicit policy warnings, require user-selected workdir, and test approval behavior. |
| Hermes password in process memory | MEDIUM | A local process inspector could read configuration/cookie state. | Use environment/secret manager and document process permissions. |
| Prompt and response retention | MEDIUM | In-memory task metadata and event history may contain sensitive content. | Add configurable redaction/retention and state the privacy model. |
| Unauthenticated CORS | LOW after current fix | A browser from an untrusted origin could attempt API calls. | Keep allowlist empty for same-origin only; require explicit origin entries for remote UI. |
| Request body DoS | MEDIUM | Large bodies consume server memory. | Keep `CONTROL_MAX_BODY_BYTES` and add malformed/chunked body tests. |
| Request flood | MEDIUM | Many API calls or CLI starts consume resources. | Keep rate limit and add per-action concurrency/backoff tests. |
| Process zombie / tree cleanup | MEDIUM | A killed run leaves child processes. | Run OS-specific process lifecycle tests. |
| Static path traversal | LOW after current fix | Crafted URL tries to read files outside web root. | Keep `path.relative` boundary check and add regression test. |
| Log leakage | MEDIUM | stderr or event payloads may contain prompts, paths, or tool output. | Add structured redaction and verify logs with fixtures. |
| Trademark/branding confusion | MEDIUM | Generated UI may display third-party marks as if official. | Include attribution/disclaimer and obtain a legal/brand review. |

CSRF is reduced by same-site HttpOnly control sessions, same-origin default behavior, an explicit origin allowlist, and bearer authentication. It still requires an end-to-end browser test before release. TLS is intentionally not implemented in the node server and must be provided by the deployment boundary.

## 10. Hermes dependency and licensing

The public copy does not vendor or copy Hermes WebUI implementation. It calls the configured API through `HermesApiClient`. The upstream repositories and MIT notices are now recorded in `docs/UPSTREAM_LICENSE_AUDIT.md` and `THIRD_PARTY_NOTICES.md`. A clean external-chat compatibility run is still required before release.

Required later verification:

1. Identify the upstream Hermes WebUI repository and release/version.
2. Confirm API route stability for health, auth, sessions, chat/SSE, approvals, profiles/models, and kanban.
3. Record the upstream license and required attribution/NOTICE text.
4. Add a compatibility table to `COMPATIBILITY.md`.
5. Add an upstream version check or a clear manual compatibility procedure.

## 11. Assets and branding

The working copy contains the existing generated UI assets under `apps/web/assets` and PWA metadata/icons. Per the author statement, the UI artwork was generated specifically for this project. That statement does not by itself grant rights to use third-party names, logos, or marks.

Potential marks requiring separate review:

- Hermes / Nous Research name and imagery.
- Codex name and OpenAI mark/iconography.
- Any generated asset that resembles an official product logo.

The asset inventory and suggested disclaimer are in `ASSETS.md`. A suitable public disclaimer is:

> Hermes Control is an independent open-source project. It is not sponsored, endorsed, or officially affiliated with OpenAI, Codex, Nous Research, or Hermes WebUI. Product names and marks belong to their respective owners.

Do not describe a generated approximation as an official logo. Before release, replace or separately license any mark that the owner does not permit.

## 12. Tests and CI status

Implemented local tests in `tests/`:

- `config.test.mjs`: explicit CLI mode, required Hermes URL, token generation.
- `event-bus.test.mjs`: newest-first retention, noisy stream suppression, SSE framing.
- `codex-cli.test.mjs`: stdin JSON execution arguments, no app/CDP argument, executable/workdir discovery.
- `public-boundary.test.mjs`: excluded private files, no private imports/IP/path, no live `.env`.

Observed result during preparation: **12 passed, 0 failed**. Key source files also passed Node syntax checks. `tests/hermes-contract.test.mjs` uses a local mock server and covers auth/re-login, profiles, sessions, models, Kanban, new session, SSE, approval, and cancel. `tests/codex-cli-contract.test.mjs` covers fixture JSONL, stderr, approval, completion, and STOP mapping.

Required CI for `v0.1.0-alpha`:

1. Clean checkout; install from lockfile; no `.env` required for static tests.
2. Node syntax checks and unit tests on Windows, Linux, and macOS.
3. Mock Hermes WebUI with login cookie, fallback routes, JSON responses, and SSE fixtures.
4. Mock Codex CLI that emits JSONL stdout, stderr, approval, completion, failure, and timeout fixtures.
5. STOP test proving child process tree cleanup.
6. Reconnect test for Hermes 401 and unavailable runtime.
7. Invalid body, prompt limit, token, CORS, rate limit, path traversal, and malformed JSON tests.
8. Clean PWA smoke test at desktop and mobile viewport sizes.
9. Secret scan and dependency audit.
10. Package artifact scan proving no `.env`, private bridge source, runtime state, or author-specific path is included.

## 13. Documentation inventory

The public copy includes:

- `README.md`: product scope and quick start.
- `INSTALL.md`: clean-machine installation.
- `CONFIGURATION.md`: Hermes, Codex CLI, control auth, and network settings.
- `SECURITY.md`: deployment boundary and threat model.
- `COMPATIBILITY.md`: version assumptions and verification points.
- `CONTRIBUTING.md`: contribution rules and CLI-only boundary.
- `ASSETS.md`: asset inventory, marks, and disclaimer.
- `THIRD_PARTY_NOTICES.md`: upstream MIT notices and branding disclaimer.
- `docs/UPSTREAM_LICENSE_AUDIT.md`: upstream repository, revision, license, and route evidence.
- `docs/CLEAN_MACHINE_TEST.md`: non-private clean-machine validation procedure.
- `scripts/verify-hermes-upstream.mjs`: read-only endpoint preflight; write tests require an explicit flag.
- `TROUBLESHOOTING.md`: setup and runtime diagnostics.
- `LICENSE`: project license placeholder for legal review.
- `.env.example`: neutral configuration template without live secrets.

The documentation must retain the alpha limitation: Hermes WebUI is external, Codex is CLI-only in this release, access from a phone needs a secure network boundary, and each user is responsible for their own runtime configuration.

## 14. Release plan

### P0 - absolute blockers

| Task | Priority | Risk/dependency | Completion criterion |
|---|---|---|---|
| Verify upstream Hermes repository/license/version | P0 | External information | `COMPATIBILITY.md` names the upstream release and license with source evidence. |
| Run Hermes mock and real compatible instance tests | P0 | Requires clean Hermes | All listed Hermes routes pass auth, fallback, SSE, approval, cancel, and error fixtures. |
| Verify Codex CLI JSONL and approval protocol | P0 | Requires installed CLI | Fixture and real CLI confirm prompt, stream, approval, deny, stop, timeout, and continue. |
| Perform clean-machine install | P0 | Requires another machine | Fresh clone starts with only documented commands and no private files. |
| Security review of network exposure | P0 | Requires deployment choice | HTTPS/private tailnet, origin allowlist, token rotation, and threat-model acceptance are documented. |
| Legal/branding review | P0 | External owner/licensing question | Marks are removed, licensed, or clearly disclaimed before release. |

### P1 - minimal alpha

| Task | Priority | Dependency | Completion criterion |
|---|---|---|---|
| Tag package as `0.1.0-alpha.0` after review | P1 | P0 complete | Version and changelog match tested artifact. |
| Add mock adapter integration tests | P1 | Test harness | API and SSE tests cover both sources with the same event assertions. |
| Add explicit UI unavailable states | P1 | Capability matrix | Unsupported Codex model/history/workspace actions are visibly disabled or labeled. |
| Add startup configuration diagnostics | P1 | Config contract | Startup explains missing URL, token, executable, or workdir without leaking secrets. |

### P2 - other-computer validation

| Task | Priority | Dependency | Completion criterion |
|---|---|---|---|
| Windows validation | P2 | P0 CLI fixture | Codex discovery, STOP, approvals, and PWA access pass on clean Windows. |
| Linux/macOS validation | P2 | Unix process fixture | `which`, SIGTERM tree handling, paths, and shell-free spawning pass. |
| Tailnet/LAN mobile validation | P2 | Secure network plan | Phone can authenticate and stream without exposing the server publicly. |

### P3 - release onboarding

| Task | Priority | Dependency | Completion criterion |
|---|---|---|---|
| Final README quick start | P3 | P0/P2 | A new user can follow the documented path without private context. |
| Release artifact scan | P3 | Final tree | Archive contains no secret, private bridge, state, or author path. |
| Alpha release notes | P3 | Compatibility table | Known limits and non-goals are explicit. |
| Public repository setup | P3 | Legal/security sign-off | Remote is added only after owner approval; not performed in this preparation. |

## 15. Final verdict

1. **Can the current project be released for Hermes + Codex CLI?** Yes, architecturally and as an isolated alpha candidate; no, not yet as a responsibly supported public release because the clean-machine and real runtime compatibility blockers remain.
2. **Which functions work?** Hermes prompt, response, SSE, session/new-session, cancel, approvals, deny, profiles, models, task fallbacks, health, and unified events are implemented. Codex CLI prompt, JSONL streaming, task state, stop, basic approval/deny, new run, and `resume --last` are implemented.
3. **Which functions are lost without private integration?** Desktop session control, application/workspace launching, renderer/CDP control, Micro events, and any private desktop-only status surface.
4. **Is the application tied to one computer?** Hermes is configurable to another WebUI. Codex CLI runs on the computer hosting Hermes Control and the configured workdir; the phone is only a client. It is not portable until the executable, OS process behavior, and clean install are validated.
5. **Absolute blockers?** Upstream Hermes licensing/version verification, real Codex CLI approval/JSONL compatibility, clean-machine install, secure deployment boundary, and branding review.
6. **Work for alpha?** The isolated implementation and local test foundation are present. A credible alpha still needs the P0 validation work; estimate by work, not by elapsed time: one focused compatibility pass plus cross-platform and security review.
7. **Where should the private bridge live?** Private branch or separate private repository; the recommended choice is a separate private repository/package so the public dependency graph cannot activate it accidentally.
8. **CLI-first readiness: 68/100.** The boundary and local controls are in place; external compatibility, approval protocol proof, legal review, and clean-machine validation keep it below release-ready.

## 16. Checklists

### A. Ready to begin implementation work

- [x] Production path and public path are separate.
- [x] Public copy has no production Git history or live `.env`.
- [x] Codex runtime is CLI-only in public configuration and imports.
- [x] Control API requires a token and uses bounded bodies/rate limits.
- [x] Unified EventBus and adapter boundaries are present.
- [x] Static boundary, config, EventBus, and CLI tests pass locally.
- [ ] Upstream Hermes repository/license/version verified.
- [ ] Real Hermes compatibility fixture recorded.
- [ ] Real Codex CLI JSONL/approval fixture recorded.

### B. Ready for public release

- [ ] P0 blockers closed with evidence.
- [ ] Clean install succeeds on a second machine.
- [ ] Windows and at least one Unix process lifecycle test passes.
- [ ] Phone PWA works through a documented private HTTPS/tailnet setup.
- [ ] Auth, CORS, rate limits, body limits, and CSRF behavior are tested end-to-end.
- [ ] Prompt/log retention and redaction policy is documented and tested.
- [ ] Hermes compatibility table and license/NOTICE are complete.
- [ ] Trademark/branding review is complete.
- [ ] Final archive scan is clean.
- [ ] Release notes state CLI-only scope and alpha limitations.
- [ ] Public remote/push is performed only after explicit owner approval.
