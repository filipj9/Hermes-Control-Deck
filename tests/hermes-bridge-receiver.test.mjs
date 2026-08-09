import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HermesBridgeError,
  HermesBridgeReceiver,
  normalizeHermesBridgeEvent
} from "../apps/server/src/adapters/hermes/HermesBridgeReceiver.mjs";

function fixture(overrides = {}) {
  return {
    event_id: "gateway-session-1-message-1:0",
    run_id: "gateway-session-1-message-1",
    seq: 0,
    event: "stream_start",
    created_at: "2026-08-01T12:56:51Z",
    session_id: "session-1",
    task_id: "gateway-session-1-message-1",
    profile: "default",
    source: "hermes-gateway-state-db",
    payload: { task_title: "Bridge contract test" },
    ...overrides
  };
}

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-control-bridge-"));
  const published = [];
  const config = {
    enabled: true,
    token: "test-token-which-is-long-enough",
    stateFile: path.join(directory, "state.json"),
    maxEventIds: 20,
    maxTrackedRuns: 20
  };
  const eventBus = { publish: (event) => published.push(event) };
  return { directory, published, config, eventBus };
}

test("accepts and maps a stream_start event", () => {
  const context = setup();
  const receiver = new HermesBridgeReceiver(context.config, context.eventBus);
  const result = receiver.accept(fixture());

  assert.equal(result.accepted, true);
  assert.equal(result.duplicate, false);
  assert.deepEqual(result.publishedTypes, ["task.created"]);
  assert.equal(context.published[0].source, "hermes");
  assert.equal(context.published[0].taskId, "hermes:bridge:gateway-session-1-message-1");
  assert.equal(context.published[0].payload.task.status, "running");
  assert.equal(context.published[0].payload.task.title, "Bridge contract test");
  assert.equal(receiver.listTasks()[0].id, "hermes:bridge:gateway-session-1-message-1");
});

test("deduplicates persisted event IDs across receiver restarts", () => {
  const context = setup();
  const first = new HermesBridgeReceiver(context.config, context.eventBus);
  first.accept(fixture());

  const secondPublished = [];
  const second = new HermesBridgeReceiver(context.config, { publish: (event) => secondPublished.push(event) });
  const result = second.accept(fixture());

  assert.equal(result.duplicate, true);
  assert.equal(secondPublished.length, 0);
  assert.equal(second.health().acceptedEventCount, 1);
  assert.equal(second.listTasks().length, 1);
});

test("rejects out-of-order events for a run", () => {
  const context = setup();
  const receiver = new HermesBridgeReceiver(context.config, context.eventBus);
  receiver.accept(fixture({ event_id: "run:2", seq: 2, event: "tool", payload: { tool_name: "shell" } }));

  assert.throws(
    () => receiver.accept(fixture({ event_id: "run:1", seq: 1, event: "reasoning" })),
    (error) => error instanceof HermesBridgeError && error.statusCode === 409 && error.code === "out_of_order"
  );
});

test("maps tool and done without exposing arbitrary payload fields", () => {
  const context = setup();
  const receiver = new HermesBridgeReceiver(context.config, context.eventBus);
  receiver.accept(fixture({ event_id: "run:1", seq: 1, event: "tool", payload: { tool_name: "shell", secret: "must-not-leak" } }));
  receiver.accept(fixture({ event_id: "run:2", seq: 2, event: "done", payload: { content_length: 42, content: "private response" } }));

  assert.equal(context.published[0].type, "task.progress");
  assert.equal(context.published[0].payload.message, "using shell");
  assert.equal(context.published[1].type, "task.completed");
  assert.equal(context.published[1].payload.task.metadata.contentLength, 42);
  assert.doesNotMatch(JSON.stringify(context.published), /must-not-leak|private response/);
});

test("requires a matching bearer or bridge header token", () => {
  const context = setup();
  const receiver = new HermesBridgeReceiver(context.config, context.eventBus);

  assert.doesNotThrow(() => receiver.authorize({ authorization: `Bearer ${context.config.token}` }));
  assert.doesNotThrow(() => receiver.authorize({ "x-hermes-control-token": context.config.token }));
  assert.throws(() => receiver.authorize({ authorization: "Bearer wrong" }), /Unauthorized/);
});

