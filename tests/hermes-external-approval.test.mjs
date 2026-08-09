import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HermesBridgeReceiver } from "../apps/server/src/adapters/hermes/HermesBridgeReceiver.mjs";
import { HermesRuntimeAdapter } from "../apps/server/src/adapters/hermes/HermesRuntimeAdapter.mjs";

test("routes a gateway approval through the bridge without calling Hermes WebUI", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-external-approval-"));
  try {
    const receiver = new HermesBridgeReceiver({
      enabled: true,
      token: "test-token-with-at-least-24-characters",
      stateFile: path.join(dir, "receiver.json"),
      maxEventIds: 100,
      maxTrackedRuns: 100
    }, { publish() {} });
    receiver.accept({
      event_id: "approval-imessage-1:0",
      run_id: "approval-imessage-1",
      seq: 0,
      event: "approval_requested",
      session_id: "imessage-session-1",
      task_id: "bridge-run-1",
      source: "hermes-control-relay",
      payload: {
        approval_id: "approval-imessage-1",
        gateway_id: "laptop-a",
        command: "safe command",
        question: "Allow this command?",
        surface: "gateway"
      }
    });

    const published = [];
    const requests = [];
    const adapter = new HermesRuntimeAdapter({
      apiPrefix: "/api",
      baseUrl: "http://unused",
      profile: "default",
      timeoutMs: 3500
    }, { publish: (event) => published.push(event) }, {
      bridgeReceiver: receiver,
      monitorExternalApprovals: false
    });
    adapter.client.request = async (route, options = {}) => {
      requests.push({ route, options });
      if (route === "/health") return { runs: [] };
      throw new Error(`Unexpected route: ${route}`);
    };

    const approvals = await adapter.listApprovals();
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].conversationId, "hermes:imessage-session-1");
    assert.equal(approvals[0].metadata.transport, "gateway_bridge");

    const result = await adapter.decideApproval({
      approvalId: "approval-imessage-1",
      decision: "approve",
      approvalScope: "once"
    });
    assert.equal(result.status, "pending");
    assert.equal(result.metadata.transport, "gateway_bridge");
    assert.equal(requests.some((request) => request.route.includes("/approval/")), false);
    const [decision] = receiver.claimDecisions({ gatewayId: "laptop-a" });
    assert.equal(decision.approvalId, "approval-imessage-1");
    assert.equal(decision.choice, "once");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("routes a bridge decision when the UI approval cache has no id", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-approval-cache-gap-"));
  try {
    const receiver = new HermesBridgeReceiver({
      enabled: true,
      token: "test-token-with-at-least-24-characters",
      stateFile: path.join(dir, "receiver.json"),
      maxEventIds: 100,
      maxTrackedRuns: 100
    }, { publish() {} });
    receiver.accept({
      event_id: "cache-gap:0",
      run_id: "cache-gap",
      seq: 0,
      event: "approval_requested",
      session_id: "cache-gap-session",
      task_id: "cache-gap-task",
      source: "hermes-control-relay",
      payload: {
        approval_id: "cache-gap-approval",
        gateway_id: "laptop-a",
        command: "echo safe",
        question: "Allow?",
        surface: "gateway"
      }
    });

    const requests = [];
    const adapter = new HermesRuntimeAdapter({
      apiPrefix: "/api",
      baseUrl: "http://unused",
      profile: "default",
      timeoutMs: 3500
    }, { publish() {} }, {
      bridgeReceiver: receiver,
      monitorExternalApprovals: false
    });
    adapter.client.request = async (route) => {
      requests.push(route);
      throw new Error(`Unexpected WebUI route: ${route}`);
    };

    const result = await adapter.decideApproval({
      decision: "reject",
      conversationId: "hermes:cache-gap-session"
    });
    assert.equal(result.status, "pending");
    assert.equal(result.metadata.transport, "gateway_bridge");
    assert.equal(requests.length, 0);

    const [decision] = receiver.claimDecisions({ gatewayId: "laptop-a" });
    assert.equal(decision.approvalId, "cache-gap-approval");
    assert.equal(decision.choice, "deny");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("returns a bridge approval without waiting for an unreachable WebUI scan", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-fast-approval-"));
  try {
    const receiver = new HermesBridgeReceiver({
      enabled: true,
      token: "test-token-with-at-least-24-characters",
      stateFile: path.join(dir, "receiver.json"),
      maxEventIds: 100,
      maxTrackedRuns: 100
    }, { publish() {} });
    receiver.accept({
      event_id: "fast-approval:0",
      run_id: "fast-approval",
      seq: 0,
      event: "approval_requested",
      session_id: "fast-session",
      task_id: "fast-run",
      source: "hermes-control-relay",
      payload: {
        approval_id: "fast-approval",
        gateway_id: "laptop-a",
        command: "pwd",
        question: "Allow?",
        surface: "gateway"
      }
    });
    const adapter = new HermesRuntimeAdapter({
      apiPrefix: "/api",
      baseUrl: "http://unreachable",
      profile: "default",
      timeoutMs: 3500
    }, { publish() {} }, {
      bridgeReceiver: receiver,
      monitorExternalApprovals: false
    });
    adapter.client.request = () => new Promise(() => {});

    const startedAt = Date.now();
    const approvals = await adapter.listApprovals();
    assert.equal(approvals[0].id, "fast-approval");
    assert.ok(Date.now() - startedAt < 100, "bridge approval should be returned from local state immediately");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discovers an approval from an active Hermes WebUI run without a bridge event", async () => {
  const published = [];
  const adapter = new HermesRuntimeAdapter({
    apiPrefix: "/api",
    baseUrl: "http://unused",
    profile: "default",
    timeoutMs: 3500
  }, { publish: (event) => published.push(event) }, {
    externalSessionIds: () => [],
    monitorExternalApprovals: false
  });
  adapter.client.request = async (route) => {
    if (route === "/health") {
      return { runs: [{ session_id: "wsl-direct-session", phase: "running" }] };
    }
    if (route.includes("approval/pending")) {
      assert.match(route, /session_id=wsl-direct-session/);
      return {
        pending: {
          approval_id: "approval-wsl-1",
          command: "pwd",
          question: "Allow WSL command?"
        }
      };
    }
    throw new Error("Unexpected route: " + route);
  };

  const approvals = await adapter.listApprovals();
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].conversationId, "hermes:wsl-direct-session");
  assert.equal(published.filter((event) => event.type === "approval.requested").length, 1);
});

