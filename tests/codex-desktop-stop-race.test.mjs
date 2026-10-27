import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { CodexDesktopBridge } from "../apps/server/src/experimental/codex-desktop/CodexDesktopBridge.mjs";
import { CodexRuntimeAdapter } from "../apps/server/src/experimental/codex-desktop/CodexRuntimeAdapter.mjs";

class StopHarness extends CodexDesktopBridge {
  constructor(context) {
    super({ desktopCdpPort: 4248, desktopBridgeRequestTimeoutMs: 6000 });
    this.context = context;
  }

  async ensureConnected() {}

  async evaluate(expression) {
    return vm.runInNewContext(expression, this.context);
  }

  async clickPoint(x, y) {
    return this.context.__clickPoint?.(x, y);
  }
}

test("Desktop STOP confirms one native CDP click after the control disappears", async () => {
  let scans = 0;
  let clicks = 0;
  let stopped = false;
  const stopControl = {
    disabled: false,
    textContent: "Stop",
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 20 }),
    click() {
      clicks += 1;
      stopped = true;
    }
  };
  const bridge = new StopHarness({
    document: {
      querySelectorAll() {
        scans += 1;
        if (scans < 3 || stopped) return [];
        return [stopControl];
      }
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    Date,
    Promise,
    __clickPoint() { stopControl.click(); }
  });

  const result = await bridge.stop();

  assert.equal(result.confirmed, true);
  assert.equal(result.mechanism, "native-cdp-click");
  assert.ok(scans >= 3);
  assert.equal(clicks, 1);
});

test("Desktop STOP catches a replacement control after the provisional control disappears", async () => {
  const clicks = [];
  let current;
  const activeStop = {
    disabled: false,
    textContent: "Stop active turn",
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 20 }),
    click() {
      clicks.push("active");
      current = null;
    }
  };
  const provisionalStop = {
    disabled: false,
    textContent: "Stop provisional submit",
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 20 }),
    click() {
      clicks.push("provisional");
      current = null;
      setTimeout(() => { current = activeStop; }, 250);
    }
  };
  current = provisionalStop;
  const bridge = new StopHarness({
    document: { querySelectorAll() { return current ? [current] : []; } },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    Date,
    Promise,
    __clickPoint() { current?.click(); }
  });

  const result = await bridge.stop();

  assert.equal(result.confirmed, true);
  assert.equal(result.clicks, 2);
  assert.deepEqual(clicks, ["provisional", "active"]);
});

test("immediate Desktop STOP waits for submission and the selected turn to become working", async () => {
  const calls = [];
  let releaseSubmission;
  const submission = new Promise((resolve) => { releaseSubmission = resolve; });
  const snapshots = [
    { activeThreadKey: "test-thread", working: false },
    { activeThreadKey: "test-thread", working: false },
    { activeThreadKey: "test-thread", working: true }
  ];
  const runtime = Object.create(CodexRuntimeAdapter.prototype);
  Object.assign(runtime, {
    source: "codex",
    desktopBridge: {
      activateThread: async (id) => calls.push(["activate", id]),
      snapshot: async () => {
        calls.push(["snapshot"]);
        return snapshots.shift() || { activeThreadKey: "test-thread", working: true };
      },
      stop: async () => {
        calls.push(["stop"]);
        return { ok: true, confirmed: true };
      }
    },
    desktopSubmissionsInFlight: new Set([submission]),
    ensureDesktopBridgeReady: async () => ({ ok: true }),
    markDesktopTaskStopped: (conversationId) => calls.push(["marked", conversationId])
  });

  const stopped = runtime.runDesktopBridgeAction("stop", {
    surface: "desktop",
    conversationId: "codex:desktop:test-thread"
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.some(([name]) => name === "snapshot"), false);
  releaseSubmission();
  const result = await stopped;

  assert.equal(result.confirmed, true);
  assert.equal(calls.filter(([name]) => name === "snapshot").length, 3);
  assert.deepEqual(calls.at(-2), ["stop"]);
  assert.deepEqual(calls.at(-1), ["marked", "codex:desktop:test-thread"]);
});

test("Desktop submission gate is released when prompt setup fails", async () => {
  const runtime = Object.create(CodexRuntimeAdapter.prototype);
  runtime.startDesktopRunNow = async () => { throw new Error("setup failed"); };

  await assert.rejects(runtime.startDesktopRun({ content: "test" }), /setup failed/);

  assert.equal(runtime.desktopSubmissionsInFlight.size, 0);
});
