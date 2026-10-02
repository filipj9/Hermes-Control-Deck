import fs from "node:fs";
import path from "node:path";

const MICRO_GATE = "3207467860";
const DETECTION_KEY = "codex-micro-has-ever-been-detected";
const MICRO_COMMAND_RUNNER_CALL_PATTERN = "!([A-Za-z_$][\\w$]*)\\([^)]{0,240}\\.command\\s*,\\s*[\"'`]codex_micro_hid[\"'`]\\)";
const DEVICE_STATE = {
  type: "codex-micro-device-state-changed",
  state: {
    status: "connected",
    error: null,
    battery: { percentage: 100, isCharging: true }
  }
};

const ACTION_KEYS = {
  approve: "ACT07",
  reject: "ACT08"
};

const EFFORT_ALIASES = new Map([
  ["lekki", "low"],
  ["light", "low"],
  ["low", "low"],
  ["sredni", "medium"],
  ["medium", "medium"],
  ["wysoki", "high"],
  ["high", "high"],
  ["bardzo wysoki", "xhigh"],
  ["very high", "xhigh"],
  ["xhigh", "xhigh"],
  ["maks", "max"],
  ["max", "max"],
  ["ultra", "ultra"]
]);

function normalizeEffortLabel(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function effortValue(label) {
  const normalized = normalizeEffortLabel(label);
  for (const [alias, value] of EFFORT_ALIASES) {
    if (normalized === alias || (value === "ultra" && normalized.startsWith("ultra"))) return value;
  }
  return null;
}

function nextEffortIndex(currentIndex, count, direction) {
  if (!Number.isInteger(currentIndex) || !Number.isInteger(count) || count < 2) {
    throw new Error("Codex Desktop reasoning options are unavailable.");
  }
  if (currentIndex < 0 || currentIndex >= count) {
    throw new Error("Codex Desktop reasoning selection is outside the available options.");
  }
  if (direction === "increase") return (currentIndex + 1) % count;
  if (direction === "decrease") return (currentIndex - 1 + count) % count;
  throw new Error(`Unknown Codex reasoning direction: ${direction}`);
}

export class CodexDesktopBridge {
  constructor(config, options = {}) {
    this.host = config.desktopCdpHost || "127.0.0.1";
    this.port = Number(config.desktopCdpPort || 4248);
    this.stateFile = config.desktopBridgeStateFile || "";
    this.requestTimeoutMs = Number(config.desktopBridgeRequestTimeoutMs || 6000);
    this.projectName = config.workdir ? path.basename(config.workdir).toLowerCase() : "";
    this.onEvent = options.onEvent || (() => {});
    this.socket = undefined;
    this.target = undefined;
    this.nextId = 0;
    this.pending = new Map();
    this.connecting = undefined;
    this.lastSnapshot = undefined;
    this.sidebarThreadByCanonical = new Map();
    this.canonicalThreadBySidebar = new Map();
    this.modelByThread = new Map();
  }

  describe() {
    return {
      available: true,
      connected: this.isConnected(),
      mechanism: "codex-desktop-cdp",
      host: this.host,
      port: this.resolvePort()
    };
  }

  isAvailable() {
    return Number.isInteger(this.resolvePort()) && this.resolvePort() > 0;
  }

  isConnected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async health() {
    await this.ensureConnected();
    const runtime = await this.enableMicroRuntime();
    const snapshot = await this.snapshot();
    return {
      ok: true,
      status: "connected",
      runtime,
      activeThreadKey: snapshot.activeThreadKey,
      activeThreadTitle: snapshot.activeThreadTitle,
      conversations: snapshot.conversations.length
    };
  }

  async launch() {
    throw new Error(
      "Automatic Codex Desktop launch is intentionally unavailable in the public experimental add-on. "
      + "Start the application and its loopback CDP endpoint yourself."
    );
  }
  async snapshot() {
    await this.ensureConnected();
    try {
      const result = this.normalizeSnapshot(await this.evaluate(buildSnapshotExpression()));
      this.lastSnapshot = result;
      return result;
    } catch (error) {
      if (!/Promise was collected|context.*destroyed|execution context/i.test(error.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 80));
      const result = this.normalizeSnapshot(await this.evaluate(buildSnapshotExpression()));
      this.lastSnapshot = result;
      return result;
    }
  }

  async listConversations() {
    const snapshot = await this.snapshot();
    return snapshot.conversations;
  }

  normalizeSnapshot(value = {}) {
    const snapshot = { ...value };
    const activeThreadKey = String(snapshot.activeThreadKey || "");
    const activeSidebarThreadKey = String(snapshot.activeSidebarThreadKey || "");
    if (activeThreadKey && activeSidebarThreadKey && activeThreadKey !== activeSidebarThreadKey) {
      this.sidebarThreadByCanonical.set(activeThreadKey, activeSidebarThreadKey);
      this.canonicalThreadBySidebar.set(activeSidebarThreadKey, activeThreadKey);
    }

    const canonicalActive = this.canonicalThreadBySidebar.get(activeThreadKey) || activeThreadKey;
    const concreteModel = String(snapshot.model || "").trim();
    if (canonicalActive && concreteModel) {
      this.modelByThread.delete(canonicalActive);
      this.modelByThread.set(canonicalActive, concreteModel);
      while (this.modelByThread.size > 100) {
        this.modelByThread.delete(this.modelByThread.keys().next().value);
      }
      snapshot.model = concreteModel;
    } else if (canonicalActive) {
      snapshot.model = this.modelByThread.get(canonicalActive) || undefined;
    }
    const seen = new Set();
    snapshot.activeThreadKey = canonicalActive || undefined;
    snapshot.conversations = (snapshot.conversations || []).flatMap((item) => {
      const originalThreadKey = String(item.threadKey || "");
      const threadKey = this.canonicalThreadBySidebar.get(originalThreadKey) || originalThreadKey;
      if (!threadKey || seen.has(threadKey)) return [];
      seen.add(threadKey);
      const selected = Boolean(
        item.selected
        || threadKey === canonicalActive
        || originalThreadKey === activeSidebarThreadKey
      );
      return [{
        ...item,
        threadKey,
        selected,
        status: selected ? "active" : item.status,
        ...(originalThreadKey !== threadKey ? { sidebarThreadKey: originalThreadKey } : {})
      }];
    });
    return snapshot;
  }

  sidebarThreadKey(threadKey) {
    return this.sidebarThreadByCanonical.get(String(threadKey || "")) || String(threadKey || "");
  }

  async activateThread(threadKey) {
    if (!threadKey) return this.snapshot();
    await this.ensureConnected();
    const sidebarThreadKey = this.sidebarThreadKey(threadKey);
    const expression = `(async () => {
      const threadKey = ${JSON.stringify(threadKey)};
      const sidebarThreadKey = ${JSON.stringify(sidebarThreadKey)};
      const normalizeThreadKey = (value) => String(value ?? '').replace(/^local:/, '');
      const activeSidebarThreadKey = () => normalizeThreadKey(
        document.querySelector('[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-active="true"]')?.getAttribute('data-app-action-sidebar-thread-id')
        ?? document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]')?.getAttribute('data-app-action-sidebar-thread-id')
        ?? null
      );
      const visibleComposerThreadKey = () => {
        const marker = [...document.querySelectorAll('[data-above-composer-conversation-id]')]
          .find((element) => {
            const container = element.parentElement ?? element;
            const rect = container.getBoundingClientRect();
            const style = getComputedStyle(container);
            return rect.width > 0 && rect.height > 0
              && style.display !== 'none'
              && style.visibility !== 'hidden';
          });
        return marker
          ? normalizeThreadKey(marker.getAttribute('data-above-composer-conversation-id'))
          : null;
      };
      const activeThreadKey = () =>
        normalizeThreadKey(
          visibleComposerThreadKey()
          ?? document.querySelector('[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-active="true"]')?.getAttribute('data-app-action-sidebar-thread-id')
          ?? document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]')?.getAttribute('data-app-action-sidebar-thread-id')
          ?? null
        );
      const waitForActive = async (duration) => {
        const deadline = Date.now() + duration;
        while (Date.now() < deadline) {
          if (activeThreadKey() === threadKey || activeSidebarThreadKey() === sidebarThreadKey) return true;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return activeThreadKey() === threadKey || activeSidebarThreadKey() === sidebarThreadKey;
      };
      if (await waitForActive(150)) return { status: 'active', threadKey };
      const item = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
        .find((element) => normalizeThreadKey(element.getAttribute('data-app-action-sidebar-thread-id')) === sidebarThreadKey);
      if (!item) return { status: 'missing', threadKey };
      const selector = 'button, a, [role="button"], [role="link"]';
      const clickable = item.matches(selector) ? item : item.querySelector(selector) ?? item.closest(selector) ?? item;
      if (typeof clickable.click === 'function') clickable.click();
      else clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return { status: await waitForActive(1800) ? 'opened' : 'failed', threadKey, sidebarThreadKey };
    })()`;
    let result;
    try {
      result = await this.evaluate(expression);
    } catch (error) {
      if (!isNavigationRace(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150));
      const current = await this.snapshot();
      if (current.activeThreadKey === threadKey || current.conversations?.some((item) => item.threadKey === threadKey && item.selected)) return current;
      result = await this.evaluate(expression);
    }
    if (result.status === "active" || result.status === "opened") return this.snapshot();
    if (result.status === "missing") {
      throw new Error("Selected Codex Desktop task is not loaded in the sidebar.");
    }
    throw new Error("Codex Desktop did not activate the selected task.");
  }

  async insertComposerText(text) {
    if (!String(text || "").trim()) throw new Error("Codex Desktop prompt is empty.");
    await this.dispatchHostMessage({
      type: "codex-micro-insert-composer-text",
      text: String(text)
    });
  }

  async submitComposer(expectedText, { timeoutMs = 1200 } = {}) {
    const expected = String(expectedText || "").trim();
    const deadline = Date.now() + timeoutMs;
    do {
      try {
        return await this.runKeycap("CODEX");
      } catch (error) {
        if (!/Codex command is not active in the current view/i.test(String(error?.message || error))) {
          throw error;
        }
        if (!expected || !(await this.composerContainsText(expected)) || Date.now() >= deadline) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } while (Date.now() < deadline);
    throw new Error("Codex composer submit did not become active.");
  }

  async sendPrompt(text, options = {}) {
    await this.enableMicroRuntime();
    if (options.threadKey) {
      await this.activateThread(options.threadKey);
      await this.waitForComposerThread(options.threadKey);
    }
    const before = await this.snapshot();
    await this.insertComposerText(text);
    const inserted = await this.waitForComposerText(text, 800);
    if (!inserted) {
      throw new Error("Codex Desktop did not confirm prompt insertion; SEND was not pressed.");
    }
    await this.submitComposer(text);
    const deadline = Date.now() + 5000;
    let snapshot = await this.snapshot();
    while (
      Date.now() < deadline
      && !snapshot.working
      && !snapshot.waitingApproval
    ) {
      const newThreadStarted = Boolean(
        snapshot.activeThreadKey
        && snapshot.activeThreadKey !== before.activeThreadKey
      );
      const composerCleared = inserted && !(await this.composerContainsText(text));
      if (newThreadStarted || composerCleared) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
      snapshot = await this.snapshot();
    }
    const accepted = snapshot.working
      || snapshot.waitingApproval
      || Boolean(snapshot.activeThreadKey && snapshot.activeThreadKey !== before.activeThreadKey)
      || (inserted && !(await this.composerContainsText(text)));
    if (!accepted) {
      throw new Error("Codex Desktop did not confirm that the prompt started.");
    }
    this.onEvent({
      type: "prompt.sent",
      payload: {
        threadKey: snapshot.activeThreadKey,
        title: snapshot.activeThreadTitle,
        text
      }
    });
    return snapshot;
  }

  async composerContainsText(text) {
    const expected = String(text || "").trim().replace(/\s+/g, " ");
    if (!expected) return false;
    try {
      return Boolean(await this.evaluate(`(() => {
        const expected = ${JSON.stringify(expected)};
        return [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
          .some((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) {
              return false;
            }
            const value = String(element.value ?? element.innerText ?? element.textContent ?? '')
              .trim().replace(/\\s+/g, ' ');
            return value.includes(expected);
          });
      })()`));
    } catch (error) {
      if (isNavigationRace(error)) return false;
      throw error;
    }
  }

  async readVisibleComposerText() {
    try {
      return await this.evaluate(`(() => {
        const visible = (element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden'
            && rect.width > 0 && rect.height > 0;
        };
        const composers = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
          .filter(visible);
        if (composers.length !== 1) return null;
        const element = composers[0];
        return String(element.value ?? element.innerText ?? element.textContent ?? '')
          .trim().replace(/\s+/g, ' ');
      })()`);
    } catch (error) {
      if (isNavigationRace(error)) return null;
      throw error;
    }
  }

  async waitForComposerText(text, timeoutMs = 800) {
    const deadline = Date.now() + timeoutMs;
    do {
      if (await this.composerContainsText(text)) return true;
      await new Promise((resolve) => setTimeout(resolve, 40));
    } while (Date.now() < deadline);
    return false;
  }

  async approve() {
    await this.resolveApprovalDecision("approve");
    return this.snapshot();
  }

  async reject() {
    await this.resolveApprovalDecision("reject");
    return this.snapshot();
  }

  async resolveApprovalDecision(decision) {
    await this.ensureConnected();
    const result = await this.evaluate(`(() => {
      const decision = ${JSON.stringify(decision)};
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0
          && !element.disabled
          && element.getAttribute('aria-disabled') !== 'true';
      };
      const label = (element) => [
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.textContent
      ].filter(Boolean).join(' ').trim().replace(/\\s+/g, ' ');
      const pattern = decision === 'approve'
        ? /^(allow|allow once|approve|approve once|zezwól|zezwol|zezwól raz|zezwol raz|zatwierdź|zatwierdz)(?:\\s*(?:enter|return|⏎|↵))?$/i
        : /^(deny|reject|decline|odmów|odmow|odrzuć|odrzuc)(?:\\s*(?:esc|escape))?$/i;
      const candidates = [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .filter((element) => pattern.test(label(element)));
      if (candidates.length !== 1) {
        return {
          ok: false,
          reason: candidates.length === 0 ? 'approval-control-not-found' : 'approval-control-ambiguous',
          candidates: candidates.map(label).slice(0, 8)
        };
      }
      const control = label(candidates[0]);
      const rect = candidates[0].getBoundingClientRect();
      return {
        ok: true,
        control,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        mechanism: 'visible-control'
      };
    })()`);
    if (result?.ok) {
      await this.clickPoint(result.x, result.y);
      return { ok: true, control: result.control, mechanism: "native-cdp-click" };
    }

    try {
      await this.runKeycap(decision === "approve" ? "APPR" : "REJ");
      return { ok: true, mechanism: "codex-micro-keycap" };
    } catch (error) {
      throw new Error(`Codex Desktop ${decision} failed: ${result?.reason || "visible control unavailable"}; ${error.message}`);
    }
  }

  async pressAction(key) {
    await this.enableMicroRuntime();
    await this.sendHid(key, 1);
    await this.sendHid(key, 0);
    return this.snapshot();
  }

  async readReasoningLevel() {
    await this.ensureConnected();
    return this.evaluate(`(() => {
      const trigger = [...document.querySelectorAll('[data-selected-reasoning-effort]')]
        .find((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden';
        });
      return trigger?.getAttribute('data-selected-reasoning-effort') ?? null;
    })()`);
  }

  async readReasoningTriggerState() {
    await this.ensureConnected();
    return this.evaluate(`(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity || 1) > 0;
      };
      const trigger = [...document.querySelectorAll('[data-selected-reasoning-effort]')].find(visible);
      if (!trigger) return null;
      const model = [...trigger.querySelectorAll('[class*="ModelPickerTriggerModelText"]')]
        .find(visible)?.textContent?.trim()
        || document.querySelector('[data-model-picker-view-toggle="true"] [class*="ViewToggleModelLabel"]')?.textContent?.trim() || '';
      return {
        value: trigger.getAttribute('data-selected-reasoning-effort'),
        model
      };
    })()`);
  }

  async waitForReasoningThread(threadKey) {
    const expectedThreadKey = String(threadKey || "").replace(/^local:/, "");
    if (!expectedThreadKey) throw new Error("Codex Desktop reasoning session id is required.");
    let stableMatches = 0;
    return this.waitForReasoningUi(
      async () => {
        let state;
        try {
          state = await this.evaluate(`(() => {
            const expected = ${JSON.stringify(expectedThreadKey)};
            const normalize = (value) => String(value ?? '').replace(/^local:/, '');
            const visible = (element) => {
              if (!element) return false;
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return rect.width > 0 && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden';
            };
            const marker = [...document.querySelectorAll('[data-above-composer-conversation-id]')]
              .find((element) => visible(element.parentElement ?? element));
            const active = normalize(
              marker?.getAttribute('data-above-composer-conversation-id')
            );
            const trigger = [...document.querySelectorAll('[data-selected-reasoning-effort]')].find(visible);
            if (active !== expected || !trigger) return null;
            return {
              threadKey: active,
              value: trigger.getAttribute('data-selected-reasoning-effort')
            };
          })()`);
        } catch (error) {
          if (isNavigationRace(error)) state = null;
          else throw error;
        }
        stableMatches = state?.threadKey === expectedThreadKey && effortValue(state.value)
          ? stableMatches + 1
          : 0;
        return state ? { ...state, stableMatches } : null;
      },
      (state) => state?.stableMatches >= 2,
      { timeoutMs: 5000, description: "selected Codex Desktop reasoning controls" }
    );
  }

  async waitForReasoningUi(read, accept, {
    timeoutMs = 3500,
    intervalMs = 40,
    description = "Codex Desktop reasoning UI"
  } = {}) {
    const startedAt = Date.now();
    let value;
    while (Date.now() - startedAt <= timeoutMs) {
      value = await read();
      if (accept(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`${description} timed out after ${timeoutMs}ms.`);
  }

  async adjustReasoning(direction) {
    try {
      const modern = await this.evaluate(`(() => [...document.querySelectorAll('[data-codex-intelligence-trigger="true"][data-selected-reasoning-effort]')].some((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden';
      }))()`);
      if (modern) return await this.adjustReasoningSlider(direction);
      const before = await this.openEffortSubmenu();
      const currentIndex = before.options.findIndex((option) => option.value === before.value);
      const targetIndex = nextEffortIndex(currentIndex, before.options.length, direction);
      const target = before.options[targetIndex];
      return await this.applyEffortOption(before, target);
    } catch (error) {
      await this.closeReasoningMenu().catch(() => {});
      throw error;
    }
  }

  async adjustReasoningSlider(direction) {
    if (!["increase", "decrease"].includes(direction)) throw new Error("Invalid reasoning direction.");
    const before = await this.readReasoningTriggerState();
    try {
      const readSlider = () => this.evaluate(`(() => {
        const controls = [...document.querySelectorAll('[data-reasoning-slider="true"]')]
          .filter(e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0; });
        if (controls.length !== 1) return null;
        const slider = controls[0].querySelector('[role="slider"]');
        const model = document.querySelector('[data-model-picker-view-toggle="true"] [class*="ViewToggleModelLabel"]')?.textContent?.trim();
        const selected = [...document.querySelectorAll('[data-selected-reasoning-effort]')]
          .find(e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0; });
        if (!slider || !model) return null;
        return { min:Number(slider.getAttribute('aria-valuemin')), max:Number(slider.getAttribute('aria-valuemax')),
          current:Number(slider.getAttribute('aria-valuenow')), model,
          value:selected?.getAttribute('data-selected-reasoning-effort') };
      })()`);
      let initial;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const trigger = await this.evaluate(`(() => {
          const e = [...document.querySelectorAll('[data-codex-intelligence-trigger="true"]')]
            .find(element => { const r=element.getBoundingClientRect(); return r.width>0 && r.height>0; });
          if (!e) return null;
          const r = e.getBoundingClientRect();
          return { open: e.getAttribute('data-state') === 'open', x: r.left+r.width/2, y:r.top+r.height/2 };
        })()`);
        if (!trigger) throw new Error("Codex reasoning trigger is unavailable.");
        try {
          if (!trigger.open) await this.clickPoint(trigger.x, trigger.y);
          initial = await this.waitForReasoningUi(readSlider, Boolean, {
            timeoutMs: 5000,
            description: "Codex reasoning slider"
          });
          break;
        } catch (error) {
          if (attempt === 1 || !/Codex reasoning slider timed out/i.test(error.message)) throw error;
          await this.closeReasoningMenu().catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      }
      if (!initial) throw new Error("Codex reasoning slider is unavailable.");
      if (![initial.min, initial.max, initial.current].every(Number.isInteger)
        || initial.max <= initial.min || initial.current < initial.min || initial.current > initial.max) {
        throw new Error("Codex reasoning slider bounds are invalid.");
      }
      if (before.model && initial.model !== before.model) throw new Error("Codex model changed while opening reasoning.");
      const count = initial.max-initial.min+1;
      const next = initial.min + nextEffortIndex(initial.current-initial.min,count,direction);
      const delta = next-initial.current;
      const focused = await this.evaluate(`(() => {
        const e=document.querySelector('[data-reasoning-slider="true"]');
        if (!e || e.getAttribute('aria-disabled') === 'true') return false;
        e.focus(); return document.activeElement === e;
      })()`);
      if (!focused) throw new Error("Codex reasoning slider cannot receive keyboard input.");
      for (let i=0;i<Math.abs(delta);i++) await this.pressKey(delta>0 ? "ArrowRight" : "ArrowLeft");
      const after = await this.waitForReasoningUi(readSlider,
        value=>value?.current===next && value?.model===initial.model && value?.value && value.value!==initial.value,
        {description:"Codex reasoning slider change"});
      return {ok:true,from:initial.value,to:after.value,model:after.model,mechanism:"reasoning-effort-slider"};
    } finally {
      await this.closeReasoningMenu().catch(()=>{});
    }
  }

  async readReasoningSelection() {
    try {
      const state = await this.openEffortSubmenu();
      return {
        label: state.label,
        value: state.value,
        model: state.model,
        options: state.options.map(({ label, value }) => ({ label, value }))
      };
    } finally {
      await this.closeReasoningMenu().catch(() => {});
    }
  }

  async selectReasoningLabel(targetLabel) {
    const before = await this.openEffortSubmenu();
    try {
      const targetValue = effortValue(targetLabel);
      const target = before.options.find((option) =>
        option.value === targetValue || normalizeEffortLabel(option.label) === normalizeEffortLabel(targetLabel)
      );
      if (!target) throw new Error(`Codex Desktop reasoning option is unavailable: ${targetLabel}`);
      if (target.value === before.value) {
        await this.closeReasoningMenu();
        return { ok: true, from: before.value, to: before.value, label: before.label, model: before.model };
      }
      return await this.applyEffortOption(before, target);
    } catch (error) {
      await this.closeReasoningMenu().catch(() => {});
      throw error;
    }
  }

  async applyEffortOption(before, target) {
    let clicked;
    try {
      clicked = await this.evaluate(`(() => {
      const target = ${JSON.stringify(target.value)};
      const normalize = (value) => String(value ?? '')
        .normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/\\./g, '')
        .replace(/\\s+/g, ' ').trim().toLowerCase();
      const valueOf = (label) => {
        const value = normalize(label);
        if (/^(lekki|light|low)$/.test(value)) return 'low';
        if (/^(sredni|medium)$/.test(value)) return 'medium';
        if (/^(wysoki|high)$/.test(value)) return 'high';
        if (/^(bardzo wysoki|very high|xhigh)$/.test(value)) return 'xhigh';
        if (/^(maks|max)$/.test(value)) return 'max';
        if (value.startsWith('ultra')) return 'ultra';
        return null;
      };
      const option = [...document.querySelectorAll('[role="menuitem"]')]
        .find((element) => valueOf(element.textContent) === target);
      if (!option) return false;
      option.click();
      return true;
      })()`);
    } catch (error) {
      if (!isNavigationRace(error)) throw error;
      clicked = true;
    }
    if (!clicked) {
      throw new Error(`Codex Desktop reasoning option could not be clicked: ${target.value}.`);
    }
    const after = await this.waitForReasoningUi(
      () => this.readReasoningTriggerState(),
      (value) => value?.value === target.value && value?.model === before.model,
      { description: `Codex Desktop reasoning selection ${target.value}` }
    );
    await this.closeReasoningMenu().catch(() => {});
    return {
      ok: true,
      from: before.value,
      to: after.value,
      fromLabel: before.label,
      toLabel: target.label,
      model: after.model,
      mechanism: "reasoning-effort-menu"
    };
  }

  async openEffortSubmenu() {
    const readTrigger = () => this.evaluate(`(() => {
      const element = [...document.querySelectorAll('[data-selected-reasoning-effort]')]
        .find(candidate => { const r=candidate.getBoundingClientRect(); return r.width>0 && r.height>0; });
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        open: element.getAttribute('data-state') === 'open',
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
    })()`);

    let trigger = await readTrigger();
    if (!trigger) throw new Error("Codex Desktop reasoning trigger is unavailable.");
    if (!trigger.open) {
      await this.clickPoint(trigger.x, trigger.y);
    }

    const readMainMenu = () => this.evaluate(`(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const items = [...document.querySelectorAll('[role="menuitem"]')].filter(visible);
      const effort = items.find((element) => /^(nak.ad pracy|reasoning effort|effort)/i.test(
        [element.getAttribute('aria-label'), element.textContent].filter(Boolean).join(' ').trim()
      ));
      const model = items.find((element) => /^model\\s+/i.test(element.getAttribute('aria-label') ?? ''));
      if (!effort) return null;
      const rect = effort.getBoundingClientRect();
      const aria = effort.getAttribute('aria-label') ?? '';
      return {
        label: aria.replace(/^(Nak.ad pracy|Reasoning effort|Effort)\s*/i, '').trim(),
        model: (model?.getAttribute('aria-label') ?? '').replace(/^Model\\s*/i, '').trim(),
        open: effort.getAttribute('data-state') === 'open',
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
    })()`);

    let menu;
    try {
      menu = await this.waitForReasoningUi(
        readMainMenu,
        Boolean,
        { description: "Codex Desktop reasoning menu" }
      );
    } catch (initialMenuError) {
      trigger = await readTrigger();
      if (!trigger) throw initialMenuError;
      if (!trigger.open) await this.clickPoint(trigger.x, trigger.y);
      menu = await this.waitForReasoningUi(
        readMainMenu,
        Boolean,
        { timeoutMs: 6500, description: "Codex Desktop reasoning menu retry" }
      );
    }
    if (!menu.open) {
      const clicked = await this.evaluate(`(() => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden';
        };
        const effort = [...document.querySelectorAll('[role="menuitem"]')]
          .filter(visible)
          .find((element) => /^(nak.ad pracy|reasoning effort|effort)/i.test(
            [element.getAttribute('aria-label'), element.textContent].filter(Boolean).join(' ').trim()
          ));
        if (!effort) return false;
        effort.click();
        return true;
      })()`);
      if (!clicked) throw new Error("Codex Desktop reasoning effort item is unavailable.");
      menu = await this.waitForReasoningUi(
        readMainMenu,
        (value) => Boolean(value?.open),
        { description: "Codex Desktop reasoning effort submenu" }
      );
    }
    if (!menu?.open) throw new Error("Codex Desktop reasoning effort submenu did not open.");

    const readOptions = () => this.evaluate(`(() => {
      const normalize = (value) => String(value ?? '')
        .normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/\\./g, '')
        .replace(/\\s+/g, ' ').trim().toLowerCase();
      const valueOf = (label) => {
        const value = normalize(label);
        if (/^(lekki|light|low)$/.test(value)) return 'low';
        if (/^(sredni|medium)$/.test(value)) return 'medium';
        if (/^(wysoki|high)$/.test(value)) return 'high';
        if (/^(bardzo wysoki|very high|xhigh)$/.test(value)) return 'xhigh';
        if (/^(maks|max)$/.test(value)) return 'max';
        if (value.startsWith('ultra')) return 'ultra';
        return null;
      };
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      return [...document.querySelectorAll('[role="menuitem"]')]
        .filter(visible)
        .map((element) => {
          const label = (element.textContent ?? '').trim().replace(/\\s+/g, ' ');
          const value = valueOf(label);
          const rect = element.getBoundingClientRect();
          return value ? { label, value, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
        })
        .filter(Boolean);
    })()`);

    const currentValue = effortValue(menu.label);
    const options = await this.waitForReasoningUi(
      readOptions,
      (value) => {
        if (!Array.isArray(value) || value.length < 2 || !currentValue) return false;
        const values = value.map((option) => option.value);
        return new Set(values).size === values.length && values.includes(currentValue);
      },
      { description: "Codex Desktop reasoning effort options" }
    );

    const values = options.map((option) => option.value);
    const uniqueValues = new Set(values);
    if (options.length < 2 || uniqueValues.size !== options.length) {
      throw new Error("Codex Desktop reasoning effort options are incomplete or ambiguous.");
    }
    const value = currentValue;
    if (!value || !uniqueValues.has(value)) {
      throw new Error(`Codex Desktop current reasoning option is unavailable: ${menu.label || "unknown"}.`);
    }
    if (!menu.model) throw new Error("Codex Desktop selected model is unavailable.");

    return { label: menu.label, value, model: menu.model, options };
  }

  async closeReasoningMenu() {
    const readClose = () => this.evaluate(`(() => {
      const element = [...document.querySelectorAll('[data-selected-reasoning-effort]')]
        .find(candidate => { const r=candidate.getBoundingClientRect(); return r.width>0 && r.height>0; });
      if (!element || element.getAttribute('data-state') !== 'open') return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    const close = await readClose();
    if (close) {
      const isClosed = () => this.evaluate(`(() =>
        [...document.querySelectorAll('[data-selected-reasoning-effort]')]
          .find(candidate => { const r=candidate.getBoundingClientRect(); return r.width>0 && r.height>0; })
          ?.getAttribute('data-state') !== 'open'
      )()`);
      await this.evaluate(`(() => {
        const event = new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
          composed: true
        });
        (document.activeElement ?? document.body).dispatchEvent(event);
        return true;
      })()`);
      try {
        await this.waitForReasoningUi(isClosed, Boolean, {
          timeoutMs: 900,
          description: "Codex Desktop reasoning menu synthetic Escape close"
        });
      } catch (syntheticCloseError) {
        const retry = await readClose();
        if (!retry) return;
        await this.pressKey("Escape");
        try {
          await this.waitForReasoningUi(isClosed, Boolean, {
            timeoutMs: 2000,
            description: "Codex Desktop reasoning menu native Escape close"
          });
        } catch (nativeCloseError) {
          const fallback = await readClose();
          if (!fallback) return;
          await this.clickPoint(fallback.x, fallback.y);
          await this.waitForReasoningUi(isClosed, Boolean, {
            timeoutMs: 3500,
            description: "Codex Desktop reasoning menu trigger close"
          });
        }
      }
    }
  }

  async clickPoint(x, y) {
    await this.sendCdpCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await this.sendCdpCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });
  }

  async movePoint(x, y) {
    await this.sendCdpCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0
    });
  }

  async pressKey(key) {
    const codes = {
      ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
      ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
      Escape: { code: "Escape", windowsVirtualKeyCode: 27 }
    };
    const details = codes[key];
    if (!details) throw new Error(`Unsupported Codex Desktop key: ${key}`);
    await this.sendCdpCommand("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      ...details
    });
    await this.sendCdpCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      ...details
    });
  }

  async createNewTask() {
    const before = await this.snapshot();
    let visibleError;

    try {
      const control = await this.clickVisibleNewTaskControl();
      const changed = await this.waitForActiveThreadChange(before.activeThreadKey, 8000);
      if (changed && this.isConfirmedNewTaskSnapshot(before, changed)) return changed;
      visibleError = new Error(`Visible control ${control.control} did not open a new composer.`);
    } catch (error) {
      visibleError = error;
    }

    try {
      await this.runKeycap("NEW");
      const changed = await this.waitForActiveThreadChange(before.activeThreadKey, 5000);
      if (changed && this.isConfirmedNewTaskSnapshot(before, changed)) return changed;
    } catch (nativeError) {
      throw new Error(
        `Codex Desktop new task failed. Visible control: ${visibleError?.message || "unavailable"}. `
        + `Native fallback: ${nativeError.message}`
      );
    }

    throw new Error(
      `Codex Desktop new task was not confirmed. Visible control: ${visibleError?.message || "unavailable"}.`
    );
  }

  isConfirmedNewTaskSnapshot(before, current) {
    if (!current) return false;
    if (current.newComposerConfirmed === true && !current.activeThreadKey) return true;
    const currentKey = String(current.activeThreadKey || "");
    if (!currentKey || currentKey === String(before?.activeThreadKey || "")) return false;
    const knownBefore = new Set((before?.conversations || []).map((item) => String(item.threadKey || "")));
    return !knownBefore.has(currentKey);
  }

  async clickVisibleNewTaskControl() {
    await this.ensureConnected();
    const result = await this.evaluate(`(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0
          && !element.disabled
          && element.getAttribute('aria-disabled') !== 'true';
      };
      const normalized = (value) => String(value ?? '').trim().replace(/\\s+/g, ' ').toLowerCase();
      const describe = (element) => ({
        aria: normalized(element.getAttribute('aria-label')),
        title: normalized(element.getAttribute('title')),
        testId: normalized(element.getAttribute('data-testid')),
        action: normalized(element.getAttribute('data-app-action')),
        text: normalized(element.textContent)
      });
      const projectNew = /^(start|create|begin|rozpocznij|utworz|utwórz) (a )?(new|nowy|nowa) (chat|task|thread|conversation|czat|zadanie|watek|wątek|rozmowe|rozmowę) (in|for|w) .+/i;
      const projectName = ${JSON.stringify(this.projectName)};
      const exact = /^(new|start new|create new|nowy|utworz|utwórz) (chat|task|thread|conversation|project|czat|zadanie|watek|wątek|rozmowe|rozmowę|projekt)( \\(.*\\))?$/i;
      const machineHint = /(^|[-_:])(new|create)[-_:]?(chat|task|thread|conversation|project)($|[-_:])/i;
      const candidates = [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .map((element) => {
          const labels = describe(element);
          let score = 0;
          if (projectNew.test(labels.aria) && projectName && labels.aria.endsWith(' ' + projectName)) score = Math.max(score, 700);
          if (projectNew.test(labels.title) && projectName && labels.title.endsWith(' ' + projectName)) score = Math.max(score, 650);
          if (exact.test(labels.aria)) score = Math.max(score, 500);
          if (exact.test(labels.title)) score = Math.max(score, 450);
          if (machineHint.test(labels.testId)) score = Math.max(score, 400);
          if (machineHint.test(labels.action)) score = Math.max(score, 400);
          if (exact.test(labels.text)) score = Math.max(score, 300);
          return { element, labels, score };
        })
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score);
      if (candidates.length === 0) {
        return { ok: false, reason: 'new-task-control-not-found', candidates: [] };
      }
      const bestScore = candidates[0].score;
      const best = candidates.filter((candidate) => candidate.score === bestScore);
      if (best.length !== 1) {
        return {
          ok: false,
          reason: 'new-task-control-ambiguous',
          candidates: best.slice(0, 8).map((candidate) => candidate.labels)
        };
      }
      const selected = best[0];
      selected.element.click();
      return {
        ok: true,
        control: selected.labels.aria || selected.labels.title || selected.labels.testId
          || selected.labels.action || selected.labels.text,
        score: selected.score
      };
    })()`);
    if (!result?.ok) {
      const details = result?.candidates?.length ? ` Candidates: ${JSON.stringify(result.candidates)}.` : "";
      throw new Error(`Codex Desktop new task fallback failed: ${result?.reason || "unknown"}.${details}`);
    }
    return result;
  }

  async waitForActiveThreadChange(previousThreadKey, timeoutMs) {
    const previous = String(previousThreadKey || "");
    const deadline = Date.now() + timeoutMs;
    let stableNewComposerChecks = 0;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const current = await this.snapshot();
      const currentKey = String(current.activeThreadKey || "");
      if (currentKey && currentKey !== previous) return current;
      if (!currentKey && await this.hasVisibleComposer()) {
        stableNewComposerChecks += 1;
        if (stableNewComposerChecks >= 3) return { ...current, newComposerConfirmed: true };
      } else {
        stableNewComposerChecks = 0;
      }
    }
    return undefined;
  }

  async hasVisibleComposer() {
    try {
      return Boolean(await this.evaluate(`(() => [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
        .some((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden'
            && rect.width > 0 && rect.height > 0 && !element.disabled;
        }))()`));
    } catch (error) {
      if (isNavigationRace(error)) return false;
      throw error;
    }
  }

  async waitForComposerThread(threadKey) {
    const expectedThreadKey = String(threadKey || "").replace(/^local:/, "");
    if (!expectedThreadKey) throw new Error("Codex Desktop composer session id is required.");
    let stableMatches = 0;
    return this.waitForReasoningUi(
      async () => {
        let state;
        try {
          state = await this.evaluate(`(() => {
            const expected = ${JSON.stringify(expectedThreadKey)};
            const normalize = (value) => String(value ?? '').replace(/^local:/, '');
            const marker = [...document.querySelectorAll('[data-above-composer-conversation-id]')]
              .find((element) => {
                const container = element.parentElement ?? element;
                const rect = container.getBoundingClientRect();
                const style = getComputedStyle(container);
                return rect.width > 0 && rect.height > 0
                  && style.display !== 'none'
                  && style.visibility !== 'hidden';
              });
            const active = normalize(
              marker?.getAttribute('data-above-composer-conversation-id')
            );
            if (active !== expected) return null;
            const composerRoot = marker?.closest?.(
              'form[data-thread-find-composer="true"], form[data-composer-placement], form'
            ) ?? marker?.parentElement;
            if (!composerRoot) return null;
            const visible = (element) => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return rect.width > 0 && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && !element.disabled
                && element.getAttribute('aria-disabled') !== 'true';
            };
            const composers = [...composerRoot.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
              .filter(visible);
            return composers.length === 1 ? { threadKey: active, composerCount: 1 } : null;
          })()`);
        } catch (error) {
          if (isNavigationRace(error)) state = null;
          else throw error;
        }
        stableMatches = state?.threadKey === expectedThreadKey && state?.composerCount === 1
          ? stableMatches + 1
          : 0;
        return state ? { ...state, stableMatches } : null;
      },
      (state) => state?.stableMatches >= 2,
      { timeoutMs: 5000, description: "selected Codex Desktop composer" }
    );
  }

  async continueTask(threadKey) {
    await this.waitForComposerThread(threadKey);
    await this.enableMicroRuntime();
    const composerText = await this.readVisibleComposerText();
    if (composerText) await this.submitComposer(composerText);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const snapshot = await this.snapshot();
        const submitted = Boolean(composerText)
          && !(await this.composerContainsText(composerText));
        return submitted
          ? { ...snapshot, metadata: { ...snapshot.metadata, submitted: true } }
          : snapshot;
      } catch (error) {
        if (!isNavigationRace(error) || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
      }
    }
    throw new Error("Codex Desktop RUN state could not be observed.");
  }

  async stop() {
    await this.ensureConnected();
    const result = await this.evaluate(`(async () => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0
          && !element.disabled
          && element.getAttribute('aria-disabled') !== 'true';
      };
      const normalized = (element) => [
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('data-testid'),
        element.textContent
      ].filter(Boolean).join(' ').trim().toLowerCase();
      const findCandidates = () =>
        [...document.querySelectorAll('button, [role="button"]')]
          .filter(visible)
          .filter((element) =>
            /(^|\\s)(stop|interrupt|cancel generation|stop generating|zatrzymaj|przerwij|anuluj)(\\s|$)/i
              .test(normalized(element))
          );
      const readyDeadline = Date.now() + 10000;
      let candidates = findCandidates();
      while (candidates.length === 0 && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        candidates = findCandidates();
      }
      if (candidates.length !== 1) {
        return {
          ok: false,
          reason: candidates.length === 0 ? 'stop-control-not-found' : 'stop-control-ambiguous',
          candidates: candidates.map(normalized).slice(0, 8)
        };
      }
      const control = normalized(candidates[0]);
      candidates[0].click();
      const stoppedDeadline = Date.now() + 8000;
      while (Date.now() < stoppedDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (findCandidates().length === 0) return { ok: true, control, confirmed: true };
      }
      return { ok: false, reason: 'stop-not-confirmed', candidates: findCandidates().map(normalized).slice(0, 8) };
    })()`, Math.max(this.requestTimeoutMs, 20_000));
    if (!result.ok) throw new Error(`Codex Desktop stop failed: ${result.reason}.`);
    this.onEvent({ type: "task.stopped", payload: result });
    return result;
  }

  async sendHid(key, act) {
    return this.dispatchHostMessage({
      type: "codex-micro-hid-event",
      event: { key, act, slot: null, threadKey: null }
    });
  }

  async dispatchHostMessage(message) {
    await this.ensureConnected();
    const result = await this.evaluate(`(async () => {
      const message = ${JSON.stringify(message)};
      const urls = [...new Set([
        ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
        ...performance.getEntriesByType('resource').map((entry) => entry.name)
      ])].filter((url) => url.includes('/assets/') && url.endsWith('.js'));
      const likely = urls.filter((url) => /(?:vscode-api|codex-micro|app-initial|app-shared|artifact-tab-content)/.test(url)).slice(0, 120);
      for (const url of likely) {
        try {
          const module = await import(url);
          const bus = Object.values(module).find((candidate) =>
            candidate && typeof candidate === 'object' &&
            (typeof candidate.dispatchHostMessage === 'function' || typeof candidate.dispatchMessage === 'function') &&
            candidate.handlers instanceof Map &&
            (candidate.handlers.get(message.type)?.size ?? 0) > 0
          );
          if (!bus) continue;
          const dispatch = bus.dispatchHostMessage ?? bus.dispatchMessage;
          dispatch.call(bus, message);
          return {
            ok: true,
            handlers: bus.handlers instanceof Map ? (bus.handlers.get(message.type)?.size ?? 0) : null
          };
        } catch {}
      }
      return { ok: false, reason: 'native-event-bus-not-found' };
    })()`);
    if (!result?.ok) throw new Error("Codex Desktop native event bus is unavailable.");
    return result;
  }

  async runKeycap(keycapId) {
    await this.enableMicroRuntime();
    const result = await this.evaluate(`(async () => {
      const keycapId = ${JSON.stringify(keycapId)};
      const urls = [...new Set([
        ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
        ...performance.getEntriesByType('resource').map((entry) => entry.name)
      ])];
      const moduleUrl = (prefix) => urls.find((value) => value.includes('/assets/' + prefix));
      const layoutUrl = moduleUrl('codex-micro-layout-');
      const commandsUrl = moduleUrl('codex-micro-commands-');
      const bridgeUrl = moduleUrl('codex-micro-bridge-');
      const vscodeUrl = moduleUrl('vscode-api-');
      const sharedUrl = moduleUrl('app-shared-');
      const appUrl = moduleUrl('app-initial-');
      if (!layoutUrl) throw new Error('Codex Micro keycap registry is unavailable.');
      const layout = await import(layoutUrl);
      const keycapGetter = Object.values(layout).find((candidate) => {
        if (typeof candidate !== 'function') return false;
        try {
          return candidate('FAST')?.id === 'FAST' && candidate('NEW')?.id === 'NEW';
        } catch {
          return false;
        }
      });
      if (typeof keycapGetter !== 'function') throw new Error('Codex Micro keycap registry changed.');
      const keycap = keycapGetter(keycapId);
      if (keycap?.id !== keycapId) throw new Error('Codex Micro keycap is unavailable: ' + keycapId + '.');
      const action = keycap.action;
      if (!action) throw new Error('The selected Codex Micro keycap has no action.');
      if (action.type === 'command') {
        let commandRunner = null;
        if (commandsUrl) {
          const commands = await import(commandsUrl);
          if (!commands.n?.(action.command)) {
            throw new Error('Codex Desktop command is unavailable: ' + action.command + '.');
          }
        }
        if (bridgeUrl) {
          const source = await (await fetch(bridgeUrl)).text();
          const hidCallers = new Set(
            [...source.matchAll(new RegExp(${JSON.stringify(MICRO_COMMAND_RUNNER_CALL_PATTERN)}, 'g'))]
              .map((match) => match[1])
          );
          const pattern = /import\\s*\\{([^}]*)\\}\\s*from\\s*["']([^"']+)["']/g;
          const importedFunctions = new Map();
          let found;
          while ((found = pattern.exec(source))) {
            const namespace = await import(new URL(found[2], bridgeUrl).href);
            for (const specifier of found[1].split(',')) {
              const parts = specifier.trim().split(/\\s+as\\s+/);
              const exportName = parts[0];
              const localName = parts[1] ?? parts[0];
              if (typeof namespace[exportName] === 'function') {
                importedFunctions.set(localName, namespace[exportName]);
              }
            }
          }
          const candidates = [];
          for (const caller of hidCallers) {
            if (importedFunctions.has(caller)) {
              candidates.push(importedFunctions.get(caller));
              continue;
            }
            // 26.924 wraps the imported dispatcher in a local capability guard:
            // function Qt(store, command, source) { ... Fe(command, source) }.
            // Follow only one exact imported delegate for those two parameters.
            const declarationAt = source.indexOf('function ' + caller + '(');
            if (declarationAt < 0) continue;
            const parametersAt = declarationAt + ('function ' + caller + '(').length;
            const parametersEnd = source.indexOf(')', parametersAt);
            if (parametersEnd < 0) continue;
            const parameters = source.slice(parametersAt, parametersEnd).split(',').map((part) => part.trim());
            if (parameters.length < 3 || !parameters[1] || !parameters[2]) continue;
            const nextFunctionAt = source.indexOf('}function ', parametersEnd + 1);
            const wrapperEnd = nextFunctionAt >= 0 && nextFunctionAt < parametersEnd + 1200
              ? nextFunctionAt + 1
              : parametersEnd + 1200;
            const wrapper = source.slice(parametersEnd + 1, wrapperEnd).replace(/\\s+/g, '');
            const hasExactCall = (name) => {
              const call = name + '(' + parameters[1] + ',' + parameters[2] + ')';
              let at = wrapper.indexOf(call);
              while (at >= 0) {
                if (at === 0 || !/[A-Za-z0-9_$]/.test(wrapper[at - 1])) return true;
                at = wrapper.indexOf(call, at + 1);
              }
              return false;
            };
            const delegatedNames = [...importedFunctions.keys()].filter(hasExactCall);
            if (delegatedNames.length === 1) {
              candidates.push(importedFunctions.get(delegatedNames[0]));
            }
          }
          const unique = [...new Set(candidates)];
          if (unique.length === 1) commandRunner = unique[0];
          else if (unique.length > 1) throw new Error('Codex command runner is ambiguous.');
        }
        if (typeof commandRunner !== 'function') throw new Error('Codex command runner is unavailable.');
        if (!commandRunner(action.command, 'codex_micro_hid')) {
          throw new Error('This Codex command is not active in the current view.');
        }
        return { ok: true, action: action.type };
      }
      let bus = null;
      for (const eventUrl of [vscodeUrl, sharedUrl, appUrl, bridgeUrl].filter(Boolean)) {
        const module = await import(eventUrl);
        bus = Object.values(module).find((candidate) =>
          candidate && typeof candidate === 'object' &&
          typeof candidate.dispatchHostMessage === 'function' &&
          candidate.handlers instanceof Map &&
          (candidate.handlers.get('codex-micro-insert-composer-text')?.size ?? 0) > 0
        ) ?? bus;
        if (bus) break;
      }
      if (action.type === 'composer-text' && typeof bus?.dispatchHostMessage === 'function') {
        bus.dispatchHostMessage({ type: 'codex-micro-insert-composer-text', text: action.text });
        return { ok: true, action: action.type };
      }
      throw new Error('Unsupported standalone Codex Micro keycap.');
    })()`);
    return result;
  }

  async enableMicroRuntime() {
    await this.ensureConnected();
    const result = await this.evaluate(buildRuntimeOverrideExpression());
    if (!result?.ready) {
      throw new Error(`Codex Micro runtime is not ready: ${result?.reason || "native handlers unavailable"}.`);
    }
    return result;
  }

  async ensureConnected() {
    if (this.isConnected()) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  async connect() {
    this.disconnect();
    const port = this.resolvePort();
    const response = await fetch(`http://${this.host}:${port}/json/list`, {
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    if (!response.ok) throw new Error(`Codex Desktop CDP returned HTTP ${response.status}.`);
    const targets = await response.json();
    const target = selectCodexMainTarget(targets);
    if (!target?.webSocketDebuggerUrl) {
      throw new Error("Codex Desktop renderer was not found on the configured CDP port.");
    }
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex Desktop CDP connection timed out.")), this.requestTimeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Codex Desktop CDP connection failed."));
      }, { once: true });
    });
    socket.addEventListener("message", (event) => this.handleMessage(String(event.data)));
    socket.addEventListener("close", () => this.disconnect(socket));
    this.socket = socket;
    this.target = target;
  }

  disconnect(expectedSocket) {
    if (expectedSocket && this.socket !== expectedSocket) return;
    const socket = this.socket;
    this.socket = undefined;
    this.target = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex Desktop CDP connection closed."));
    }
    this.pending.clear();
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  }

  async evaluate(expression, timeoutMs = this.requestTimeoutMs) {
    await this.ensureConnected();
    const id = ++this.nextId;
    const effectiveTimeoutMs = Math.max(1, Number(timeoutMs) || this.requestTimeoutMs);
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex Desktop CDP request timed out."));
      }, effectiveTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, raw: false });
    });
    this.socket.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: {
        expression,
        awaitPromise: true,
        returnByValue: true,
        objectGroup: "hermes-control",
        userGesture: true
      }
    }));
    return response;
  }

  async sendCdpCommand(method, params = {}) {
    await this.ensureConnected();
    const id = ++this.nextId;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex Desktop CDP request timed out."));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, raw: true });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message || "Codex Desktop CDP request failed."));
      return;
    }
    const exception = message.result?.exceptionDetails;
    if (exception) {
      pending.reject(new Error(
        exception.exception?.description || exception.text || "Codex Desktop renderer evaluation failed."
      ));
      return;
    }
    pending.resolve(pending.raw ? message.result : message.result?.result?.value);
  }

  resolvePort() {
    if (this.stateFile && fs.existsSync(this.stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(this.stateFile, "utf8").replace(/^\uFEFF/, ""));
        const port = Number(state.port);
        if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
      } catch {}
    }
    return this.port;
  }
}