test("validates the source, stage and sequence", () => {
  assert.throws(() => normalizeHermesBridgeEvent(fixture({ event: "unknown" })), /Unsupported/);
  assert.throws(() => normalizeHermesBridgeEvent(fixture({ source: "untrusted" })), /Unsupported/);
  assert.throws(() => normalizeHermesBridgeEvent(fixture({ seq: -1 })), /non-negative/);
});

test("persists gateway approvals and delivers decisions with claim and ACK", () => {
  const context = setup();
  const receiver = new HermesBridgeReceiver(context.config, context.eventBus);
  receiver.accept(fixture({
    event_id: "approval-1:0",
    run_id: "approval-1",
    seq: 0,
    event: "approval_requested",
    session_id: "gateway-session",
    task_id: "gateway-run",
    source: "hermes-control-relay",
    payload: {
      approval_id: "approval-1",
      gateway_id: "laptop-a",
      command: "echo safe",
      question: "Allow command?",
      surface: "gateway"
    }
  }));

  assert.equal(receiver.listApprovals().length, 1);
  assert.equal(receiver.listApprovals()[0].metadata.transport, "gateway_bridge");
  assert.equal(context.published.at(-1).type, "approval.requested");
  assert.equal(context.published.at(-1).payload.task.status, "waiting_approval");

  const restarted = new HermesBridgeReceiver(context.config, context.eventBus);
  assert.equal(restarted.listApprovals()[0].id, "approval-1");
  const queued = restarted.queueDecision({ approvalId: "approval-1", choice: "once" });
  assert.equal(queued.status, "queued");
  assert.equal(restarted.queueDecision({ approvalId: "approval-1", choice: "once" }).duplicate, true);
  assert.throws(
    () => restarted.queueDecision({ approvalId: "approval-1", choice: "deny" }),
    (error) => error instanceof HermesBridgeError && error.code === "decision_conflict"
  );

  assert.deepEqual(restarted.claimDecisions({ gatewayId: "other-gateway" }), []);
  const [claimed] = restarted.claimDecisions({ gatewayId: "laptop-a", leaseMs: 5000 });
  assert.equal(claimed.id, queued.id);
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.attempts, 1);
  assert.equal(claimed.approval_id, "approval-1");
  assert.equal(claimed.gateway_id, "laptop-a");
  assert.equal(claimed.session_id, "gateway-session");
  assert.equal(claimed.choice, "once");
  const acked = restarted.ackDecision({
    decisionId: claimed.id,
    gatewayId: "laptop-a",
    status: "applied"
  });
  assert.equal(acked.status, "acked");

  restarted.accept(fixture({
    event_id: "approval-1:1",
    run_id: "approval-1",
    seq: 1,
    event: "approval_resolved",
    session_id: "gateway-session",
    task_id: "gateway-run",
    source: "hermes-control-relay",
    payload: {
      approval_id: "approval-1",
      gateway_id: "laptop-a",
      decision_id: claimed.id,
      choice: "once",
      status: "applied"
    }
  }));
  assert.equal(restarted.listApprovals().length, 0);
  assert.equal(context.published.at(-1).type, "approval.resolved");
});

test("accepts session_key aliases and emits the Hermes claim field names", () => {
  const context = setup();
  const receiver = new HermesBridgeReceiver(context.config, context.eventBus);
  receiver.accept(fixture({
    event_id: "approval-alias:0",
    run_id: "approval-alias",
    event: "approval_requested",
    session_id: undefined,
    session_key: "hermes-session-key",
    payload: {
      approval_id: "approval-alias",
      gateway_id: "laptop-a",
      command: "echo alias",
      question: "Allow command?",
      surface: "gateway"
    }
  }));

  const queued = receiver.queueDecision({ approvalId: "approval-alias", choice: "deny" });
  const [claimed] = receiver.claimDecisions({ gatewayId: "laptop-a" });
  assert.equal(queued.session_id, "hermes-session-key");
  assert.equal(claimed.approval_id, "approval-alias");
  assert.equal(claimed.gateway_id, "laptop-a");
  assert.equal(claimed.session_id, "hermes-session-key");
  assert.equal(claimed.choice, "deny");
});