test("polls and resolves an approval from an active Hermes OS Cat session without history discovery", async () => {
  const published = [];
  const requests = [];
  let responseRequest;
  const adapter = new HermesRuntimeAdapter({
    apiPrefix: "/api",
    baseUrl: "http://unused",
    profile: "default",
    timeoutMs: 3500
  }, { publish: (event) => published.push(event) }, {
    monitorExternalApprovals: false
  });
  adapter.client.request = async (route, options = {}) => {
    requests.push({ route, options });
    if (route === "/health") {
      return { active_runs: 1, runs: [{ session_id: "os-cat-session", run_id: "os-cat-run" }] };
    }
    if (route === "/api/approval/pending?session_id=os-cat-session") {
      return {
        pending: {
          approval_id: "approval-os-cat-1",
          command: "safe os cat command",
          question: "Allow Hermes OS Cat to continue?"
        }
      };
    }
    if (route === "/api/approval/respond") {
      responseRequest = options;
      return { ok: true };
    }
    throw new Error("Unexpected route: " + route);
  };

  const approvals = await adapter.listApprovals();
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].id, "approval-os-cat-1");
  assert.equal(approvals[0].conversationId, "hermes:os-cat-session");
  assert.equal(approvals[0].metadata.externalSession, true);

  const result = await adapter.decideApproval({
    approvalId: "approval-os-cat-1",
    decision: "approve",
    approvalScope: "once"
  });
  assert.equal(result.status, "approved");
  assert.equal(responseRequest.body.session_id, "os-cat-session");
  assert.equal(responseRequest.body.approval_id, "approval-os-cat-1");
  assert.equal(responseRequest.body.choice, "once");
  assert.equal(published.filter((event) => event.type === "approval.requested").length, 1);
  assert.equal(requests.some(({ route }) => route.includes("/sessions/search")), false);
});

test("does not poll historical bridge sessions when Hermes has no active run", async () => {
  const requests = [];
  const adapter = new HermesRuntimeAdapter({
    apiPrefix: "/api",
    baseUrl: "http://unused",
    profile: "default",
    timeoutMs: 3500
  }, { publish() {} }, {
    monitorExternalApprovals: false,
    bridgeReceiver: {
      listRecentSessionIds: () => Array.from({ length: 50 }, (_, index) => `old-session-${index}`)
    }
  });
  adapter.client.request = async (route) => {
    requests.push(route);
    if (route === "/health") return { active_runs: 0, runs: [] };
    throw new Error(`Unexpected route: ${route}`);
  };

  const approvals = await adapter.performExternalApprovalScan();
  assert.deepEqual(approvals, []);
  assert.deepEqual(requests, ["/health"]);
  assert.equal(adapter.externalApprovalLastCheckedSessionCount, 0);
});

test("polls only active health sessions and exposes the bounded poll interval", async () => {
  const requests = [];
  const adapter = new HermesRuntimeAdapter({
    apiPrefix: "/api",
    baseUrl: "http://unused",
    profile: "default",
    timeoutMs: 3500,
    externalApprovalPollMs: 20
  }, { publish() {} }, { monitorExternalApprovals: false });
  adapter.client.request = async (route) => {
    requests.push(route);
    if (route === "/health") {
      return { active_runs: 1, runs: [{ session_id: "active-session", run_id: "active-run" }] };
    }
    if (route === "/api/approval/pending?session_id=active-session") return {};
    if (route.includes("/runs/active-run/approval")) return {};
    throw new Error(`Unexpected route: ${route}`);
  };

  await adapter.performExternalApprovalScan();
  assert.equal(adapter.externalApprovalPollMs, 2000);
  assert.equal(requests.filter((route) => route.includes("/approval/pending")).length, 1);
  assert.equal(requests.some((route) => route.includes("old-session")), false);
});

test("throttles repeated approval scans regardless of UI call frequency", async () => {
  let healthRequests = 0;
  const adapter = new HermesRuntimeAdapter({
    apiPrefix: "/api",
    baseUrl: "http://unused",
    profile: "default",
    timeoutMs: 3500
  }, { publish() {} }, { monitorExternalApprovals: false });
  adapter.client.request = async (route) => {
    if (route === "/health") {
      healthRequests += 1;
      return { active_runs: 0, runs: [] };
    }
    throw new Error(`Unexpected route: ${route}`);
  };

  await Promise.all([
    adapter.scanExternalApprovals(),
    adapter.scanExternalApprovals(),
    adapter.scanExternalApprovals()
  ]);
  await adapter.scanExternalApprovals();
  assert.equal(healthRequests, 1);

  adapter.externalApprovalLastScanAt = Date.now() - adapter.externalApprovalPollMs - 1;
  await adapter.scanExternalApprovals();
  assert.equal(healthRequests, 2);
});
