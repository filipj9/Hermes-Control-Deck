import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  buildRuntimeOverrideExpression,
  CodexDesktopBridge
} from "../apps/server/src/experimental/codex-desktop/CodexDesktopBridge.mjs";

const gateName = "3207467860";
const detectionKey = "codex-micro-has-ever-been-detected";
const appUrl = "app://-/assets/app-initial-synthetic.js";
const sharedUrl = "app://-/assets/app-shared-synthetic.js";
const persistedUrl = "app://-/assets/persisted-signal-synthetic.js";
const oldBusUrl = "app://-/assets/vscode-api-synthetic.js";

class DispatchHarness extends CodexDesktopBridge {
  constructor(context) {
    super({ desktopCdpPort: 4248 });
    this.context = context;
  }

  async ensureConnected() {}

  async evaluate(expression) {
    return vm.runInNewContext(expression.replaceAll("import(", "globalThis.__mockImport("), this.context);
  }
}

function harness({
  bundled = true,
  missingExports = false,
  hidHandlers = 1,
  splitFactory = false,
  splitFactoryCurrent = false
} = {}) {
  const assets = bundled ? [appUrl, sharedUrl] : [persistedUrl, oldBusUrl];
  const persisted = new Map();
  const events = [];
  let sourceReads = 0;
  const client = {
    overrideAdapter: {},
    _memoCache: { previous: true },
    updates: 0,
    $emt() { this.updates += 1; },
    checkGate(name) {
      return this.overrideAdapter.getGateOverride?.({ name, value: false })?.value ?? false;
    }
  };
  const handlers = new Map([
    ["codex-micro-device-state-changed", new Set([() => {}])],
    ["codex-micro-hid-event", new Set(Array.from({ length: hidHandlers }, () => () => {}))],
    ["codex-micro-joystick-event", new Set([() => {}])]
  ]);
  const bus = {
    handlers,
    dispatchHostMessage(message) { events.push(message); }
  };
  const appSource = splitFactoryCurrent
    ? [
        "import{nCt as jp}from\"./app-shared-synthetic.js\";",
        "var NAa;function FAa(){NAa=jp('codex-micro-has-ever-been-detected',!1)}",
        "export{}"
      ].join("")
    : splitFactory
    ? [
        "import{Sat as ss}from\"./app-shared-synthetic.js\";",
        "var rqs;function aqs(){rqs=ss(`codex-micro-has-ever-been-detected`,!1)}",
        "export{}"
      ].join("")
    : [
        "function xv(e,t,n){",
        "  let s=Fp(e,t);",
        "  n?.publishDelayMs==null?Ip(e,c):Lkt(e,c,n.publishDelayMs);",
        "  return s;",
        "}",
        "var rqs;function aqs(){rqs=xv(`codex-micro-has-ever-been-detected`,!1)}",
        missingExports ? "export{Fp as Qfn}" : "export{Ip as npn,Fp as Qfn}"
      ].join("");
  const sharedSource = splitFactoryCurrent
    ? [
        "function cq(e,t,n){",
        "  let s=tL(e,t);",
        "  n?.publishDelayMs==null?rL(e,c):OHt(e,c,n.publishDelayMs);",
        "  return s;",
        "}",
        missingExports ? "export{cq as nCt}" : "export{tL as CKt,rL as NKt,cq as nCt}"
      ].join("")
    : splitFactory
    ? [
        "function TX(e,t,n){",
        "  let s=VI(e,t);",
        "  n?.publishDelayMs==null?HI(e,c):LAt(e,c,n.publishDelayMs);",
        "  return s;",
        "}",
        missingExports ? "export{TX as Sat}" : "export{HI as Dkt,VI as _kt,TX as Sat}"
      ].join("")
    : "";
  const modules = new Map([
    [appUrl, {
      npn(key, value) { persisted.set(key, value); },
      Qfn(key, fallback) { return persisted.get(key) ?? fallback; }
    }],
    [sharedUrl, {
      _O: bus,
      Dkt(key, value) { persisted.set(key, value); },
      _kt(key, fallback) { return persisted.get(key) ?? fallback; },
      NKt(key, value) { persisted.set(key, value); },
      CKt(key, fallback) { return persisted.get(key) ?? fallback; }
    }],
    [persistedUrl, {
      b(key, value) { persisted.set(key, value); },
      p(key, fallback) { return persisted.get(key) ?? fallback; }
    }],
    [oldBusUrl, { g: bus }]
  ]);
  const context = {
    globalThis: undefined,
    __STATSIG__: { firstInstance: client, instances: {} },
    document: { querySelectorAll() { return assets.map((src) => ({ src })); } },
    performance: { getEntriesByType() { return []; } },
    fetch: async (url) => ({
      text: async () => {
        sourceReads += 1;
        if (url === appUrl) return appSource;
        if (url === sharedUrl) return sharedSource;
        return "";
      }
    }),
    __mockImport: async (url) => modules.get(url),
    Map,
    Set,
    Proxy,
    Reflect,
    Object,
    Boolean,
    URL
  };
  context.globalThis = context;
  const expression = buildRuntimeOverrideExpression().replaceAll("import(", "globalThis.__mockImport(");
  return {
    run: () => vm.runInNewContext(expression, context),
    persisted,
    events,
    client,
    sourceReads: () => sourceReads
  };
}