test("echoes the top-level approval session and rejects payload-only session ids", () => {
  const context = setup();
  const receiver = new HermesBridgeReceiver(context.config, context.eventBus);
  receiver.accept(fixture({
    event_id: "approval-echo:0",
    run_id: "approval-echo",
    event: "approval_requested",
    session_id: "default",
    payload: {
      approval_id: "approval-echo",
      gateway_id: "laptop-a",
      session_id: "canonical-session-that-must-not-win",
      command: "echo echo",
      question: "Allow command?",
      surface: "gateway"
    }
  }));

  const queued = receiver.queueDecision({ approvalId: "approval-echo", choice: "allow" });
  assert.equal(queued.session_id, "default");
  const [claimed] = receiver.claimDecisions({ gatewayId: "laptop-a" });
  assert.equal(claimed.session_id, "default");

  assert.throws(
    () => normalizeHermesBridgeEvent(fixture({
      event_id: "approval-payload-only:0",
      run_id: "approval-payload-only",
      event: "approval_requested",
      session_id: undefined,
      payload: {
        approval_id: "approval-payload-only",
        gateway_id: "laptop-a",
        session_id: "canonical-session",
        command: "echo invalid",
        question: "Allow command?"
      }
    })),
    (error) => error instanceof HermesBridgeError && error.code === "invalid_approval_event"
  );
});

test("accepts top-level Hermes approval identifiers", () => {
  const context = setup();
  const receiver = new HermesBridgeReceiver(context.config, context.eventBus);
  receiver.accept(fixture({
    event_id: "approval-top-level:0",
    run_id: "approval-top-level",
    event: "approval_requested",
    session_id: "top-level-session",
    approval_id: "top-level-approval",
    gateway_id: "top-level-gateway",
    payload: {
      command: "echo top-level",
      question: "Allow command?",
      surface: "gateway"
    }
  }));

  receiver.queueDecision({ approvalId: "top-level-approval", choice: "once" });
  const [claimed] = receiver.claimDecisions({ gatewayId: "top-level-gateway" });
  assert.equal(claimed.approval_id, "top-level-approval");
  assert.equal(claimed.gateway_id, "top-level-gateway");
  assert.equal(claimed.session_id, "top-level-session");
});

test("failed gateway decision delivery returns approval and task to a retryable waiting state", () => {
  const context = setup();
  const receiver = new HermesBridgeReceiver(context.config, context.eventBus);
  receiver.accept(fixture({
    event_id: "approval-failed:0",
    run_id: "approval-failed",
    seq: 0,
    event: "approval_requested",
    session_id: "gateway-session-failed",
    task_id: "gateway-run-failed",
    source: "hermes-control-relay",
    payload: {
      approval_id: "approval-failed",
      gateway_id: "laptop-a",
      command: "Get-Date",
      question: "Allow command?",
      surface: "gateway"
    }
  }));
  const queued = receiver.queueDecision({ approvalId: "approval-failed", choice: "once" });
  receiver.claimDecisions({ gatewayId: "laptop-a", leaseMs: 5000 });

  receiver.ackDecision({
    decisionId: queued.id,
    gatewayId: "laptop-a",
    status: "failed",
    error: "gateway unavailable"
  });

  assert.equal(receiver.listApprovals()[0].status, "pending");
  assert.equal(receiver.listTasks()[0].status, "waiting_approval");
  assert.equal(context.published.at(-1).type, "approval.requested");
  assert.match(context.published.at(-1).payload.message, /retry required/);
  assert.doesNotThrow(() => receiver.queueDecision({ approvalId: "approval-failed", choice: "once" }));
});

