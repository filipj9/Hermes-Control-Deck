import fs from "node:fs";

const MICRO_GATE = "3207467860";
const DETECTION_KEY = "codex-micro-has-ever-been-detected";
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
  reject: "ACT08",
  send: "ACT12"
};

const REASONING_KEYS = {
  decrease: "ENC_CW",
  increase: "ENC_CC"
};

export class CodexDesktopBridge {
  constructor(config, options = {}) {
    this.host = config.desktopCdpHost || "127.0.0.1";
    this.port = Number(config.desktopCdpPort || 4248);
    this.stateFile = config.desktopBridgeStateFile || "";
    this.requestTimeoutMs = Number(config.desktopBridgeRequestTimeoutMs || 6000);
    this.onEvent = options.onEvent || (() => {});
    this.socket = undefined;
    this.target = undefined;
    this.nextId = 0;
    this.pending = new Map();
    this.connecting = undefined;
    this.lastSnapshot = undefined;
    this.sidebarThreadByCanonical = new Map();
    this.canonicalThreadBySidebar = new Map();
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
      const activeThreadKey = () =>
        normalizeThreadKey(
          document.querySelector('[data-above-composer-conversation-id]')?.getAttribute('data-above-composer-conversation-id')
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

  async sendPrompt(text, options = {}) {
    await this.enableMicroRuntime();
    if (options.threadKey) await this.activateThread(options.threadKey);
    const before = await this.snapshot();
    await this.insertComposerText(text);
    const inserted = await this.waitForComposerText(text, 800);
    if (!inserted) {
      throw new Error("Codex Desktop did not confirm prompt insertion; SEND was not pressed.");
    }
    await this.sendHid(ACTION_KEYS.send, 1);
    await this.sendHid(ACTION_KEYS.send, 0);
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
        ? /^(allow|allow once|approve|approve once|zezwól|zezwol|zezwól raz|zezwol raz|zatwierdź|zatwierdz)(?:\s*(?:enter|return|⏎|↵))?$/i
        : /^(deny|reject|decline|odmów|odmow|odrzuć|odrzuc)(?:\s*(?:esc|escape))?$/i;
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

  async adjustReasoning(direction) {
    const key = REASONING_KEYS[direction];
    if (!key) throw new Error(`Unknown Codex reasoning direction: ${direction}`);
    await this.enableMicroRuntime();
    const before = await this.readReasoningLevel();
    await this.sendHid(key, 2);
    await new Promise((resolve) => setTimeout(resolve, 180));
    let after = await this.readReasoningLevel();
    if (after && after !== before) return { ok: true, from: before, to: after, mechanism: "encoder" };

    await this.sendHid(key, 1);
    await this.sendHid(key, 0);
    await new Promise((resolve) => setTimeout(resolve, 180));
    after = await this.readReasoningLevel();
    if (after && after !== before) return { ok: true, from: before, to: after, mechanism: "encoder-pulse" };

    return this.selectAdjacentReasoning(direction, before);
  }

  async readReasoningLevel() {
    await this.ensureConnected();
    return this.evaluate(`(() =>
      document.querySelector('[data-selected-reasoning-effort]')
        ?.getAttribute('data-selected-reasoning-effort') ?? null
    )()`);
  }

  async selectAdjacentReasoning(direction, currentLevel) {
    const levels = ["low", "medium", "high", "xhigh"];
    const currentIndex = levels.indexOf(currentLevel);
    if (currentIndex < 0) throw new Error("Codex Desktop reasoning level is unavailable.");
    const delta = direction === "increase" ? 1 : -1;
    const targetLevel = levels[Math.max(0, Math.min(levels.length - 1, currentIndex + delta))];
    if (targetLevel === currentLevel) {
      return { ok: true, from: currentLevel, to: targetLevel, mechanism: "limit" };
    }

    const trigger = await this.evaluate(`(() => {
      const element = document.querySelector('[data-selected-reasoning-effort]');
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        open: element.getAttribute('data-state') === 'open'
      };
    })()`);
    if (!trigger) throw new Error("Codex Desktop reasoning trigger is unavailable.");
    if (!trigger.open) {
      await this.clickPoint(trigger.x, trigger.y);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const sliderFocused = await this.evaluate(`(() => {
      const slider = document.querySelector('[data-reasoning-slider="true"]');
      if (!slider) return false;
      slider.focus();
      return document.activeElement === slider;
    })()`);
    if (sliderFocused) {
      await this.pressKey(direction === "increase" ? "ArrowRight" : "ArrowLeft");
      await new Promise((resolve) => setTimeout(resolve, 250));
      const selected = await this.readReasoningLevel();
      if (selected && selected !== currentLevel) {
        return { ok: true, from: currentLevel, to: selected, mechanism: "reasoning-slider" };
      }
    }

    const effortMenu = await this.evaluate(`(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((element) => {
        const label = [
          element.getAttribute('aria-label'),
          element.textContent
        ].filter(Boolean).join(' ').trim();
        return /(?:nakład pracy|naklad pracy|reasoning effort|effort)/i.test(label);
      });
      if (!item) return null;
      const rect = item.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        open: item.getAttribute('data-state') === 'open'
      };
    })()`);
    if (!effortMenu) throw new Error("Codex Desktop reasoning effort menu is unavailable.");
    if (!effortMenu.open) {
      await this.movePoint(effortMenu.x, effortMenu.y);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    const option = await this.evaluate(`(() => {
      const target = ${JSON.stringify(targetLevel)};
      const items = [...document.querySelectorAll(
        '[role="menuitemradio"], [role="menuitem"], [role="option"], [data-radix-collection-item]'
      )].filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      });
      const labels = {
        low: /^(low|niski)$/i,
        medium: /^(medium|med|średni|sredni)$/i,
        high: /^(high|wysoki)$/i,
        xhigh: /^(very high|extra high|xhigh|bardzo wysoki)$/i
      };
      const candidate = items.find((element) => {
        const attributes = [
          element.getAttribute('data-value'),
          element.getAttribute('value'),
          element.getAttribute('data-reasoning-effort')
        ].filter(Boolean).join(' ').toLowerCase();
        const text = (element.textContent ?? '').trim().replace(/\\s+/g, ' ');
        return attributes.split(/\\s+/).includes(target) || labels[target].test(text);
      });
      if (!candidate) {
        return {
          reason: 'reasoning-option-not-found',
          options: items.map((element) => (element.textContent ?? '').trim()).filter(Boolean).slice(0, 20)
        };
      }
      const rect = candidate.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!option?.x || !option?.y) {
      throw new Error(`Codex Desktop reasoning change failed: ${option?.reason || "option-not-found"}.`);
    }
    await this.clickPoint(option.x, option.y);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const selected = await this.readReasoningLevel();
    if (selected !== targetLevel) {
      throw new Error("Codex Desktop reasoning change failed: selection-not-applied.");
    }
    return { ok: true, from: currentLevel, to: targetLevel, mechanism: "menu" };
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
      ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 }
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
      if (changed) return changed;
      visibleError = new Error(`Visible control ${control.control} did not open a new composer.`);
    } catch (error) {
      visibleError = error;
    }

    try {
      await this.runKeycap("NEW");
      const changed = await this.waitForActiveThreadChange(before.activeThreadKey, 5000);
      if (changed) return changed;
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
      const exact = /^(new|start new|create new|nowy|utworz|utwórz) (chat|task|thread|conversation|project|czat|zadanie|watek|wątek|rozmowe|rozmowę|projekt)( \\(.*\\))?$/i;
      const machineHint = /(^|[-_:])(new|create)[-_:]?(chat|task|thread|conversation|project)($|[-_:])/i;
      const candidates = [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .map((element) => {
          const labels = describe(element);
          let score = 0;
          if (projectNew.test(labels.aria)) score = Math.max(score, 700);
          if (projectNew.test(labels.title)) score = Math.max(score, 650);
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
        if (stableNewComposerChecks >= 3) return current;
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

  async continueTask() {
    await this.runKeycap("RUN");
    return this.snapshot();
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
    })()`);
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
      const likely = urls.filter((url) => /(?:vscode-api|codex-micro|app-initial|artifact-tab-content)/.test(url)).slice(0, 120);
      for (const url of likely) {
        try {
          const module = await import(url);
          const bus = Object.values(module).find((candidate) =>
            candidate && typeof candidate === 'object' &&
            (typeof candidate.dispatchHostMessage === 'function' || typeof candidate.dispatchMessage === 'function')
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
      const appUrl = moduleUrl('app-initial-');
      const vscodeUrl = moduleUrl('vscode-api-');
      if (!layoutUrl) throw new Error('Codex Micro keycap registry is unavailable.');
      const layout = await import(layoutUrl);
      const keycapGetter = Object.values(layout).find((candidate) => {
        if (typeof candidate !== 'function') return false;
        try { return candidate('FAST')?.id === 'FAST'; } catch { return false; }
      });
      if (typeof keycapGetter !== 'function') throw new Error('Codex Micro keycap registry changed.');
      const action = keycapGetter(keycapId)?.action;
      if (!action) throw new Error('The selected Codex Micro keycap has no action.');
      if (action.type === 'command') {
        let commandRunner = null;
        // Current Codex Desktop bundles execute Micro commands through the
        // app-initial runner; older bundles exposed run-command-* instead.
        if (appUrl) {
          const app = await import(appUrl);
          if (typeof app.k8 === 'function') commandRunner = app.k8;
        }
        if (commandsUrl) {
          const commands = await import(commandsUrl);
          if (!commands.n?.(action.command)) {
            throw new Error('Codex Desktop command is unavailable: ' + action.command + '.');
          }
        }
        if (!commandRunner && bridgeUrl) {
          const source = await (await fetch(bridgeUrl)).text();
          const match = source.match(/([A-Za-z_$][\\w$]*)\\(\\s*[A-Za-z_$][\\w$]*\\??\\.command\\s*,["'\x60]codex_micro_hid["'\x60]\\)/);
          const local = match?.[1];
          const pattern = /import\\s*\\{([^}]*)\\}\\s*from\\s*["']([^"']+)["']/g;
          let found;
          while (local && (found = pattern.exec(source))) {
            for (const specifier of found[1].split(',')) {
              const parts = specifier.trim().split(/\\s+as\\s+/);
              const exportName = parts[0];
              const localName = parts[1] ?? parts[0];
              if (localName !== local) continue;
              const namespace = await import(new URL(found[2], bridgeUrl).href);
              if (typeof namespace[exportName] === 'function') commandRunner = namespace[exportName];
              break;
            }
            if (commandRunner) break;
          }
        }
        if (typeof commandRunner !== 'function') throw new Error('Codex command runner is unavailable.');
        if (!commandRunner(action.command, 'codex_micro_hid')) {
          throw new Error('This Codex command is not active in the current view.');
        }
        return { ok: true, action: action.type };
      }
      if (!vscodeUrl) throw new Error('Codex event module is unavailable.');
      const vscode = await import(vscodeUrl);
      const bus = [vscode.g, vscode.m, ...Object.values(vscode)].find((candidate) =>
        candidate && typeof candidate === 'object' &&
        (typeof candidate.dispatchHostMessage === 'function' || typeof candidate.dispatchMessage === 'function')
      );
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

  async evaluate(expression) {
    await this.ensureConnected();
    const id = ++this.nextId;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex Desktop CDP request timed out."));
      }, this.requestTimeoutMs);
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

function buildRuntimeOverrideExpression() {
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
    }
    for (const client of clients) client.$emt?.({ name: 'values_updated' });
    const likely = urls.filter((url) => /(?:vscode-api|codex-micro|app-initial|artifact-tab-content)/.test(url)).slice(0, 120);
    let bus = null;
    for (const url of likely) {
      try {
        const module = await import(url);
        bus = Object.values(module).find((candidate) =>
          candidate && typeof candidate === 'object' &&
          (typeof candidate.dispatchHostMessage === 'function' || typeof candidate.dispatchMessage === 'function')
        ) ?? bus;
        if (bus?.handlers instanceof Map && (bus.handlers.get('codex-micro-device-state-changed')?.size ?? 0) > 0) break;
      } catch {}
    }
    if (bus) {
      const dispatch = bus.dispatchHostMessage ?? bus.dispatchMessage;
      dispatch.call(bus, ${JSON.stringify(DEVICE_STATE)});
    }
    const hidHandlers = bus?.handlers instanceof Map ? (bus.handlers.get('codex-micro-hid-event')?.size ?? 0) : 0;
    const joystickHandlers = bus?.handlers instanceof Map ? (bus.handlers.get('codex-micro-joystick-event')?.size ?? 0) : 0;
    const enabled = clients.map((client) => Boolean(client.checkGate?.(gateName)));
    return {
      ready: enabled.every(Boolean) && Boolean(bus) && hidHandlers > 0,
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
    const activeElement =
      document.querySelector('[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-active="true"]')
      ?? document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]');
    const activeThreadKey = normalizeThreadKey(
      document.querySelector('[data-above-composer-conversation-id]')?.getAttribute('data-above-composer-conversation-id')
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
    const visibleControls = [...document.querySelectorAll('button, [role="button"]')].filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      });
    const controlLabel = (element) => [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.textContent
    ].filter(Boolean).join(' ').trim().replace(/\\s+/g, ' ').toLowerCase();
    const approvalLabels = visibleControls.map(controlLabel);
    const hasAllow = approvalLabels.some((label) =>
      /^(allow|allow once|approve|approve once|zezwól|zezwol|zezwól raz|zezwol raz|zatwierdź|zatwierdz)(?:\s*(?:enter|return|⏎|↵))?$/i.test(label)
    );
    const hasDeny = approvalLabels.some((label) =>
      /^(deny|reject|decline|odmów|odmow|odrzuć|odrzuc)(?:\s*(?:esc|escape))?$/i.test(label)
    );
    const registryHasApproval = Boolean(commandState.approve && commandState.decline);
    const commandApproval = registryHasApproval;
    const waitingApproval = commandApproval || (hasAllow && hasDeny);
    const working = visibleControls.some((element) => {
      const label = controlLabel(element);
      return /(^|\\s)(stop|interrupt|cancel generation|stop generating|zatrzymaj|przerwij|anuluj)(\\s|$)/i.test(label);
    });
    return {
      activeThreadKey,
      activeSidebarThreadKey,
      activeThreadTitle,
      conversations,
      working,
      waitingApproval,
      approvalDetection: commandApproval ? 'command-registry' : waitingApproval ? 'visible-controls' : undefined,
      approvalHintAt: commandApproval ? commandState.approvalChangedAt : undefined,
      observedAt: Date.now()
    };
  })()`;
}

function isNavigationRace(error) {
  return /Promise was collected|context.*destroyed|execution context|Cannot find context/i.test(error?.message || "");
}
