import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { CodexDesktopBridge } from "../apps/server/src/experimental/codex-desktop/CodexDesktopBridge.mjs";

class ComposerScopeHarness extends CodexDesktopBridge {
  constructor(context) {
    super({ desktopCdpPort: 4248 });
    this.context = context;
  }

  async evaluate(expression) {
    return vm.runInNewContext(expression, this.context);
  }

  async waitForReasoningUi(read, accept) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const value = await read();
      if (accept(value)) return value;
    }
    throw new Error("selected Codex Desktop composer timed out after 5000ms.");
  }
}

test("composer readiness ignores visible editors outside the selected conversation form", async () => {
  const selectedComposer = visibleElement();
  const sidePanelEditor = visibleElement();
  const browserTextbox = visibleElement();
  const selectedForm = {
    ...visibleElement(),
    querySelectorAll: () => [selectedComposer]
  };
  const marker = {
    ...visibleElement(),
    parentElement: selectedForm,
    closest: () => selectedForm,
    getAttribute: (name) => name === "data-above-composer-conversation-id" ? "thread-selected" : null
  };
  const bridge = new ComposerScopeHarness(domContext(marker, [selectedComposer, sidePanelEditor, browserTextbox]));

  const ready = await bridge.waitForComposerThread("thread-selected");

  assert.equal(ready.threadKey, "thread-selected");
  assert.equal(ready.composerCount, 1);
  assert.equal(ready.stableMatches, 2);
});

test("composer readiness fails closed when the selected conversation form is ambiguous", async () => {
  const firstComposer = visibleElement();
  const secondComposer = visibleElement();
  const selectedForm = {
    ...visibleElement(),
    querySelectorAll: () => [firstComposer, secondComposer]
  };
  const marker = {
    ...visibleElement(),
    parentElement: selectedForm,
    closest: () => selectedForm,
    getAttribute: (name) => name === "data-above-composer-conversation-id" ? "thread-selected" : null
  };
  const bridge = new ComposerScopeHarness(domContext(marker, [firstComposer, secondComposer]));

  await assert.rejects(
    bridge.waitForComposerThread("thread-selected"),
    /selected Codex Desktop composer timed out/
  );
});

test("composer readiness never accepts a composer from another conversation", async () => {
  const composer = visibleElement();
  const selectedForm = {
    ...visibleElement(),
    querySelectorAll: () => [composer]
  };
  const marker = {
    ...visibleElement(),
    parentElement: selectedForm,
    closest: () => selectedForm,
    getAttribute: (name) => name === "data-above-composer-conversation-id" ? "thread-other" : null
  };
  const bridge = new ComposerScopeHarness(domContext(marker, [composer]));

  await assert.rejects(
    bridge.waitForComposerThread("thread-selected"),
    /selected Codex Desktop composer timed out/
  );
});

function domContext(marker, allComposers) {
  return {
    document: {
      querySelectorAll(selector) {
        if (selector === "[data-above-composer-conversation-id]") return [marker];
        if (selector === "textarea, [contenteditable=\"true\"], [role=\"textbox\"]") return allComposers;
        return [];
      }
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    String,
    Array
  };
}

function visibleElement() {
  return {
    disabled: false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 400, height: 80 })
  };
}