test("new bundled Micro assets enable detection and discover the HID bus", async () => {
  const lab = harness();
  const result = await lab.run();

  assert.equal(result.ready, true);
  assert.equal(result.detected, true);
  assert.equal(result.nativeEventBus, true);
  assert.equal(result.hidHandlers, 1);
  assert.equal(lab.persisted.get(detectionKey), true);
  assert.equal(lab.client.overrideAdapter.__hermesControlGate, gateName);
  assert.equal(lab.client.updates, 1);
  assert.deepEqual(lab.events.map((event) => event.type), ["codex-micro-device-state-changed"]);
});

test("26.924 split persistence factory resolves through app-shared", async () => {
  const lab = harness({ splitFactory: true });
  const result = await lab.run();

  assert.equal(result.ready, true);
  assert.equal(result.detected, true);
  assert.equal(result.nativeEventBus, true);
  assert.equal(result.hidHandlers, 1);
  assert.equal(lab.persisted.get(detectionKey), true);
  assert.equal(lab.sourceReads(), 2);
});

test("26.928 split persistence aliases resolve through app-shared", async () => {
  const lab = harness({ splitFactoryCurrent: true });
  const result = await lab.run();

  assert.equal(result.ready, true);
  assert.equal(result.detected, true);
  assert.equal(result.nativeEventBus, true);
  assert.equal(result.hidHandlers, 1);
  assert.equal(lab.persisted.get(detectionKey), true);
  assert.equal(lab.sourceReads(), 2);
});

test("older separate persisted signal and event-bus assets still work", async () => {
  const lab = harness({ bundled: false });
  const result = await lab.run();
  assert.equal(result.ready, true);
  assert.equal(result.detected, true);
  assert.equal(result.hidHandlers, 1);
});

test("a second Micro readiness poll reuses the resolved bundle contract", async () => {
  const lab = harness();
  assert.equal((await lab.run()).ready, true);
  assert.equal((await lab.run()).ready, true);
  assert.equal(lab.client.updates, 2);
  assert.equal(lab.events.length, 2);
  assert.equal(lab.sourceReads(), 1);
});

test("26.924 split persistence contract is cached after both bundle reads", async () => {
  const lab = harness({ splitFactory: true });
  assert.equal((await lab.run()).ready, true);
  assert.equal((await lab.run()).ready, true);
  assert.equal(lab.sourceReads(), 2);
});

test("unknown persistence exports and missing HID handlers fail closed", async () => {
  const unknown = harness({ missingExports: true });
  const unknownResult = await unknown.run();
  assert.equal(unknownResult.ready, false);
  assert.equal(unknownResult.reason, "micro-persistence-contract-changed");
  assert.equal(unknown.events.length, 0);

  const noHid = harness({ hidHandlers: 0 });
  const noHidResult = await noHid.run();
  assert.equal(noHidResult.ready, false);
  assert.equal(noHidResult.reason, "micro-hid-handlers-unavailable");
});

