import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const appSource = fs.readFileSync(new URL("../apps/web/app.js", import.meta.url), "utf8");
const cssSource = fs.readFileSync(new URL("../apps/web/styles.css", import.meta.url), "utf8");

test("terminal task events record bounded completion notices", () => {
  assert.match(appSource, /if \(isCompletionEvent\(event, task\)\) recordTaskCompletion\(event, task\)/);
  assert.match(appSource, /state\.completionNotices = \[notice, \.\.\.state\.completionNotices\.filter/);
  assert.match(appSource, /\.slice\(0, 20\)/);
});

test("completed task rows are buttons that open stored output", () => {
  assert.match(appSource, /data-task-response="\$\{escapeHtml\(task\.id\)\}"/);
  const body = appSource.match(/function openTaskResponse\(row\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(body, /ensureStoredTaskResponseStream/);
  assert.match(body, /panel\.dataset\.focusTaskId = taskId/);
  assert.match(body, /renderStreams\(\)/);
  assert.doesNotMatch(body, /postJson|runAction|fetch\(/);
});

test("completion badge is bounded and source-aware", () => {
  assert.match(appSource, /button\.dataset\.completionCount = String\(unreadCount\)/);
  assert.match(appSource, /notice\.source !== source/);
  assert.match(cssSource, /\.premium-nav-badge\[hidden\]/);
});

test("only the newest eight notices retain full output", () => {
  assert.match(appSource, /7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(appSource, /index < 8 \? notice : \{ \.\.\.notice, output: undefined \}/);
  assert.match(appSource, /const summariesOnly = persistable\.map/);
});

test("focused response reader is scrollable and preserves line breaks", () => {
  assert.match(appSource, /stream === focusedStream \? " is-focused"/);
  assert.match(cssSource, /max-height: min\(62vh, 680px\)/);
  assert.match(cssSource, /white-space: pre-wrap/);
});