export function selectCodexMainTarget(targets) {
  const candidates = targets.filter((target) =>
    target.type === "page"
    && target.webSocketDebuggerUrl
    && String(target.url || "").startsWith("app://")
  );
  const isIndex = (target) => {
    try {
      return new URL(target.url).pathname === "/index.html";
    } catch {
      return false;
    }
  };
  const auxiliary = (target) => /avatar-overlay|composition-surface/i.test(target.url || "");
  return candidates.find((target) => isIndex(target) && !new URL(target.url).search)
    ?? candidates.find(isIndex)
    ?? candidates.find((target) => !auxiliary(target) && !String(target.url).includes("initialRoute="))
    ?? candidates.find((target) => !auxiliary(target));
}

export function buildRuntimeOverrideExpression() {
  return `(async () => {
    const gateName = ${JSON.stringify(MICRO_GATE)};
    const statsig = globalThis.__STATSIG__;
    if (!statsig) return { ready: false, reason: 'statsig-unavailable' };
    const clients = [...new Set([statsig.firstInstance, ...Object.values(statsig.instances ?? {})].filter(Boolean))];
    if (clients.length === 0) return { ready: false, reason: 'statsig-client-unavailable' };
    for (const client of clients) {
      if (client.overrideAdapter?.__hermesControlGate !== gateName) {
        const original = client.overrideAdapter ?? {};
        client.overrideAdapter = new Proxy(original, {
          get(target, property) {
            if (property === '__hermesControlGate') return gateName;
            if (property === 'getGateOverride') {
              return (gate, user, options) => {
                if (gate?.name === gateName) return { ...gate, value: true };
                const fallback = Reflect.get(target, property, target);
                return typeof fallback === 'function' ? fallback.call(target, gate, user, options) : gate;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      }
      client._memoCache = {};
    }
    const urls = [...new Set([
      ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
      ...performance.getEntriesByType('resource').map((entry) => entry.name)
    ])].filter((url) => url.includes('/assets/') && url.endsWith('.js'));
    const persistedUrl = urls.find((url) => url.includes('/assets/persisted-signal-'));
    let detected = null;
    if (persistedUrl) {
      const persisted = await import(persistedUrl);
      if (typeof persisted.p === 'function' && typeof persisted.b === 'function') {
        persisted.b(${JSON.stringify(DETECTION_KEY)}, true);
        detected = Boolean(persisted.p(${JSON.stringify(DETECTION_KEY)}, false));
      }
    } else {
      // Newer Desktop bundles inline the persisted signal into app-initial or
      // import its factory from app-shared. Resolve the exact factory module
      // and its getter/setter exports, then fail closed on ambiguity.
      const appUrl = urls.find((url) => url.includes('/assets/app-initial-'));
      if (!appUrl) return { ready: false, reason: 'micro-persistence-module-unavailable' };
      const cacheKey = '__hermesControlMicroBundleV3';
      let contract = globalThis[cacheKey];
      if (contract?.url !== appUrl) {
        const appSource = await (await fetch(appUrl)).text();
        const key = ${JSON.stringify(DETECTION_KEY)};
        const keyAt = appSource.indexOf(key);
        if (keyAt < 0 || appSource.indexOf(key, keyAt + key.length) >= 0) {
          return { ready: false, reason: 'micro-detection-key-ambiguous' };
        }
        const beforeKey = keyAt < 0 ? '' : appSource.slice(Math.max(0, keyAt - 100), keyAt);
        const signalMatch = beforeKey.match(/([A-Za-z_$][\\w$]*)=([A-Za-z_$][\\w$]*)\\([^A-Za-z_$]{1,2}$/);
        const factoryName = signalMatch?.[2];
        let factoryUrl = appUrl;
        let factorySource = appSource;
        let factorySymbol = factoryName;
        let factoryStart = factoryName ? appSource.indexOf('function ' + factoryName + '(') : -1;
        if (factoryName && factoryStart < 0) {
          const importPattern = /import\\s*\\{([^}]*)\\}\\s*from\\s*["']([^"']+)["']/g;
          const imports = [];
          let imported;
          while ((imported = importPattern.exec(appSource))) {
            for (const specifier of imported[1].split(',')) {
              const parts = specifier.trim().split(/\\s+as\\s+/);
              if ((parts[1] ?? parts[0]) === factoryName) {
                imports.push({ exportName: parts[0], url: new URL(imported[2], appUrl).href });
              }
            }
          }
          if (imports.length !== 1) {
            return { ready: false, reason: 'micro-persistence-factory-import-ambiguous' };
          }
          factoryUrl = imports[0].url;
          factorySource = await (await fetch(factoryUrl)).text();
          const factoryExportStart = factorySource.lastIndexOf('export{');
          const factoryExportEnd = factoryExportStart < 0 ? -1 : factorySource.indexOf('}', factoryExportStart + 7);
          const factoryExports = factoryExportEnd < 0 ? '' : factorySource.slice(factoryExportStart + 7, factoryExportEnd);
          const symbols = factoryExports.split(',')
            .map((part) => part.trim().match(/^([A-Za-z_$][\\w$]*) as ([A-Za-z_$][\\w$]*)$/))
            .filter((match) => match?.[2] === imports[0].exportName)
            .map((match) => match[1]);
          if (symbols.length !== 1) {
            return { ready: false, reason: 'micro-persistence-factory-export-ambiguous' };
          }
          factorySymbol = symbols[0];
          factoryStart = factorySource.indexOf('function ' + factorySymbol + '(');
        }
        const factory = factoryStart < 0 ? '' : factorySource.slice(factoryStart, factoryStart + 1800);
        const setterName = factory.match(/publishDelayMs==null\\?([A-Za-z_$][\\w$]*)\\(/)?.[1];
        const getterName = factory.match(/let [A-Za-z_$][\\w$]*=([A-Za-z_$][\\w$]*)\\(e,t\\)/)?.[1];
        const exportStart = factorySource.lastIndexOf('export{');
        const exportEnd = exportStart < 0 ? -1 : factorySource.indexOf('}', exportStart + 7);
        const exported = exportEnd < 0 ? '' : factorySource.slice(exportStart + 7, exportEnd);
        const exportName = (symbol) => exported.split(',')
          .map((part) => part.trim().match(/^([A-Za-z_$][\\w$]*) as ([A-Za-z_$][\\w$]*)$/))
          .filter((match) => match?.[1] === symbol)
          .map((match) => match[2]);
        const setters = setterName ? exportName(setterName) : [];
        const getters = getterName ? exportName(getterName) : [];
        if (setters.length !== 1 || getters.length !== 1) {
          return { ready: false, reason: 'micro-persistence-contract-changed' };
        }
        contract = { url: appUrl, factoryUrl, setter: setters[0], getter: getters[0] };
        globalThis[cacheKey] = contract;
      }
      const persistence = await import(contract.factoryUrl ?? appUrl);
      if (typeof persistence[contract.setter] !== 'function' || typeof persistence[contract.getter] !== 'function') {
        return { ready: false, reason: 'micro-persistence-exports-unavailable' };
      }
      persistence[contract.setter](${JSON.stringify(DETECTION_KEY)}, true);
      detected = persistence[contract.getter](${JSON.stringify(DETECTION_KEY)}, false) === true;
    }
    for (const client of clients) client.$emt?.({ name: 'values_updated' });
    const likely = urls.filter((url) => /(?:vscode-api|codex-micro|app-initial|app-shared|artifact-tab-content)/.test(url)).slice(0, 120);
    let bus = null;
    for (const url of likely) {
      try {
        const module = await import(url);
        const candidate = Object.values(module).find((candidate) =>
          candidate && typeof candidate === 'object' &&
          (typeof candidate.dispatchHostMessage === 'function' || typeof candidate.dispatchMessage === 'function') &&
          candidate.handlers instanceof Map &&
          (candidate.handlers.get('codex-micro-device-state-changed')?.size ?? 0) > 0
        );
        if (candidate) { bus = candidate; break; }
      } catch {}
    }
    if (bus) {
      const dispatch = bus.dispatchHostMessage ?? bus.dispatchMessage;
      dispatch.call(bus, ${JSON.stringify(DEVICE_STATE)});
    }
    const hidHandlers = bus?.handlers instanceof Map ? (bus.handlers.get('codex-micro-hid-event')?.size ?? 0) : 0;
    const joystickHandlers = bus?.handlers instanceof Map ? (bus.handlers.get('codex-micro-joystick-event')?.size ?? 0) : 0;
    const enabled = clients.map((client) => Boolean(client.checkGate?.(gateName)));
    const ready = enabled.every(Boolean) && detected === true && Boolean(bus) && hidHandlers > 0;
    return {
      ready,
      reason: ready ? undefined : !enabled.every(Boolean)
        ? 'micro-gate-unavailable'
        : detected !== true ? 'micro-detection-unavailable'
        : !bus ? 'micro-event-bus-unavailable'
        : 'micro-hid-handlers-unavailable',
      enabled,
      detected,
      nativeEventBus: Boolean(bus),
      hidHandlers,
      joystickHandlers
    };
  })()`;
}

