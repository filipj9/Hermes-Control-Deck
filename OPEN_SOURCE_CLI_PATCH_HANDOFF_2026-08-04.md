# CLI-first Open Source Patch Handoff

Date: 2026-08-04
Scope: isolated public repository only
Baseline: `fd7937e9679ecbb20ea9dbbcd335b9b74e0a4a16`
Status: **ready for review; not committed or pushed**

## Safety Boundary

This patch was prepared only in the sibling CLI-first repository. The locked
production repository was not edited, staged, committed, restarted, or used
as a runtime target during this work.

The patch contains no Codex Desktop bridge, CDP launcher, renderer automation,
Micro event integration, private approval relay, private IP, password, token,
or machine-specific path. The public runtime remains explicitly:

- Hermes WebUI adapter;
- Codex CLI adapter;
- shared application/domain event model;
- PWA and local control server.

A private baseline bundle and file-level backup were created outside this
repository before editing. The backup is intentionally not part of the public
tree.

## Changes

### `apps/server/src/adapters/hermes/HermesApiClient.mjs`

- Flushes the final decoder buffer after an SSE stream closes.
- Preserves a final `event/data` frame when Hermes closes the response without
  the usual trailing blank line.
- Does not change authentication, timeout, request, or response behavior.

### `apps/server/src/adapters/hermes/HermesEventMapper.mjs`

- Maps Hermes task/run aliases used by WebUI health and Kanban responses:
  `run_id`, `runId`, `task_id`, `taskId`, `sessionId`, `conversationId`,
  `phase`, `stage`, and progress aliases.
- Converts `waiting` into the shared `waiting_approval` status.
- Converts numeric Unix timestamps into ISO timestamps.
- Exposes a live synthetic task when `/health` reports active runs but Kanban
  has no current task row.

### `apps/server/src/adapters/hermes/HermesRuntimeAdapter.mjs`

- Keeps the existing public Kanban routes and adds compatibility fallbacks for
  `/tasks`.
- Performs one read-only `/health` reconciliation after a Kanban snapshot.
- Merges a live WSL/CLI run into the task model immediately.
- Reconciles an old active Kanban card to `completed` only when Hermes
  explicitly reports idle and the card is older than the 60-second grace
  period.
- Never infers an approval decision or changes `waiting_approval` to
  `completed`.
- Does not add any private bridge dependency.

### `tests/hermes-webui-live.test.mjs`

Adds regression coverage for:

- live health-run mapping;
- waiting-status normalization;
- Kanban/live-health reconciliation;
- stale active-task reconciliation after explicit idle;
- SSE final-frame flush without a trailing delimiter.

## Verification Evidence

All checks below were run against the uncommitted public working tree:

| Check | Result |
|---|---|
| Consecutive test suites | **10/10 PASS** |
| Tests per suite | **16/16 PASS** |
| Total repeated test executions | **160/160 PASS** |
| JavaScript syntax files | **24/24 PASS** |
| `git diff --check` | **PASS** |
| Isolated local API smoke | **7/7 PASS** |
| Public boundary tests | **PASS** in every suite run |
| Live `.env` / private path scan | **PASS** |
| Production repository changes | **none** |

The isolated API smoke used loopback port `4257`, disabled both runtime
adapters, supplied only an in-memory test token, exercised the seven public
routes, and terminated its child server after the check. Production port
`4240` and all private runtime processes were left alone.

## What This Proves

The patch is internally consistent, syntax-valid, covered by local Hermes and
Codex fixtures, and remains inside the CLI-first public boundary. It directly
addresses the two confirmed adapter gaps: dropped terminal SSE frames and
missing live Hermes task visibility when Kanban is stale or empty.

## What This Does Not Prove

The current environment does not contain a clean external Hermes WebUI
deployment or an independent Codex CLI runtime fixture for every supported
operating system. Therefore this patch does not yet prove:

1. compatibility with every Hermes WebUI version;
2. external Hermes gateway configuration on a clean machine;
3. live approval delivery from every installed Codex CLI version;
4. secure mobile access through a user's chosen HTTPS or trusted VPN setup;
5. production hardening for multi-user exposure.

These are release-validation tasks, not reasons to add private Desktop code to
the public tree.

## Review and Rollout Gate

Do not push this working tree yet. Before the first public update:

1. review the four changed files and the new test file;
2. run `node --test tests/*.test.mjs` once more on the operator machine;
3. run a disposable Hermes WebUI read-only preflight;
4. run the documented short write/cancel test only against that disposable
   instance;
5. verify the staged file list contains no `.env`, backup, Desktop bridge,
   CDP, or machine-specific files;
6. commit only after those checks and explicit operator approval.

Suggested commit subject after approval:

```text
fix: reconcile live Hermes WebUI runs in CLI-first adapter
```

Suggested release note:

```text
CLI-first Hermes integration now preserves terminal SSE frames and reconciles
live WebUI health runs with Kanban task state. Codex Desktop remains outside
the public release.
```

## Proposed Commit Description

Use this subject and body after the final operator review:

```text
fix: reconcile live Hermes WebUI runs in CLI-first adapter

Preserve the final Hermes SSE frame when a stream closes without a trailing
delimiter, and normalize live Hermes health/run payloads into the shared task
model. Reconcile active WSL/CLI runs with Kanban state so the deck reflects
running and waiting-for-approval work immediately, while stale active cards are
closed only after Hermes explicitly reports idle and the grace period expires.

Add focused regression coverage for task aliases, timestamp normalization,
waiting approval state, live-run reconciliation, stale-task cleanup, and final
SSE frame handling. Keep the release CLI-first: Hermes WebUI and Codex CLI are
supported; Codex Desktop, CDP, Codex Micro, private bridge code, credentials,
and machine-specific configuration remain excluded.
```