test("reasoning retries only the initial slider opening before sending one key", async () => {
  const bridge = new CodexDesktopBridge({ desktopCdpPort: 4248 });
  let triggerReads = 0;
  let sliderWaits = 0;
  let clicks = 0;
  let closes = 0;
  const keys = [];
  bridge.readReasoningTriggerState = async () => ({ value: "high", model: "Luna" });
  bridge.evaluate = async (expression) => {
    if (expression.includes("data-codex-intelligence-trigger")) {
      triggerReads += 1;
      return { open: false, x: 10, y: 20 };
    }
    if (expression.includes("document.activeElement")) return true;
    return null;
  };
  bridge.clickPoint = async () => { clicks += 1; };
  bridge.closeReasoningMenu = async () => { closes += 1; };
  bridge.pressKey = async (key) => { keys.push(key); };
  bridge.waitForReasoningUi = async (_read, accept, options) => {
    sliderWaits += 1;
    if (sliderWaits === 1) throw new Error("Codex reasoning slider timed out after 5000ms.");
    const value = sliderWaits === 2
      ? { min: 0, max: 4, current: 2, model: "Luna", value: "high" }
      : { min: 0, max: 4, current: 3, model: "Luna", value: "xhigh" };
    assert.equal(accept(value), true);
    assert.match(options.description, /slider/);
    return value;
  };

  const result = await bridge.adjustReasoningSlider("increase");

  assert.equal(result.to, "xhigh");
  assert.equal(triggerReads, 2);
  assert.equal(clicks, 2);
  assert.deepEqual(keys, ["ArrowRight"]);
  assert.equal(closes, 2, "one close before retry and one final close");
});

test("host messages use the new app-shared bus and require the exact handler", async () => {
  const messages = [];
  const bus = {
    handlers: new Map([["codex-micro-insert-composer-text", new Set([() => {}])]]),
    dispatchHostMessage(message) { messages.push(message); }
  };
  const context = {
    globalThis: undefined,
    document: { querySelectorAll() { return [{ src: sharedUrl }]; } },
    performance: { getEntriesByType() { return []; } },
    __mockImport: async (url) => url === sharedUrl ? { sharedBus: bus } : {},
    Map,
    Set
  };
  context.globalThis = context;
  const bridge = new DispatchHarness(context);

  const result = await bridge.dispatchHostMessage({
    type: "codex-micro-insert-composer-text",
    text: "synthetic prompt"
  });

  assert.equal(result.ok, true);
  assert.equal(result.handlers, 1);
  assert.equal(
    JSON.stringify(messages),
    JSON.stringify([{ type: "codex-micro-insert-composer-text", text: "synthetic prompt" }])
  );

  bus.handlers.clear();
  await assert.rejects(
    bridge.dispatchHostMessage({ type: "codex-micro-insert-composer-text", text: "blocked" }),
    /native event bus is unavailable/
  );
  assert.equal(messages.length, 1);
});

test("host messages preserve support for the old vscode-api bus", async () => {
  const messages = [];
  const bus = {
    handlers: new Map([["codex-micro-hid-event", new Set([() => {}])]]),
    dispatchMessage(message) { messages.push(message); }
  };
  const context = {
    globalThis: undefined,
    document: { querySelectorAll() { return [{ src: oldBusUrl }]; } },
    performance: { getEntriesByType() { return []; } },
    __mockImport: async (url) => url === oldBusUrl ? { g: bus } : {},
    Map,
    Set
  };
  context.globalThis = context;
  const bridge = new DispatchHarness(context);
  const message = { type: "codex-micro-hid-event", event: { key: "ACT12", act: 1 } };

  const result = await bridge.dispatchHostMessage(message);

  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(messages), JSON.stringify([message]));
});

