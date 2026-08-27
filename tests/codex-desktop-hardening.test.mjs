import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { CodexRuntimeAdapter } from "../apps/server/src/experimental/codex-desktop/CodexRuntimeAdapter.mjs";

function runtimeFixture({ observerManaged = true } = {}) {
  const published = [];
  const runtime = Object.create(CodexRuntimeAdapter.prototype);
  Object.assign(runtime, {
    source: "codex",
    tasks: [{
      id: "desktop-task",
      source: "codex",
      status: "running",
      progress: 30,
      conversationId: "codex:desktop:thread-one",
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
      metadata: {
        nativeDesktop: true,
        threadId: "thread-one",
        ...(observerManaged ? { sessionObserver: true, observedTurnId: "turn-one" } : {})
      }
    }],
    approvals: [],
    desktopIdleObservations: new Map(),
    latestSessionObserverSnapshot: observerManaged ? {
      threadId: "thread-one",
      turnId: "turn-one",
      hasTurnState: true,
      working: true,
      waitingApproval: false
    } : undefined,
    sessionObserver: observerManaged ? {} : undefined,
    eventBus: { publish: (event) => published.push(event) },
    expireUnboundDesktopTasks() {},
    unboundDesktopTaskForNativeSnapshot() { return undefined; },
    observerHasTerminalStateForThread() { return false; }
  });
  return { runtime, published };
}

const idleSnapshot = {
  activeThreadKey: "thread-one",
  activeThreadTitle: "Long task",
  working: false,
  waitingApproval: false,
  turnId: "turn-one",
  assistantText: "Intermediate response"
};

test("transient native idle cannot complete an observer-managed turn", () => {
  const { runtime, published } = runtimeFixture();
  for (let sample = 0; sample < 15; sample += 1) runtime.syncDesktopTaskState(idleSnapshot);
  assert.equal(runtime.tasks[0].status, "running");
  assert.equal(published.some((event) => event.type === "task.completed"), false);
});

test("matching observer terminal state can complete the turn", () => {
  const { runtime, published } = runtimeFixture();
  runtime.latestSessionObserverSnapshot = { ...runtime.latestSessionObserverSnapshot, working: false };
  runtime.syncDesktopTaskState(idleSnapshot);
  assert.equal(runtime.tasks[0].status, "completed");
  assert.equal(published.filter((event) => event.type === "task.completed").length, 1);
});

test("native-only fallback still completes after two idle samples", () => {
  const { runtime } = runtimeFixture({ observerManaged: false });
  runtime.syncDesktopTaskState(idleSnapshot);
  runtime.syncDesktopTaskState(idleSnapshot);
  assert.equal(runtime.tasks[0].status, "completed");
});

test("approval matching accepts keyboard hints while remaining exact", () => {
  const source = fs.readFileSync(
    new URL("../apps/server/src/experimental/codex-desktop/CodexDesktopBridge.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /enter\|return\|⏎\|↵/);
  assert.match(source, /esc\|escape/);
  assert.match(source, /\^\(allow\|allow once\|approve\|approve once/);
  assert.doesNotMatch(source, /allow notifications/);
});
