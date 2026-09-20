import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexSessionObserver } from "../apps/server/src/experimental/codex-desktop/CodexSessionObserver.mjs";

function writeEvent(filePath, event) {
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
}

function fixture() {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-control-observer-"));
  const sessions = path.join(codexHome, "sessions", "2026", "08", "02");
  fs.mkdirSync(sessions, { recursive: true });
  const threadId = "00000000-0000-4000-8000-000000000001";
  const filePath = path.join(sessions, `rollout-2026-08-02T00-00-00-${threadId}.jsonl`);
  writeEvent(filePath, { type: "session_meta", payload: { thread_source: "user" } });
  writeEvent(filePath, { type: "turn_context", payload: { turn_id: "turn-1" } });
  return { codexHome, filePath };
}

test("Codex 0.153 task_complete error is failed and never reuses an older answer", () => {
  const observer = new CodexSessionObserver();
  const ingest = (type, payload) => observer.ingestLine(JSON.stringify({ type, payload, timestamp: new Date().toISOString() }));
  ingest("turn_context", { turn_id: "old" });
  ingest("event_msg", { type: "task_complete", turn_id: "old", last_agent_message: "OLD ANSWER" });
  ingest("event_msg", { type: "task_started", turn_id: "new" });
  assert.equal(observer.snapshotValue.assistantText, undefined);
  assert.equal(observer.snapshotValue.working, true);
  assert.equal(observer.snapshotValue.turnId, "new");
  ingest("turn_context", { turn_id: "new" });
  ingest("event_msg", { type: "task_complete", turn_id: "new", last_agent_message: null,
    error: { message: "Usage limit reached", codex_error_info: "usage_limit_exceeded" } });
  assert.equal(observer.snapshotValue.terminalStatus, "failed");
  assert.equal(observer.snapshotValue.working, false);
  assert.equal(observer.snapshotValue.assistantText, undefined);
  assert.equal(observer.snapshotValue.detail, "Usage limit reached");
  ingest("event_msg", { type: "task_complete", turn_id: "old", last_agent_message: "OLD ANSWER" });
  assert.equal(observer.snapshotValue.terminalStatus, "failed");
  assert.equal(observer.snapshotValue.assistantText, undefined);
});

test("successful task_complete without an answer does not retain previous-turn text", () => {
  const observer = new CodexSessionObserver();
  observer.ingestLine(JSON.stringify({ type:"turn_context", payload:{turn_id:"one"} }));
  observer.ingestLine(JSON.stringify({ type:"event_msg", payload:{type:"task_complete",turn_id:"one",last_agent_message:"OLD"} }));
  observer.ingestLine(JSON.stringify({ type:"turn_context", payload:{turn_id:"two"} }));
  observer.ingestLine(JSON.stringify({ type:"event_msg", payload:{type:"task_complete",turn_id:"two",last_agent_message:null} }));
  assert.equal(observer.snapshotValue.terminalStatus,"completed");
  assert.equal(observer.snapshotValue.assistantText,undefined);
});

test("keeps an escalated Codex Desktop tool call waiting until its matching output", (t) => {
  const { codexHome, filePath } = fixture();
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));

  writeEvent(filePath, {
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: "approval-call-1",
      input: 'await tools.shell_command({"command":"Get-Date","sandbox_permissions":"require_escalated","justification":"Allow test?"})'
    }
  });

  const observer = new CodexSessionObserver({ codexHome });
  let snapshot = observer.snapshot();
  assert.equal(snapshot.waitingApproval, true);
  assert.equal(snapshot.approvalCallId, "approval-call-1");
  assert.equal(snapshot.approvalDetection, "session-jsonl/escalated-tool-call");
  assert.equal(snapshot.detail, "Waiting for approval");

  writeEvent(filePath, {
    type: "response_item",
    payload: { type: "message", role: "assistant", content: "Still waiting" }
  });
  snapshot = observer.snapshot();
  assert.equal(snapshot.waitingApproval, true);

  writeEvent(filePath, {
    type: "response_item",
    payload: { type: "custom_tool_call_output", call_id: "different-call", output: "done" }
  });
  snapshot = observer.snapshot();
  assert.equal(snapshot.waitingApproval, true);

  writeEvent(filePath, {
    type: "response_item",
    payload: { type: "custom_tool_call_output", call_id: "approval-call-1", output: "done" }
  });
  snapshot = observer.snapshot();
  assert.equal(snapshot.waitingApproval, false);
  assert.equal(snapshot.approvalCallId, undefined);
});