test("26.924 command runner discovery ignores the voice HID caller", () => {
  const source = fs.readFileSync(
    new URL("../apps/server/src/experimental/codex-desktop/CodexDesktopBridge.mjs", import.meta.url),
    "utf8"
  );
  const encoded = source.match(/const MICRO_COMMAND_RUNNER_CALL_PATTERN = ("[^"]*(?:\\.[^"]*)*");/)?.[1];
  assert.ok(encoded, "command-runner pattern must be declared once");
  const pattern = new RegExp(JSON.parse(encoded), "g");
  const currentBridge = [
    "let voice=Fe(command,'codex_micro_hid');",
    "if(m?.type==='command'){!Qt(store,m.command,`codex_micro_hid`)&&warn()}"
  ].join("");

  assert.deepEqual(
    [...currentBridge.matchAll(pattern)].map((match) => match[1]),
    ["Qt"]
  );
});

test("26.924 command runner follows the local capability wrapper to its imported dispatcher", async () => {
  const bridgeUrl = "app://-/assets/codex-micro-bridge-current.js";
  const layoutUrl = "app://-/assets/codex-micro-layout-current.js";
  const commandsUrl = "app://-/assets/codex-micro-commands-current.js";
  const initialUrl = "app://-/assets/app-initial-current.js";
  const calls = [];
  const dispatcher = (command, source) => {
    calls.push([command, source]);
    return true;
  };
  const bridgeSource = [
    'import{n as e}from"./rolldown-runtime-current.js";',
    'import{t4t as Fe}from"./app-initial-current.js";',
    'import{i as G,n as K}from"./codex-micro-commands-current.js";',
    'function Qt(e,t,n){return K(t)?.requiredAccess!=null&&!e.get(oe)?!1:Fe(t,n)}',
    'function Later(){return e(t,n)}',
    'if(m?.type==="command"){!Qt(r,m.command,"codex_micro_hid")&&warn()}',
    'let voice=Fe(command,"codex_micro_hid");'
  ].join("");
  const modules = new Map([
    [layoutUrl, {
      layout(id) {
        return id === "CODEX"
          ? { id, action: { type: "command", command: "composer.submit" } }
          : { id };
      }
    }],
    [commandsUrl, { n: () => true }],
    [initialUrl, { t4t: dispatcher }],
    ["app://-/assets/rolldown-runtime-current.js", { n: () => true }]
  ]);
  const context = {
    document: {
      querySelectorAll() {
        return [bridgeUrl, layoutUrl, commandsUrl, initialUrl].map((src) => ({ src }));
      }
    },
    performance: { getEntriesByType() { return []; } },
    fetch: async (url) => ({ text: async () => url === bridgeUrl ? bridgeSource : "" }),
    __mockImport: async (url) => modules.get(url) || {},
    Map,
    Set,
    Object,
    URL
  };
  const bridge = new DispatchHarness(context);
  bridge.enableMicroRuntime = async () => ({ ready: true });

  const result = await bridge.runKeycap("CODEX");

  assert.equal(JSON.stringify(result), JSON.stringify({ ok: true, action: "command" }));
  assert.deepEqual(calls, [["composer.submit", "codex_micro_hid"]]);
});

test("26.928 command runner follows Qt to the imported Ce dispatcher", async () => {
  const bridgeUrl = "app://-/assets/codex-micro-bridge-current.js";
  const layoutUrl = "app://-/assets/codex-micro-layout-current.js";
  const commandsUrl = "app://-/assets/codex-micro-commands-current.js";
  const initialUrl = "app://-/assets/app-initial-current.js";
  const calls = [];
  const dispatcher = (command, source) => {
    calls.push([command, source]);
    return true;
  };
  const bridgeSource = [
    'import{n as e}from"./rolldown-runtime-current.js";',
    'import{fqt as Ce}from"./app-initial-current.js";',
    'import{i as G,n as K}from"./codex-micro-commands-current.js";',
    'function Qt(e,t,n){return K(t)?.requiredAccess!=null&&!e.get(oe)?!1:Ce(t,n)}',
    'function Later(){return e(t,n)}',
    'if(m?.type==="command"){!Qt(r,m.command,"codex_micro_hid")&&warn()}',
    'let voice=Ce(command,"codex_micro_hid");'
  ].join("");
  const modules = new Map([
    [layoutUrl, {
      layout(id) {
        return id === "CODEX"
          ? { id, action: { type: "command", command: "composer.submit" } }
          : { id };
      }
    }],
    [commandsUrl, { n: () => true }],
    [initialUrl, { fqt: dispatcher }],
    ["app://-/assets/rolldown-runtime-current.js", { n: () => true }]
  ]);
  const context = {
    document: {
      querySelectorAll() {
        return [bridgeUrl, layoutUrl, commandsUrl, initialUrl].map((src) => ({ src }));
      }
    },
    performance: { getEntriesByType() { return []; } },
    fetch: async (url) => ({ text: async () => url === bridgeUrl ? bridgeSource : "" }),
    __mockImport: async (url) => modules.get(url) || {},
    Map,
    Set,
    Object,
    URL
  };
  const bridge = new DispatchHarness(context);
  bridge.enableMicroRuntime = async () => ({ ready: true });

  const result = await bridge.runKeycap("CODEX");

  assert.equal(JSON.stringify(result), JSON.stringify({ ok: true, action: "command" }));
  assert.deepEqual(calls, [["composer.submit", "codex_micro_hid"]]);
});