test("expires a decision when Hermes no longer has the matching pending approval", () => {
  const context = setup();
  const receiver = new HermesBridgeReceiver(context.config, context.eventBus);
  receiver.accept(fixture({
    event_id: "approval-expired:0",
    run_id: "approval-expired",
    seq: 0,
    event: "approval_requested",
    session_id: "gateway-session-expired",
    task_id: "gateway-run-expired",
    source: "hermes-control-relay",
    payload: {
      approval_id: "approval-expired",
      gateway_id: "laptop-a",
      command: "echo expired",
      question: "Allow command?",
      surface: "cli"
    }
  }));
  const queued = receiver.queueDecision({ approvalId: "approval-expired", choice: "once" });
  receiver.claimDecisions({ gatewayId: "laptop-a", leaseMs: 5000 });

  receiver.ackDecision({
    decisionId: queued.id,
    gatewayId: "laptop-a",
    status: "failed",
    error: "No pending Hermes Gateway approval matched the decision"
  });

  assert.equal(receiver.listApprovals().length, 0);
  assert.equal(receiver.getApproval("approval-expired").status, "expired");
  assert.equal(receiver.listTasks()[0].status, "completed");
  assert.equal(context.published.at(-2).type, "approval.resolved");
  assert.equal(context.published.at(-2).payload.status, "expired");
  assert.equal(context.published.at(-1).type, "task.completed");
  assert.equal(context.published.at(-1).payload.approvalExpired, true);

  const restarted = new HermesBridgeReceiver(context.config, context.eventBus);
  assert.equal(restarted.listApprovals().length, 0);
  assert.equal(restarted.listTasks()[0].status, "completed");
});

test("reconciles an orphaned running task when a newer run in the same session completes", () => {
  const context = setup();
  const receiver = new HermesBridgeReceiver(context.config, context.eventBus);
  receiver.accept(fixture({
    event_id: "orphan:0",
    run_id: "orphan",
    task_id: "orphan",
    session_id: "shared-session",
    seq: 0,
    event: "reasoning",
    created_at: "2026-08-01T12:00:00Z"
  }));
  receiver.accept(fixture({
    event_id: "newer:0",
    run_id: "newer",
    task_id: "newer",
    session_id: "shared-session",
    seq: 0,
    event: "stream_start",
    created_at: "2026-08-01T12:01:00Z"
  }));
  receiver.accept(fixture({
    event_id: "newer:1",
    run_id: "newer",
    task_id: "newer",
    session_id: "shared-session",
    seq: 1,
    event: "done",
    created_at: "2026-08-01T12:02:00Z"
  }));

  const tasks = receiver.listTasks();
  assert.equal(tasks.find((task) => task.id.endsWith(":orphan")).status, "completed");
  assert.equal(tasks.find((task) => task.id.endsWith(":newer")).status, "completed");
});

test("repairs and persists orphaned active tasks while loading a legacy state file", () => {
  const context = setup();
  const orphanId = "hermes:bridge:legacy-orphan";
  const completedId = "hermes:bridge:legacy-completed";
  fs.writeFileSync(context.config.stateFile, JSON.stringify({
    version: 1,
    acceptedEventIds: [],
    lastSeqByRun: {},
    tasksById: {
      [orphanId]: {
        id: orphanId,
        source: "hermes",
        conversationId: "hermes:legacy-session",
        status: "running",
        createdAt: "2026-08-01T12:00:00Z",
        updatedAt: "2026-08-01T12:00:00Z",
        metadata: { lastActivity: "planning task..." }
      },
      [completedId]: {
        id: completedId,
        source: "hermes",
        conversationId: "hermes:legacy-session",
        status: "completed",
        createdAt: "2026-08-01T12:01:00Z",
        updatedAt: "2026-08-01T12:02:00Z",
        metadata: { lastActivity: "task complete" }
      }
    }
  }));

  const receiver = new HermesBridgeReceiver(context.config, context.eventBus);
  assert.equal(receiver.listTasks().find((task) => task.id === orphanId).status, "completed");
  const persisted = JSON.parse(fs.readFileSync(context.config.stateFile, "utf8"));
  assert.equal(persisted.version, 2);
  assert.equal(persisted.tasksById[orphanId].status, "completed");
  assert.equal(persisted.tasksById[orphanId].metadata.reconciled, true);
});

