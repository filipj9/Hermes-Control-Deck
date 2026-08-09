import assert from "node:assert/strict";
import test from "node:test";

import { HermesRuntimeAdapter } from "../apps/server/src/adapters/hermes/HermesRuntimeAdapter.mjs";
import { toHermesTasks } from "../apps/server/src/adapters/hermes/HermesEventMapper.mjs";

test("maps a Hermes /health WSL run into the shared live task contract", () => {
  const [task] = toHermesTasks({
    active_runs: 1,
    runs: [{
      run_id: "wsl-run-1",
      session_id: "wsl-session-1",
      phase: "running",
      started_at: 1785761583.614903,
      workspace: "/home/example/workspace"
    }]
  });

  assert.equal(task.id, "hermes:wsl-run-1");
  assert.equal(task.conversationId, "hermes:wsl-session-1");
  assert.equal(task.status, "running");
  assert.equal(task.createdAt, "2026-08-03T12:53:03.614Z");
  assert.equal(task.metadata.workspace, "/home/example/workspace");
});

test("maps Hermes waiting phases to the visible approval state", () => {
  const [task] = toHermesTasks({
    active_runs: 1,
    active_session_id: "wsl-session-waiting",
    runs: [{ run_id: "wsl-run-waiting", phase: "waiting" }]
  });

  assert.equal(task.status, "waiting_approval");
  assert.equal(task.conversationId, "hermes:wsl-session-waiting");
});

test("promotes an active Hermes health run when Kanban only has history", async () => {
  const adapter = new HermesRuntimeAdapter({
    apiPrefix: "/api",
    baseUrl: "http://unused",
    profile: "default",
    timeoutMs: 3500
  }, { publish() {} }, { monitorExternalApprovals: false });

  adapter.client.firstJson = async () => ({
    route: "/api/kanban/tasks?status=all&sort=updated",
    data: {
      tasks: [{
        id: "old-task",
        title: "Completed history",
        status: "done",
        updated_at: "2026-08-03T13:00:00.000Z"
      }]
    }
  });
  adapter.client.health = async () => ({
    status: "ok",
    active_runs: 1,
    runs: [{
      run_id: "wsl-run-2",
      session_id: "wsl-session-2",
      phase: "running",
      started_at: 1785761583.614903
    }]
  });

  const tasks = await adapter.listTasks();
  const live = tasks.find((task) => task.id === "hermes:wsl-run-2");
  assert.equal(live?.status, "running");
  assert.equal(live?.conversationId, "hermes:wsl-session-2");
  assert.equal(tasks.some((task) => task.id === "hermes:old-task"), true);
});

test("reconciles stale Kanban activity without clearing fresh work or approvals", async () => {
  const adapter = new HermesRuntimeAdapter({
    apiPrefix: "/api",
    baseUrl: "http://unused",
    profile: "default",
    timeoutMs: 3500
  }, { publish() {} }, { monitorExternalApprovals: false });
  const now = Date.now();

  adapter.client.firstJson = async () => ({
    route: "/api/kanban/tasks?status=all&sort=updated",
    data: {
      tasks: [
        {
          id: "stale-running",
          title: "Orphaned run",
          status: "running",
          updated_at: new Date(now - 120_000).toISOString()
        },
        {
          id: "fresh-running",
          title: "Fresh run",
          status: "running",
          updated_at: new Date(now - 5_000).toISOString()
        },
        {
          id: "waiting-approval",
          title: "Approval still pending",
          status: "waiting_approval",
          updated_at: new Date(now - 120_000).toISOString()
        }
      ]
    }
  });
  adapter.client.health = async () => ({ status: "ok", active_runs: 0, runs: [] });

  const tasks = await adapter.listTasks();
  const stale = tasks.find((task) => task.id === "hermes:stale-running");
  const fresh = tasks.find((task) => task.id === "hermes:fresh-running");
  const waiting = tasks.find((task) => task.id === "hermes:waiting-approval");

  assert.equal(stale?.status, "completed");
  assert.equal(stale?.metadata.lastActivity, "Hermes reports no active run");
  assert.equal(fresh?.status, "running");
  assert.equal(waiting?.status, "waiting_approval");
});

test("uses the /api/v1 run approval fallback and preserves the health session", async () => {
  const adapter = new HermesRuntimeAdapter({
    apiPrefix: "/api",
    baseUrl: "http://unused",
    profile: "default",
    timeoutMs: 3500
  }, { publish() {} }, { monitorExternalApprovals: false });
  const requestedRoutes = [];

  adapter.client.request = async (route) => {
    requestedRoutes.push(route);
    if (route === "/health") {
      return {
        status: "ok",
        runs: [{ run_id: "wsl-run-3", session_id: "wsl-session-3", phase: "waiting_approval" }]
      };
    }
    if (route.startsWith("/api/sessions") || route.startsWith("/api/conversations") || route.startsWith("/sessions") || route.startsWith("/conversations")) {
      throw new Error("session discovery is unavailable in this fixture");
    }
    if (route === "/api/approval/pending?session_id=wsl-session-3") return { pending: undefined };
    if (route === "/api/runs/wsl-run-3/approval") throw new Error("legacy route unavailable");
    if (route === "/api/v1/runs/wsl-run-3/approval") {
      return { pending: { approval_id: "wsl-approval-3", command: "pwd", question: "Allow?" } };
    }
    throw new Error(`Unexpected route: ${route}`);
  };

  const [approval] = await adapter.listApprovals();
  assert.equal(approval.id, "wsl-approval-3");
  assert.equal(approval.conversationId, "hermes:wsl-session-3");
  assert.equal(approval.metadata.responseRoute, "/api/v1/runs/wsl-run-3/approval");
  assert.equal(requestedRoutes.includes("/api/v1/runs/wsl-run-3/approval"), true);
});
