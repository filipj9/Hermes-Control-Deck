import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { CodexDesktopBridge } from "../apps/server/src/experimental/codex-desktop/CodexDesktopBridge.mjs";
import { CodexRuntimeAdapter } from "../apps/server/src/experimental/codex-desktop/CodexRuntimeAdapter.mjs";

test("empty RUN activates and waits for the explicitly selected task before HID", async () => {
  const calls = [];
  const adapter = new CodexRuntimeAdapter(
    { mode: "stub", surface: "desktop", desktopEnabled: false },
    { publish() {}, list() { return []; } }
  );
  adapter.desktopBridge = {
    isConnected: () => true,
    health: async () => ({ ok: true }),
    activateThread: async (id) => calls.push(["activate", id]),
    continueTask: async (id) => {
      calls.push(["run", id]);
      return { working: true };
    }
  };

  await adapter.runDesktopBridgeAction("continue", { conversationId: "codex:desktop:new" });
  assert.deepEqual(calls, [["activate", "new"], ["run", "new"]]);
  await assert.rejects(adapter.runDesktopBridgeAction("continue", {}), /Select a Codex Desktop session/);
});

test("composer readiness requires the requested thread and two stable visible composer reads", async () => {
  const bridge = Object.create(CodexDesktopBridge.prototype);
  const reads = [
    null,
    { threadKey: "other", composerCount: 1 },
    { threadKey: "thread-run", composerCount: 1 },
    { threadKey: "thread-run", composerCount: 1 }
  ];
  bridge.evaluate = async () => reads.shift() ?? null;
  const ready = await bridge.waitForComposerThread("thread-run");
  assert.equal(ready.threadKey, "thread-run");
  assert.equal(ready.composerCount, 1);
  assert.equal(ready.stableMatches, 2);
  await assert.rejects(bridge.waitForComposerThread(""), /composer session id is required/);
});

test("RUN uses the registered composer submit command and retries transient snapshot races", async () => {
  const bridge = Object.create(CodexDesktopBridge.prototype);
  let snapshots = 0;
  const submits = [];
  bridge.waitForComposerThread = async (id) => assert.equal(id, "thread-run");
  bridge.enableMicroRuntime = async () => ({ ready: true });
  bridge.readVisibleComposerText = async () => "queued prompt";
  bridge.submitComposer = async (text) => submits.push(text);
  bridge.composerContainsText = async () => false;
  bridge.snapshot = async () => {
    snapshots += 1;
    if (snapshots < 3) throw new Error("Promise was collected");
    return { working: false, waitingApproval: false };
  };

  const result = await bridge.continueTask("thread-run");
  assert.equal(snapshots, 3);
  assert.deepEqual(submits, ["queued prompt"]);
  assert.equal(result.working, false);
  assert.equal(result.metadata.submitted, true);
});

test("RUN never submits before composer readiness", async () => {
  const bridge = Object.create(CodexDesktopBridge.prototype);
  let submitted = false;
  bridge.waitForComposerThread = async () => { throw new Error("selected composer unavailable"); };
  bridge.enableMicroRuntime = async () => ({ ready: true });
  bridge.submitComposer = async () => { submitted = true; };
  await assert.rejects(bridge.continueTask("thread-run"), /selected composer unavailable/);
  assert.equal(submitted, false);
});

test("RUN reports a submit failure without taking a success snapshot", async () => {
  const bridge = Object.create(CodexDesktopBridge.prototype);
  let submits = 0;
  let snapshots = 0;
  bridge.waitForComposerThread = async () => ({ threadKey: "thread-run" });
  bridge.enableMicroRuntime = async () => ({ ready: true });
  bridge.readVisibleComposerText = async () => "queued prompt";
  bridge.submitComposer = async () => { submits += 1; throw new Error("submit failed"); };
  bridge.snapshot = async () => { snapshots += 1; return {}; };
  await assert.rejects(bridge.continueTask("thread-run"), /submit failed/);
  assert.equal(submits, 1);
  assert.equal(snapshots, 0);
});

test("RUN uses the registered submit path and keycap lookup fails closed", () => {
  const source = fs.readFileSync(
    new URL("../apps/server/src/experimental/codex-desktop/CodexDesktopBridge.mjs", import.meta.url),
    "utf8"
  );
  const continueStart = source.indexOf("  async continueTask(");
  const continueEnd = source.indexOf("\n  async stop()", continueStart);
  const continueBody = source.slice(continueStart, continueEnd);
  assert.match(continueBody, /readVisibleComposerText\(\)/);
  assert.match(continueBody, /submitComposer\(composerText\)/);
  assert.doesNotMatch(continueBody, /sendHid\(/);
  assert.doesNotMatch(continueBody, /runKeycap\("RUN"\)/);

  const keycapStart = source.indexOf("  async runKeycap(");
  const keycapEnd = source.indexOf("\n  async enableMicroRuntime", keycapStart);
  const keycapBody = source.slice(keycapStart, keycapEnd);
  assert.match(keycapBody, /keycap\?\.id !== keycapId/);
  assert.doesNotMatch(keycapBody, /app\.k8/);
  assert.match(keycapBody, /Codex command runner is ambiguous/);
});