function buildSnapshotExpression() {
  return `(() => {
    const commandStateKey = '__hermesControlCommandStateV1';
    if (!window[commandStateKey]) {
      const state = {
        approve: false,
        decline: false,
        approvalChangedAt: 0,
        installedAt: Date.now(),
        trackedMaps: new WeakSet()
      };
      const nativeSet = Map.prototype.set;
      const nativeDelete = Map.prototype.delete;
      const nativeClear = Map.prototype.clear;
      Map.prototype.set = function hermesControlTrackCommand(key, value) {
        if (key === 'approval.approve' || key === 'approval.decline') {
          state.trackedMaps.add(this);
          const flag = key === 'approval.approve' ? 'approve' : 'decline';
          const next = Array.isArray(value) ? value.length > 0 : Boolean(value);
          if (state[flag] !== next) state.approvalChangedAt = Date.now();
          state[flag] = next;
        }
        return nativeSet.call(this, key, value);
      };
      Map.prototype.delete = function hermesControlUntrackCommand(key) {
        if (
          state.trackedMaps.has(this)
          && (key === 'approval.approve' || key === 'approval.decline')
        ) {
          const flag = key === 'approval.approve' ? 'approve' : 'decline';
          if (state[flag]) state.approvalChangedAt = Date.now();
          state[flag] = false;
        }
        return nativeDelete.call(this, key);
      };
      Map.prototype.clear = function hermesControlClearCommands() {
        if (state.trackedMaps.has(this)) {
          if (state.approve || state.decline) state.approvalChangedAt = Date.now();
          state.approve = false;
          state.decline = false;
        }
        return nativeClear.call(this);
      };
      window[commandStateKey] = state;
    }
    const commandState = window[commandStateKey];
    if (!Number.isFinite(commandState.approvalChangedAt)) commandState.approvalChangedAt = 0;
    const normalizeThreadKey = (value) => String(value ?? '').replace(/^local:/, '');
    const activeComposerMarker = [...document.querySelectorAll('[data-above-composer-conversation-id]')]
      .find((element) => {
        const container = element.parentElement ?? element;
        const rect = container.getBoundingClientRect();
        const style = getComputedStyle(container);
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden';
      });
    const activeElement =
      document.querySelector('[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-active="true"]')
      ?? document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]');
    const activeThreadKey = normalizeThreadKey(
      activeComposerMarker?.getAttribute('data-above-composer-conversation-id')
      ?? activeElement?.getAttribute('data-app-action-sidebar-thread-id')
      ?? undefined
    );
    const activeSidebarThreadKey = normalizeThreadKey(
      activeElement?.getAttribute('data-app-action-sidebar-thread-id') ?? undefined
    );
    const seen = new Set();
    const conversations = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
      .map((element) => {
        const threadKey = normalizeThreadKey(element.getAttribute('data-app-action-sidebar-thread-id'));
        if (!threadKey || seen.has(threadKey)) return null;
        seen.add(threadKey);
        const title = (
          element.getAttribute('aria-label')
          ?? element.querySelector('[title]')?.getAttribute('title')
          ?? element.textContent
          ?? 'Codex task'
        ).trim().replace(/\\s+/g, ' ').slice(0, 240);
        return {
          threadKey,
          title,
          selected: threadKey === activeThreadKey || threadKey === activeSidebarThreadKey,
          status: threadKey === activeThreadKey || threadKey === activeSidebarThreadKey ? 'active' : 'idle'
        };
      })
      .filter(Boolean)
      .slice(0, 50);
    const activeThreadTitle =
      conversations.find((item) => item.threadKey === activeThreadKey)?.title
      ?? (activeElement?.getAttribute('aria-label') ?? activeElement?.textContent ?? '').trim().slice(0, 240)
      ?? undefined;
    const activeResponse = [...document.querySelectorAll('[data-response-annotation-conversation]')]
      .filter((element) => normalizeThreadKey(element.getAttribute('data-response-annotation-conversation')) === activeThreadKey)
      .at(-1);
    const turnId = activeResponse
      ?.closest('[data-content-search-turn-key]')
      ?.getAttribute('data-content-search-turn-key') ?? undefined;
    const assistantText = activeResponse
      ?.querySelector('[class*="MarkdownRoot"]')
      ?.innerText?.trim() ?? undefined;
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const visibleControls = [...document.querySelectorAll('button, [role="button"]')].filter(isVisible);
    const controlLabel = (element) => [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.textContent
    ].filter(Boolean).join(' ').trim().replace(/\\s+/g, ' ').toLowerCase();
    const approvalLabels = visibleControls.map(controlLabel);
    const hasAllow = approvalLabels.some((label) =>
      /^(allow|allow once|approve|approve once|zezwól|zezwol|zezwól raz|zezwol raz|zatwierdź|zatwierdz)(?:\\s*(?:enter|return|⏎|↵))?$/i.test(label)
    );
    const hasDeny = approvalLabels.some((label) =>
      /^(deny|reject|decline|odmów|odmow|odrzuć|odrzuc)(?:\\s*(?:esc|escape))?$/i.test(label)
    );
    const registryHasApproval = Boolean(commandState.approve && commandState.decline);
    const commandApproval = registryHasApproval;
    const waitingApproval = commandApproval || (hasAllow && hasDeny);
    const working = visibleControls.some((element) => {
      const label = controlLabel(element);
      return /(^|\\s)(stop|interrupt|cancel generation|stop generating|zatrzymaj|przerwij|anuluj)(\\s|$)/i.test(label);
    });
    const reasoningTrigger = [...document.querySelectorAll('[data-selected-reasoning-effort]')].find(isVisible);
    const reasoning = reasoningTrigger?.getAttribute('data-selected-reasoning-effort') ?? undefined;
    const model = [...(reasoningTrigger?.querySelectorAll('[class*="ModelPickerTriggerModelText"]') ?? [])]
      .find(isVisible)?.textContent?.trim() ?? undefined;
    return {
      activeThreadKey,
      activeSidebarThreadKey,
      activeThreadTitle,
      turnId,
      assistantText,
      conversations,
      working,
      waitingApproval,
      reasoning,
      model,
      approvalDetection: commandApproval ? 'command-registry' : waitingApproval ? 'visible-controls' : undefined,
      approvalHintAt: commandApproval ? commandState.approvalChangedAt : undefined,
      observedAt: Date.now()
    };
  })()`;
}

function isNavigationRace(error) {
  return /Promise was collected|context.*destroyed|execution context|Cannot find context/i.test(error?.message || "");
}
