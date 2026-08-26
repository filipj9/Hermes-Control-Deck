import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const appSource = fs.readFileSync(new URL("../apps/web/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("terminal task state rejects late active events", () => {
  assert.match(appSource, /function shouldRejectLateLifecycleEvent/);
  assert.match(appSource, /if \(task && shouldRejectLateLifecycleEvent\(event, task\)\) return/);
  assert.match(appSource, /if \(lifecycleTask && shouldRejectLateLifecycleEvent\(event, lifecycleTask\)\) return/);
});

test("a different explicit turn may reuse a task id", () => {
  assert.match(appSource, /incomingTurn && currentTurn && String\(incomingTurn\) !== String\(currentTurn\)/);
});

test("task refresh preserves a newer terminal state", () => {
  assert.match(appSource, /state\.tasks = mergeTaskRefresh\(state\.tasks, data\.items \|\| \[\]\)/);
  assert.match(appSource, /!isTerminalTaskStatus\(prior\.status\) \|\| !isActiveTaskStatus\(task\.status\)/);
});

test("same-turn polling cannot revive terminal state even with a newer timestamp", () => {
  const start = appSource.indexOf("function isTerminalTaskStatus(");
  const end = appSource.indexOf("\nfunction renderSessions(", start);
  const context = vm.createContext({ result: undefined });
  vm.runInContext(`${appSource.slice(start, end)}\nresult = mergeTaskRefresh([{ id: "one", status: "completed", updatedAt: "2026-08-26T00:00:00Z", metadata: { turnId: "turn-one" } }], [{ id: "one", status: "running", updatedAt: "2026-08-26T00:10:00Z", metadata: { turnId: "turn-one" } }]);`, context);
  assert.equal(context.result[0].status, "completed");
});

test("an explicit different turn can start after terminal state", () => {
  const start = appSource.indexOf("function isTerminalTaskStatus(");
  const end = appSource.indexOf("\nfunction renderSessions(", start);
  const context = vm.createContext({ result: undefined });
  vm.runInContext(`${appSource.slice(start, end)}\nresult = mergeTaskRefresh([{ id: "one", status: "completed", metadata: { turnId: "turn-one" } }], [{ id: "one", status: "running", metadata: { turnId: "turn-two" } }]);`, context);
  assert.equal(context.result[0].status, "running");
});

test("every completed runtime schedules READY", () => {
  assert.match(
    appSource,
    /setRuntimeSignal\(event\.source, "done", "DONE", completedDetailForEvent\(event\), \{ unread: true \}\);[\s\S]*?scheduleRuntimeReady\(event\.source, 2200, \{ force: true \}\)/
  );
});

test("connected rendering cannot cancel an existing READY timer", () => {
  assert.match(appSource, /if \(state\.activityTimers\[source\] && status !== "connected"\)/);
  assert.match(appSource, /const signalUnchanged = state\.runtimeSignals\[source\]\?\.since === expectedSignalSince/);
});

test("active work polls tasks and approvals", () => {
  assert.match(appSource, /const hasActiveUiWork = state\.streams\.some/);
  assert.match(appSource, /refreshSection\("tasks"\)/);
  assert.match(appSource, /refreshSection\("approvals"\)/);
});

test("session selection refreshes state and focuses its output", () => {
  const start = appSource.indexOf("    if (conversationRow) {");
  const end = appSource.indexOf("\n    if (inspectorClose) {", start);
  const body = appSource.slice(start, end);
  assert.match(body, /focusConversationId = state\.selectedConversationId/);
  assert.match(body, /refreshSection\("tasks", \{ force: true \}\)/);
  assert.match(body, /refreshSection\("events", \{ force: true \}\)/);
  assert.match(body, /refreshRuntimes\(\{ force: true \}\)/);
});

test("runtime output follows the active runtime and selected conversation", () => {
  assert.match(appSource, /state\.streams\.filter\(\(stream\) => stream\.source === state\.activeRuntime\)/);
  assert.match(appSource, /stream\.conversationId === focusConversationId/);
});
