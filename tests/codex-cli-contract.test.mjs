import assert from "node:assert/strict";
import test from "node:test";
import { CodexRuntimeAdapter } from "../apps/server/src/adapters/codex/CodexRuntimeAdapter.mjs";
import { EventBus } from "../apps/server/src/infrastructure/EventBus.mjs";

test("Codex CLI JSONL fixture maps approval, stdout events, stderr, completion, and STOP", async () => {
  const eventBus = new EventBus();
  const writes = [];
  const callbacks = new Map();
  let pid = 4000;
  const fakeCli = {
    isAvailable: () => true,
    async describeRuntime() {
      return { available: true, executable: "fixture-codex", version: "fixture", workdirExists: true, activeRuns: callbacks.size };
    },
    start(prompt, options) {
      callbacks.set(options.taskId, options);
      queueMicrotask(() => {
        options.onEvent({ type: "thread.started", thread_id: "thread-fixture" });
        options.onEvent({ type: "turn.started" });
        options.onStderr("fixture diagnostic");
        options.onEvent({
          type: "approval.requested",
          approval: { id: "approval-1", command: "touch fixture.txt", question: "Allow fixture command?" }
        });
      });
      return { pid: pid++, args: ["fixture", "--json"], startedAt: new Date().toISOString() };
    },
    write(taskId, text) {
      writes.push({ taskId, text });
      const options = callbacks.get(taskId);
      if (text === "once\n") {
        queueMicrotask(() => {
          options.onEvent({ type: "item.completed", item: { type: "command_execution", text: "ok" } });
          options.onEvent({ type: "turn.completed", text: "done" });
          options.onExit({ code: 0, signal: null, timedOut: false });
        });
      }
      return true;
    },
    async stop(taskId) {
      callbacks.delete(taskId);
      return true;
    }
  };

  const adapter = new CodexRuntimeAdapter({
    workdir: process.cwd(),
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    profile: "default",
    model: "",
    runTimeoutMs: 1000,
    stopTimeoutMs: 1000,
    allowConcurrentRuns: false,
    maxPromptChars: 1000
  }, eventBus);
  adapter.cli = fakeCli;

  const run = await adapter.sendMessage({ content: "fixture task", reasoning: "med" });
  await waitFor(() => adapter.listApprovals().then((items) => items.length === 1));
  const pending = (await adapter.listApprovals())[0];
  assert.equal(pending.title, "touch fixture.txt");

  const approved = await adapter.decideApproval({ approvalId: pending.id, decision: "approve" });
  assert.equal(approved.status, "approved");
  assert.equal(writes[0].text, "once\n");
  await waitFor(() => adapter.listTasks().then((items) => items[0].status === "completed"));

  const events = eventBus.list(100);
  assert.equal(events.some((event) => event.type === "approval.requested"), true);
  assert.equal(events.some((event) => event.type === "worker.updated"), true);
  assert.equal(events.some((event) => event.type === "task.completed"), true);
  assert.equal(events.some((event) => event.type === "runtime.error" && event.payload.error === "fixture diagnostic"), true);

  const second = await adapter.sendMessage({ content: "fixture stop" });
  const stopped = await adapter.cancelTask(second.task.id);
  assert.equal(stopped.stopped, true);
  assert.equal((await adapter.listTasks())[0].status, "cancelled");
});

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for Codex CLI fixture.");
}