test("keeps a Codex request_permissions call waiting until its matching output", (t) => {
  const { codexHome, filePath } = fixture();
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  writeEvent(filePath, {
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: "permission-call-1",
      input: 'const result = await tools.request_permissions({ permissions: { network: { enabled: true } }, reason: "test" });'
    }
  });
  const observer = new CodexSessionObserver({ codexHome });
  let snapshot = observer.snapshot();
  assert.equal(snapshot.waitingApproval, true);
  assert.equal(snapshot.approvalCallId, "permission-call-1");
  writeEvent(filePath, {
    type: "response_item",
    payload: { type: "custom_tool_call_output", call_id: "permission-call-1", output: "denied" }
  });
  snapshot = observer.snapshot();
  assert.equal(snapshot.waitingApproval, false);
});

test("does not classify a regular tool call as an approval", (t) => {
  const { codexHome, filePath } = fixture();
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  writeEvent(filePath, {
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: "normal-call",
      input: 'await tools.shell_command({"command":"Get-Date"})'
    }
  });

  const snapshot = new CodexSessionObserver({ codexHome }).snapshot();
  assert.equal(snapshot.waitingApproval, false);
});

test("finds an approval in a background session while another session is newer", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-control-observer-multi-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const sessions = path.join(codexHome, "sessions", "2026", "08", "02");
  fs.mkdirSync(sessions, { recursive: true });
  const backgroundId = "00000000-0000-4000-8000-000000000002";
  const foregroundId = "00000000-0000-4000-8000-000000000001";
  const background = path.join(sessions, `rollout-background-${backgroundId}.jsonl`);
  const foreground = path.join(sessions, `rollout-foreground-${foregroundId}.jsonl`);

  writeEvent(background, { type: "session_meta", payload: { thread_source: "subagent" } });
  writeEvent(background, { type: "turn_context", payload: { turn_id: "background-turn" } });
  writeEvent(background, {
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell_command",
      call_id: "background-approval",
      arguments: '{"command":"Get-Date","sandbox_permissions":"require_escalated","justification":"Background test"}'
    }
  });
  writeEvent(foreground, { type: "session_meta", payload: { thread_source: "user" } });
  writeEvent(foreground, { type: "turn_context", payload: { turn_id: "foreground-turn" } });
  writeEvent(foreground, {
    type: "response_item",
    payload: { type: "custom_tool_call", name: "exec", call_id: "normal", input: "Get-Date" }
  });
  const future = new Date(Date.now() + 1000);
  fs.utimesSync(foreground, future, future);

  const snapshot = new CodexSessionObserver({ codexHome }).snapshot();
  assert.equal(snapshot.threadId, foregroundId, "foreground session should remain the active display session");
  assert.equal(snapshot.waitingApproval, false, "foreground session is not waiting");
  assert.equal(snapshot.pendingApprovals.length, 1);
  assert.equal(snapshot.pendingApprovals[0].threadId, backgroundId);
  assert.equal(snapshot.pendingApprovals[0].callId, "background-approval");
});

test("turn_aborted cancels the observed turn and late tool output cannot reactivate it", (t) => {
  const { codexHome, filePath } = fixture();
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));

  writeEvent(filePath, {
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: "stop-call",
      input: "Start-Sleep -Seconds 30"
    }
  });
  writeEvent(filePath, {
    type: "event_msg",
    payload: { type: "turn_aborted", turn_id: "turn-1" }
  });

  const observer = new CodexSessionObserver({ codexHome });
  let snapshot = observer.snapshot();
  assert.equal(snapshot.working, false);
  assert.equal(snapshot.waitingApproval, false);
  assert.equal(snapshot.terminalStatus, "cancelled");
  assert.equal(snapshot.detail, "Turn aborted");

  writeEvent(filePath, {
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "late completion" }
  });
  writeEvent(filePath, {
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: "stop-call",
      output: "late command completion"
    }
  });
  snapshot = observer.snapshot();
  assert.equal(snapshot.working, false);
  assert.equal(snapshot.terminalStatus, "cancelled");
  assert.equal(snapshot.detail, "Turn aborted");

  writeEvent(filePath, { type: "turn_context", payload: { turn_id: "turn-2" } });
  writeEvent(filePath, {
    type: "event_msg",
    payload: { type: "user_message", message: "new turn" }
  });
  snapshot = observer.snapshot();
  assert.equal(snapshot.turnId, "turn-2");
  assert.equal(snapshot.working, true);
  assert.equal(snapshot.terminalStatus, undefined);
});