test("reconciles a stale bridge run only after an explicit healthy idle snapshot", () => {
  const context = setup();
  const receiver = new HermesBridgeReceiver(context.config, context.eventBus);
  receiver.accept(fixture({
    event_id: "idle-reconcile:0",
    run_id: "idle-reconcile",
    task_id: "idle-reconcile",
    event: "stream_start"
  }));

  assert.equal(receiver.reconcileWithRuntimeHealth({ status: "degraded", active_runs: 0, runs: [] }).length, 0);
  assert.equal(receiver.listTasks()[0].status, "running");

  const reconciled = receiver.reconcileWithRuntimeHealth({ status: "ok", active_runs: 0, runs: [] });
  assert.equal(reconciled.length, 1);
  assert.equal(receiver.listTasks()[0].status, "completed");
  assert.equal(receiver.listTasks()[0].metadata.lastActivity, "Hermes reports no active run");
  assert.equal(context.published.at(-1).type, "task.completed");
});

test("never clears a bridge task that still has a pending approval", () => {
  const context = setup();
  const receiver = new HermesBridgeReceiver(context.config, context.eventBus);
  receiver.accept(fixture({
    event_id: "approval-idle:0",
    run_id: "approval-idle",
    task_id: "approval-idle",
    event: "approval_requested",
    payload: {
      approval_id: "approval-idle-request",
      gateway_id: "gateway-idle",
      command: "echo approval",
      question: "Allow?"
    }
  }));

  assert.equal(receiver.listTasks()[0].status, "waiting_approval");
  assert.equal(receiver.reconcileWithRuntimeHealth({ status: "ok", active_runs: 0, runs: [] }).length, 0);
  assert.equal(receiver.listTasks()[0].status, "waiting_approval");
  assert.equal(receiver.listApprovals()[0].status, "pending");
});

test("keeps a fresh bridge run active while Hermes health catches up", () => {
  const context = setup();
  const receiver = new HermesBridgeReceiver(context.config, context.eventBus);
  receiver.accept(fixture({
    event_id: "fresh-run:0",
    run_id: "fresh-run",
    task_id: "fresh-run",
    created_at: new Date().toISOString(),
    event: "stream_start"
  }));

  assert.equal(receiver.reconcileWithRuntimeHealth({ status: "ok", active_runs: 0, runs: [] }).length, 0);
  assert.equal(receiver.listTasks()[0].status, "running");
});

test("retains all active approval records and only the newest terminal history", () => {
  const context = setup();
  context.config.maxTerminalApprovals = 2;
  const approvalsById = {
    pending: { id: "pending", status: "pending", updatedAt: "2026-08-01T00:00:00Z" }
  };
  const decisionsById = {
    queued: { id: "queued", status: "queued", updatedAt: "2026-08-01T00:00:00Z" }
  };
  for (let index = 0; index < 5; index += 1) {
    const timestamp = `2026-08-01T00:00:0${index}Z`;
    approvalsById[`terminal-${index}`] = { id: `terminal-${index}`, status: "resolved", updatedAt: timestamp };
    decisionsById[`terminal-${index}`] = { id: `terminal-${index}`, status: "acked", updatedAt: timestamp };
  }
  fs.writeFileSync(context.config.stateFile, JSON.stringify({
    version: 2,
    acceptedEventIds: [],
    lastSeqByRun: {},
    tasksById: {},
    approvalsById,
    decisionsById
  }));

  const receiver = new HermesBridgeReceiver(context.config, context.eventBus);
  receiver.persist();
  const persisted = JSON.parse(fs.readFileSync(context.config.stateFile, "utf8"));

  assert.deepEqual(Object.keys(persisted.approvalsById).sort(), ["pending", "terminal-3", "terminal-4"]);
  assert.deepEqual(Object.keys(persisted.decisionsById).sort(), ["queued", "terminal-3", "terminal-4"]);
});
