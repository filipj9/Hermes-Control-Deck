import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { CodexDesktopBridge } from "../apps/server/src/experimental/codex-desktop/CodexDesktopBridge.mjs";
import { CodexRuntimeAdapter } from "../apps/server/src/experimental/codex-desktop/CodexRuntimeAdapter.mjs";

const uiSource = fs.readFileSync(new URL("../apps/web/app.js", import.meta.url), "utf8");

test("reasoning activates the explicitly selected Desktop session before changing effort", async () => {
  const calls = [];
  const adapter = new CodexRuntimeAdapter(
    { mode: "stub", surface: "desktop", desktopEnabled: false },
    { publish() {}, list() { return []; } }
  );
  adapter.desktopBridge = {
    isConnected: () => true,
    health: async () => ({ ok: true }),
    activateThread: async (id) => calls.push(["activate", id]),
    waitForReasoningThread: async (id) => calls.push(["ready", id]),
    adjustReasoning: async (direction) => {
      calls.push(["reasoning", direction]);
      return { ok: true, to: "xhigh" };
    }
  };

  const result = await adapter.runDesktopBridgeAction("reasoning-up", {
    surface: "desktop",
    conversationId: "codex:desktop:selected-thread"
  });

  assert.equal(result.to, "xhigh");
  assert.deepEqual(calls, [
    ["activate", "selected-thread"],
    ["ready", "selected-thread"],
    ["reasoning", "increase"]
  ]);
});

test("reasoning fails closed without a selected Desktop session", async () => {
  let adjusted = false;
  const adapter = new CodexRuntimeAdapter(
    { mode: "stub", surface: "desktop", desktopEnabled: false },
    { publish() {}, list() { return []; } }
  );
  adapter.desktopBridge = {
    isConnected: () => true,
    health: async () => ({ ok: true }),
    adjustReasoning: async () => { adjusted = true; }
  };

  await assert.rejects(
    adapter.runDesktopBridgeAction("reasoning-up", { surface: "desktop" }),
    /Select a Codex Desktop session/
  );
  assert.equal(adjusted, false);
});

test("reasoning never changes effort when selected-session readiness fails", async () => {
  let adjusted = false;
  const adapter = new CodexRuntimeAdapter(
    { mode: "stub", surface: "desktop", desktopEnabled: false },
    { publish() {}, list() { return []; } }
  );
  adapter.desktopBridge = {
    isConnected: () => true,
    health: async () => ({ ok: true }),
    activateThread: async () => {},
    waitForReasoningThread: async () => { throw new Error("selected controls unavailable"); },
    adjustReasoning: async () => { adjusted = true; }
  };

  await assert.rejects(
    adapter.runDesktopBridgeAction("reasoning-down", {
      surface: "desktop",
      conversationId: "codex:desktop:selected-thread"
    }),
    /selected controls unavailable/
  );
  assert.equal(adjusted, false);
});

test("modern slider validates model and always closes after success or failure", async () => {
  const bridge = new CodexDesktopBridge({ desktopCdpPort: 4248 });
  const keys = [];
  let reads = 0;
  let closed = 0;
  bridge.readReasoningTriggerState = async () => ({ value: "high", model: "Luna" });
  bridge.evaluate = async (expression) => {
    if (expression.includes("data-codex-intelligence-trigger")) return { open: true, x: 1, y: 1 };
    if (expression.includes("document.activeElement")) return true;
    return null;
  };
  bridge.waitForReasoningUi = async (_read, accept) => {
    reads += 1;
    const value = reads === 1
      ? { min: 0, max: 4, current: 2, model: "Luna", value: "high" }
      : { min: 0, max: 4, current: 3, model: "Luna", value: "xhigh" };
    assert.ok(accept(value));
    return value;
  };
  bridge.pressKey = async (key) => keys.push(key);
  bridge.closeReasoningMenu = async () => { closed += 1; };

  assert.equal((await bridge.adjustReasoningSlider("increase")).to, "xhigh");
  assert.deepEqual(keys, ["ArrowRight"]);
  assert.equal(closed, 1);

  bridge.waitForReasoningUi = async () => { throw new Error("UI changed"); };
  await assert.rejects(bridge.adjustReasoningSlider("increase"), /UI changed/);
  assert.equal(closed, 2);
});

test("reasoning knob sends the selected Codex conversation", () => {
  const start = uiSource.indexOf("async function cycleReasoning(");
  const end = uiSource.indexOf("\nfunction syncCodexReasoningFromRuntimes(", start);
  assert.ok(start >= 0 && end > start);
  const body = uiSource.slice(start, end);
  assert.match(body, /action:\s*"reasoning-up"/);
  assert.match(body, /conversationId:\s*selectedConversationIdFor\("codex"\)/);
});
