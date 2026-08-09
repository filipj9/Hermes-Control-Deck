import assert from "node:assert/strict";
import test from "node:test";
import { createCodexAdapter } from "../apps/server/src/adapters/codex/createCodexAdapter.mjs";

const eventBus = { publish() {}, list() { return []; } };
const baseConfig = {
  executable: "",
  workdir: process.cwd(),
  approvalPolicy: "on-request",
  runTimeoutMs: 1000,
  stopTimeoutMs: 100,
  allowConcurrentRuns: false,
  maxPromptChars: 1000,
  experimentalDesktop: {
    enabled: false,
    cdpHost: "127.0.0.1",
    cdpPort: 4248,
    requestTimeoutMs: 1000,
    stateFile: ""
  }
};

test("default CLI mode never imports the experimental Desktop add-on", async () => {
  let loaded = false;
  const adapter = await createCodexAdapter(baseConfig, eventBus, {
    loadDesktop: async () => {
      loaded = true;
      throw new Error("must not load");
    }
  });
  assert.equal(loaded, false);
  assert.equal(adapter.constructor.name, "CodexRuntimeAdapter");
});

test("experimental Desktop add-on is rejected outside Windows before import", async () => {
  let loaded = false;
  await assert.rejects(
    () => createCodexAdapter({
      ...baseConfig,
      experimentalDesktop: { ...baseConfig.experimentalDesktop, enabled: true }
    }, eventBus, {
      platform: "linux",
      loadDesktop: async () => {
        loaded = true;
        return {};
      }
    }),
    /Windows-only/
  );
  assert.equal(loaded, false);
});

test("experimental Desktop add-on is dynamically constructed only after opt-in", async () => {
  class FakeDesktopAdapter {
    constructor(config) {
      this.source = "codex";
      this.config = config;
    }
  }
  const config = {
    ...baseConfig,
    experimentalDesktop: { ...baseConfig.experimentalDesktop, enabled: true }
  };
  const adapter = await createCodexAdapter(config, eventBus, {
    platform: "win32",
    loadDesktop: async () => ({ ExperimentalCodexDesktopAdapter: FakeDesktopAdapter })
  });
  assert.equal(adapter.constructor, FakeDesktopAdapter);
  assert.equal(adapter.config, config);
});
