import assert from "node:assert/strict";
import test from "node:test";

import { CodexRuntimeAdapter } from "../apps/server/src/experimental/codex-desktop/CodexRuntimeAdapter.mjs";

test("background Desktop lifecycle preserves RUN STOP DENY and ALLOW semantics under an active root thread", async () => {
  const rootThread = "thread-root";
  const targetThread = "thread-target";
  const published = [];
  const runtime = Object.create(CodexRuntimeAdapter.prototype);
  Object.assign(runtime, {
    source: "codex",
    tasks: [],
    approvals: [],
    conversations: [],
    selectedAppThreadId: targetThread,
    activeAppThreadId: targetThread,
    desktopIdleObservations: new Map(),
    sessionObserverLastState: undefined,
    sessionObserverErrorReported: false,
    sessionObserverPolling: false,
    eventBus: { publish: (event) => published.push(event) }
  });

  let pendingApprovals = [];
  let targetedSnapshot;
  const rootSnapshot = () => ({
    threadId: rootThread,
    turnId: "turn-root",
    title: "Active root task",
    hasTurnState: true,
    working: true,
    waitingApproval: false,
    pendingApprovals: pendingApprovals.map((item) => ({ ...item })),
    detail: "exec",
    activitySequence: 100,
    updatedAt: new Date().toISOString()
  });
  runtime.sessionObserver = {
    snapshot: rootSnapshot,
    snapshotForThread: (threadId) => threadId === targetThread ? targetedSnapshot : undefined
  };

  const addTask = (id, submittedAt, overrides = {}) => {
    const task = {
      id,
      source: "codex",
      agentId: "codex:desktop",
      conversationId: `codex:desktop:${targetThread}`,
      title: id,
      status: "running",
      progress: 10,
      createdAt: new Date(submittedAt).toISOString(),
      updatedAt: new Date(submittedAt).toISOString(),
      metadata: {
        mode: "desktop",
        surface: "desktop",
        nativeDesktop: true,
        threadId: targetThread,
        promptSubmittedAtMs: submittedAt,
        submittedAtMs: submittedAt,
        observerBaseline: {
          threadId: rootThread,
          turnId: "turn-root",
          activitySequence: 100,
          updatedAt: new Date(submittedAt - 1_000).toISOString()
        }
      },
      ...overrides,
      metadata: {
        mode: "desktop",
        surface: "desktop",
        nativeDesktop: true,
        threadId: targetThread,
        promptSubmittedAtMs: submittedAt,
        submittedAtMs: submittedAt,
        observerBaseline: {
          threadId: rootThread,
          turnId: "turn-root",
          activitySequence: 100,
          updatedAt: new Date(submittedAt - 1_000).toISOString()
        },
        ...(overrides.metadata || {})
      }
    };
    runtime.tasks.unshift(task);
    return task;
  };
  const poll = () => {
    runtime.pollSessionObserver();
    runtime.sessionObserverPolling = false;
  };
  const targetState = (submittedAt, turnId, options = {}) => ({
    threadId: targetThread,
    turnId,
    title: options.title || "Background task",
    hasTurnState: true,
    working: options.working ?? false,
    terminalStatus: options.terminalStatus,
    waitingApproval: options.waitingApproval ?? false,
    pendingApprovals: options.pendingApprovals || [],
    detail: options.detail || "Task complete",
    activitySequence: options.activitySequence || 1,
    assistantText: options.assistantText,
    updatedAt: new Date(submittedAt + (options.offsetMs || 1_000)).toISOString()
  });

  // RUN: an older terminal result must be ignored until the new turn appears.
  const runAt = Date.now() - 20_000;
  const runTask = addTask("run", runAt);
  targetedSnapshot = targetState(runAt, "turn-old", {
    assistantText: "OLD ANSWER",
    offsetMs: -10_000,
    terminalStatus: "completed"
  });
  poll();
  assert.equal(runTask.status, "running");
  assert.equal(runTask.metadata.observedAssistantText, undefined);
  targetedSnapshot = targetState(runAt, "turn-run", {
    working: true,
    detail: "Turn started",
    offsetMs: 1_000
  });
  poll();
  assert.equal(runTask.status, "running");
  targetedSnapshot = targetState(runAt, "turn-run", {
    terminalStatus: "completed",
    assistantText: "RUN OK",
    offsetMs: 2_000
  });
  poll();
  assert.equal(runTask.status, "completed");
  assert.equal(runTask.metadata.observedAssistantText, "RUN OK");

  // STOP: native cancellation is preserved and later enriched from turn_aborted.
  const stopAt = Date.now() - 15_000;
  const stopTask = addTask("stop", stopAt);
  targetedSnapshot = targetState(stopAt, "turn-stop", {
    working: true,
    detail: "Turn started",
    offsetMs: 1_000
  });
  poll();
  stopTask.status = "cancelled";
  stopTask.progress = 100;
  stopTask.metadata.lastActivity = "task cancelled";
  stopTask.metadata.lastEventType = "task.completed";
  targetedSnapshot = targetState(stopAt, "turn-stop", {
    terminalStatus: "cancelled",
    detail: "Turn aborted",
    offsetMs: 2_000
  });
  poll();
  assert.equal(stopTask.status, "cancelled");
  assert.equal(stopTask.metadata.observedDetail, "Turn aborted");
  assert.equal(stopTask.metadata.lastActivity, "Turn aborted");

  // DENY: a concurrent root poll cannot expire the target approval, and the
  // assistant's safe continuation cannot replace blocked with completed.
  const denyAt = Date.now() - 10_000;
  const denyTask = addTask("deny", denyAt);
  const approvalItem = {
    threadId: targetThread,
    turnId: "turn-deny",
    title: "DENY task",
    callId: "call-deny",
    approvalDetection: "session-jsonl/escalated-tool-call",
    updatedAt: new Date(denyAt + 1_000).toISOString()
  };
  pendingApprovals = [approvalItem];
  targetedSnapshot = targetState(denyAt, "turn-deny", {
    working: true,
    waitingApproval: true,
    pendingApprovals: [approvalItem],
    detail: "Waiting for approval",
    offsetMs: 1_000
  });
  poll();
  const denyApproval = runtime.approvals.find((item) => item.metadata?.callId === "call-deny");
  assert.equal(denyTask.status, "waiting_approval");
  assert.equal(denyApproval.status, "pending");

  runtime.desktopBridge = {
    isConnected: () => true,
    activateThread: async () => {},
    snapshot: async () => ({ waitingApproval: true }),
    reject: async () => {
      pendingApprovals = [];
      runtime.syncSessionObserverState(rootSnapshot());
      return { waitingApproval: false };
    }
  };
  await runtime.decideObservedDesktopApproval({ decision: "reject" }, denyApproval);
  assert.equal(denyApproval.status, "rejected");
  assert.equal(denyTask.status, "blocked");
  assert.equal(denyTask.metadata.lastActivity, "approval denied");
  targetedSnapshot = targetState(denyAt, "turn-deny", {
    terminalStatus: "completed",
    assistantText: "DENY FINISHED",
    offsetMs: 2_000
  });
  poll();
  assert.equal(denyTask.status, "blocked");
  assert.equal(denyTask.metadata.lastActivity, "approval denied");
  assert.equal(denyTask.metadata.observedAssistantText, "DENY FINISHED");

  // ALLOW: approval returns to running, then the exact target turn completes.
  const allowAt = Date.now() - 5_000;
  const allowTask = addTask("allow", allowAt);
  const allowApprovalItem = {
    threadId: targetThread,
    turnId: "turn-allow",
    title: "ALLOW task",
    callId: "call-allow",
    approvalDetection: "session-jsonl/escalated-tool-call",
    updatedAt: new Date(allowAt + 1_000).toISOString()
  };
  pendingApprovals = [allowApprovalItem];
  targetedSnapshot = targetState(allowAt, "turn-allow", {
    working: true,
    waitingApproval: true,
    pendingApprovals: [allowApprovalItem],
    detail: "Waiting for approval",
    offsetMs: 1_000
  });
  runtime.desktopBridge = undefined;
  poll();
  const allowApproval = runtime.approvals.find((item) => item.metadata?.callId === "call-allow");
  runtime.desktopBridge = {
    isConnected: () => true,
    activateThread: async () => {},
    snapshot: async () => ({ waitingApproval: true }),
    approve: async () => {
      pendingApprovals = [];
      return { waitingApproval: false };
    }
  };
  await runtime.decideObservedDesktopApproval({ decision: "approve" }, allowApproval);
  assert.equal(allowApproval.status, "approved");
  assert.equal(allowTask.status, "running");
  targetedSnapshot = targetState(allowAt, "turn-allow", {
    terminalStatus: "completed",
    assistantText: "ALLOW FINISHED",
    offsetMs: 2_000
  });
  poll();
  assert.equal(allowTask.status, "completed");
  assert.equal(allowTask.metadata.observedAssistantText, "ALLOW FINISHED");

  assert.equal(published.some((event) => event.type === "runtime.error"), false);
});
