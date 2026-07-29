const reasoningLevels = ["low", "med", "high", "xhigh"];
const initialTheme = detectTheme();
const bootStartedAt = performance.now();

const state = {
  theme: initialTheme,
  stageMode: isStageMode(),
  activeRuntime: "codex",
  codexSessionMode: readStoredCodexSessionMode(initialTheme),
  codexSurfaceMode: "cli",
  selectedConversationId: undefined,
  sectionFilters: {
    agents: "codex",
    tasks: "codex",
    sessions: "codex",
    approvals: "codex"
  },
  runtimes: [],
  agents: [],
  tasks: [],
  conversations: [],
  approvals: [],
  runtimeErrors: [],
  runtimeActivity: {
    codex: "idle",
    hermes: "idle"
  },
  runtimeSignals: {
    codex: { status: "idle", label: "IDLE", detail: "local", unread: false, since: Date.now() },
    hermes: { status: "idle", label: "IDLE", detail: "remote", unread: false, since: Date.now() }
  },
  reasoningLevel: readStoredReasoning(),
  knobTurns: {},
  activityTimers: {},
  recentErrors: {},
  streams: [],
  streamMap: new Map(),
  streamRenderQueued: false,
  eventRenderTimer: undefined,
  lastEventRenderAt: 0,
  liveRefreshTimer: undefined,
  runtimeRefreshPromise: undefined,
  resumeRefreshTimer: undefined,
  promptOpen: false,
  lastPrompt: "",
  tilt: {
    enabled: false,
    device: false,
    raf: 0,
    x: 0,
    y: 0
  },
  events: []
};

const cacheConfig = {
  runtimes: { key: "hermes_control_runtimes_v1", ttlMs: 10000 },
  agents: { key: "hermes_control_agents_v1", ttlMs: 30000 },
  tasks: { key: "hermes_control_tasks_v1", ttlMs: 5000 },
  sessions: { key: "hermes_control_sessions_v1", ttlMs: 10000 },
  approvals: { key: "hermes_control_approvals_v1", ttlMs: 3000 }
};

const deckLayouts = {
  codex: [
    { kind: "knob", action: "toggle-runtime", icon: "C", label: "MODE" },
    { kind: "control soft", action: "status", icon: "●", label: "STATUS" },
    { kind: "control soft", action: "new-task", icon: "+", label: "NEW" },
    { kind: "knob dark", action: "reasoning", icon: "R", label: "MED" },

    { kind: "control soft", action: "continue", icon: "▶", label: "RUN" },
    { kind: "control soft hot", action: "events", icon: "◉", label: "LOG" },
    { kind: "control soft", action: "approve", icon: "✓", label: "ALLOW" },
    { kind: "control soft", action: "reject", icon: "×", label: "DENY" },

    { kind: "control hot", action: "new-task", icon: "⚡", label: "TASK" },
    { kind: "control", action: "approve", icon: "✓", label: "OK" },
    { kind: "control", action: "reject", icon: "×", label: "NO" },
    { kind: "control", action: "sessions", icon: "↗", label: "SESS" },

    { kind: "control wide hot", action: "send", icon: "◎", label: "PROMPT" },
    { kind: "socket emergency", action: "stop", icon: "", label: "STOP" },
    { kind: "control", action: "continue", icon: "∞", label: "FLOW" }
  ],
  hermes: [
    { kind: "knob", action: "toggle-runtime", icon: "H", label: "MODE" },
    { kind: "control soft", action: "status", icon: "●", label: "HEALTH" },
    { kind: "control soft", action: "models", icon: "M", label: "MODELS" },
    { kind: "knob dark", action: "reasoning", icon: "R", label: "MED" },

    { kind: "control soft", action: "agents", icon: "A", label: "AGENTS" },
    { kind: "control soft hot", action: "sessions", icon: "S", label: "CHAT" },
    { kind: "control soft", action: "kanban", icon: "K", label: "TASKS" },
    { kind: "control soft", action: "events", icon: "E", label: "EVENTS" },

    { kind: "control hot", action: "status", icon: "⚡", label: "PING" },
    { kind: "control", action: "approve", icon: "✓", label: "ALLOW" },
    { kind: "control", action: "reject", icon: "×", label: "DENY" },
    { kind: "control", action: "metrics", icon: "↗", label: "METR" },

    { kind: "control wide hot", action: "send", icon: "◎", label: "PROMPT" },
    { kind: "socket emergency", action: "stop", icon: "", label: "STOP" },
    { kind: "control", action: "sessions", icon: "∞", label: "SESS" }
  ]
};

normalizeDeckIcons();

const el = {
  systemLed: document.querySelector("#systemLed"),
  microStage: document.querySelector(".micro-stage"),
  runtimeStrip: document.querySelector("#runtimeStrip"),
  agentKeys: document.querySelector("#agentKeys"),
  hardwareDeck: document.querySelector("#hardwareDeck"),
  microDevice: document.querySelector("#microDevice"),
  tiltToggle: document.querySelector("#tiltToggle"),
  promptStrip: document.querySelector(".prompt-strip"),
  promptInput: document.querySelector("#promptInput"),
  promptOverlay: document.querySelector("#promptOverlay"),
  promptTrigger: document.querySelector("#promptTrigger"),
  promptPreview: document.querySelector("#promptPreview"),
  promptRun: document.querySelector("#promptRun"),
  promptRuntimeTabs: document.querySelector("#promptRuntimeTabs"),
  authOverlay: document.querySelector("#authOverlay"),
  authForm: document.querySelector("#authForm"),
  authTokenInput: document.querySelector("#authTokenInput"),
  authError: document.querySelector("#authError"),
  agentsList: document.querySelector("#agentsList"),
  tasksList: document.querySelector("#tasksList"),
  sessionsList: document.querySelector("#sessionsList"),
  approvalsList: document.querySelector("#approvalsList"),
  eventTimeline: document.querySelector("#eventTimeline"),
  liveLog: document.querySelector("#liveLog"),
  streamPanel: document.querySelector(".stream-panel"),
  streamStats: document.querySelector("#streamStats"),
  streamConsole: document.querySelector("#streamConsole"),
  studioBoard: document.querySelector("#studioBoard"),
  studioAgents: document.querySelector("#studioAgents"),
  studioHeadline: document.querySelector("#studioHeadline"),
  studioSubline: document.querySelector("#studioSubline"),
  studioMeter: document.querySelector("#studioMeter"),
  studioFeed: document.querySelector("#studioFeed"),
  runtimeTabs: [...document.querySelectorAll("[data-runtime]")]
};

function normalizeDeckIcons() {
  const iconByAction = {
    status: "\u25cf",
    continue: "\u25b6",
    events: "\u25ce",
    approve: "\u2713",
    reject: "\u00d7",
    "new-task": "\u26a1",
    metrics: "\u2197",
    send: "\u25ce",
    sessions: "\u221e"
  };

  for (const controls of Object.values(deckLayouts)) {
    for (const control of controls) {
      if (control.kind.includes("knob") && control.action !== "toggle-runtime") continue;
      control.icon = iconByAction[control.action] ?? control.icon;
    }
  }
}

function detectTheme() {
  return "violet";
}

function isVioletTheme() {
  return state.theme === "violet";
}

function applyTheme() {
  state.theme = "violet";
  document.documentElement.dataset.theme = state.theme;
  document.body.dataset.theme = state.theme;
  const themeColor = document.querySelector("#themeColor");
  const manifest = document.querySelector("#manifestLink");
  const favicon = document.querySelector("#faviconLink");
  const appleIcon = document.querySelector("#appleIconLink");

  themeColor?.setAttribute("content", "#0b0415");
  manifest?.setAttribute("href", "/manifest-violet.webmanifest");
  favicon?.setAttribute("href", "/assets/pwa-violet-v2-icon-192.png");
  appleIcon?.setAttribute("href", "/assets/pwa-violet-v2-icon-180.png");
}

function mountPremiumViolet() {
  document.querySelector(".shell")?.setAttribute("hidden", "true");
  document.querySelector("#premiumShell")?.removeAttribute("hidden");
  document.body.classList.add("premium-violet-active");

  const query = (selector) => document.querySelector(selector);
  const queryAll = (selector) => [...document.querySelectorAll(selector)];
  el.systemLed = query("#premiumSystemLed");
  el.microStage = query("#premiumShell");
  el.agentKeys = query("#premiumAgentKeys");
  el.hardwareDeck = query("#premiumHardwareDeck");
  el.microDevice = query("#premiumMicroDevice");
  el.tiltToggle = query("#premiumTiltToggle");
  el.runtimeStrip = query("#premiumRuntimeStrip");
  el.liveLog = query("#premiumLiveLog");
  el.streamPanel = query("[data-stream-panel]");
  el.streamStats = query("#premiumStreamStats");
  el.streamConsole = query("#premiumStreamConsole");
  el.agentsList = query("#premiumAgentsList");
  el.tasksList = query("#premiumTasksList");
  el.sessionsList = query("#premiumSessionsList");
  el.approvalsList = query("#premiumApprovalsList");
  el.eventTimeline = query("#premiumEventTimeline");
  el.studioBoard = query("#premiumStudioBoard");
  el.studioAgents = query("#premiumStudioAgents");
  el.studioHeadline = query("#premiumStudioHeadline");
  el.studioSubline = query("#premiumStudioSubline");
  el.studioMeter = query("#premiumStudioMeter");
  el.studioFeed = query("#premiumStudioFeed");
  el.promptOverlay = query("#premiumPromptOverlay");
  el.promptInput = query("#premiumPromptInput");
  el.promptStrip = query(".premium-prompt-strip");
  el.promptPreview = null;
  el.promptRun = query("#premiumPromptRun");
  el.promptRuntimeTabs = query("#premiumPromptRuntimeTabs");
  el.promptTrigger = null;
  el.runtimeTabs = queryAll("#premiumAgentKeys [data-runtime]");
}

boot();

async function boot() {
  if (isVioletTheme()) mountPremiumViolet();
  applyTheme();
  document.body.classList.toggle("stage-mode", state.stageMode);
  renderHardwareDeck();
  renderStudioBoard();
  hydrateFromCache();
  bindControls();
  bindPrompt();
  initTilt();
  registerServiceWorker();
  if (isVioletTheme()) {
    markAppReady(650);
    ensureControlSession().then(async () => {
      connectEvents();
      startLiveRefresh();
      await refreshAll();
    }).catch((error) => {
      addLocalEvent(state.activeRuntime, "runtime.error", error.message || "Refresh failed.");
      setLed("error", "ERR");
    });
    return;
  }

  try {
    await ensureControlSession();
    connectEvents();
    startLiveRefresh();
    await refreshAll();
  } finally {
    markAppReady();
  }
}

function renderHardwareDeck() {
  el.microDevice.dataset.active = state.activeRuntime;
  el.microDevice.dataset.theme = state.theme;
  if (!isVioletTheme()) el.hardwareDeck.classList.toggle("violet-deck-grid", false);
  el.runtimeTabs.forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.runtime === state.activeRuntime);
    tab.setAttribute("aria-selected", tab.dataset.runtime === state.activeRuntime ? "true" : "false");
    const signal = agentSignal(tab.dataset.runtime);
    tab.dataset.status = signal.status;
    tab.dataset.stateLabel = signal.label;
  });

  if (isVioletTheme()) {
    renderPremiumHardwareDeck();
    renderPremiumAgentConsole();
    renderPromptRuntimeTabs();
    return;
  }

  el.hardwareDeck.innerHTML = deckLayouts[state.activeRuntime].map((control, index) => `
    <button class="${control.kind}" data-action="${control.action}" data-tone="${toneFor(control)}" data-control-label="${escapeHtml(displayLabelFor(control))}" data-mock-slot="${escapeHtml(mockSlotFor(index))}" data-turn="${escapeHtml(String(knobTurnFor(control)))}" style="${escapeHtml(knobStyleFor(control))}" aria-label="${labelFor(control)}" title="${labelFor(control)}">
      <span class="icon">${escapeHtml(displayIconFor(control))}</span>
      <span class="label">${escapeHtml(displayLabelFor(control))}</span>
    </button>
  `).join("");
  renderAgentKeys();
  renderPromptRuntimeTabs();
}

function premiumDeckControls(source) {
  const codex = source === "codex";
  return [
    {
      slot: "mode",
      action: "status",
      icon: "",
      label: "MODE",
      readout: codex ? "CLI" : "HERMES",
      tone: "violet",
      knob: true
    },
    { slot: "status", action: "status", icon: "\u25ce", label: "STATUS", tone: "green" },
    { slot: "new", action: codex ? "new-task" : "models", icon: "\u26a1", label: "NEW", tone: "violet" },
    {
      slot: "rate",
      action: "reasoning",
      icon: "",
      label: "RATE",
      hint: state.reasoningLevel.toUpperCase(),
      readout: state.reasoningLevel.toUpperCase(),
      tone: reasoningTone(state.reasoningLevel),
      knob: true
    },
    { slot: "run", action: codex ? "continue" : "agents", icon: "\u25b7", label: "RUN", tone: "violet" },
    { slot: "log", action: codex ? "events" : "sessions", icon: "\u25c9", label: "LOG", tone: "violet" },
    { slot: "allow", action: "approve", icon: "\u2713", label: "ALLOW", tone: "green" },
    { slot: "deny", action: "reject", icon: "\u00d7", label: "DENY", tone: "red" },
    { slot: "task", action: codex ? "new-task" : "kanban", icon: "\u26a1", label: "TASK", tone: "orange" },
    { slot: "ok", action: "approve", icon: "\u2713", label: "OK", tone: "green" },
    { slot: "no", action: "reject", icon: "\u00d7", label: "NO", tone: "red" },
    { slot: "open", action: codex ? "sessions" : "metrics", icon: "↗", label: "SESS", tone: "violet" },
    { slot: "prompt", action: "send", icon: "\u2299", label: "PROMPT", hint: "TAP TO TYPE", tone: "violet", wide: true },
    { slot: "stop", action: "stop", icon: "", label: "STOP", tone: "red", stop: true },
    { slot: "flow", action: codex ? "continue" : "sessions", icon: "\u25b7", label: "FLOW", tone: "violet" }
  ];
}

function renderPremiumHardwareDeck() {
  const controls = premiumDeckControls(state.activeRuntime);
  el.microDevice.dataset.active = state.activeRuntime;
  el.hardwareDeck.innerHTML = controls.map((control) => {
    const classes = ["premium-key", "premium-exact-key"];
    if (control.knob) classes.push("premium-knob", "knob");
    if (control.stop) classes.push("premium-stop");
    if (control.wide) classes.push("premium-wide");
    if (["status", "new", "run", "log", "allow", "deny"].includes(control.slot)) classes.push("premium-dark-key");
    if (["task", "ok", "no", "open", "prompt", "flow"].includes(control.slot)) classes.push("premium-light-key");
    const asset = premiumKeyAsset(control);
    const rotor = control.knob
      ? `<span class="premium-exact-knob-rotor" aria-hidden="true"><i></i></span><span class="premium-knob-readout">${escapeHtml(control.readout || "")}</span>`
      : "";
    const body = `<img class="premium-key-surface premium-exact-surface" src="${asset}" alt="" draggable="false" aria-hidden="true" />${rotor}`;
    return `<button class="${classes.join(" ")}" data-action="${control.action}" data-tone="${control.tone}" data-control-label="${control.label}" data-mock-slot="${control.slot}" data-turn="${knobTurnFor(control)}" style="${escapeHtml(knobStyleFor(control))}" aria-label="${escapeHtml(labelFor(control))}" title="${escapeHtml(labelFor(control))}">
      ${body}
    </button>`;
  }).join("");
  el.promptTrigger = el.hardwareDeck.querySelector('[data-mock-slot="prompt"]');
}

function premiumKeyAsset(control) {
  return `/assets/premium-exact-${control.slot}.png?v=54`;
}

function premiumControlIcon(slot) {
  const icons = {
    status: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none"/><circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none"/></svg>',
    new: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.1 2.8 5.7 13h5.5l-.8 8.2L18.3 11h-5.5l.3-8.2Z" fill="none"/></svg>',
    run: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7V5Z" fill="none"/></svg>',
    log: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="none"/><circle cx="12" cy="12" r="8" fill="none"/><path d="M12 1.7v3M12 19.3v3M1.7 12h3M19.3 12h3" fill="none"/></svg>',
    allow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 12.7 4.5 4.4L19.5 6.8" fill="none"/></svg>',
    deny: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none"/></svg>',
    task: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.1 2.8 5.7 13h5.5l-.8 8.2L18.3 11h-5.5l.3-8.2Z" fill="none"/></svg>',
    ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 12.7 4.5 4.4L19.5 6.8" fill="none"/></svg>',
    no: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none"/></svg>',
    open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" fill="none"/></svg>',
    prompt: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none"/><circle cx="12" cy="12" r="8" fill="none"/></svg>',
    flow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7V5Z" fill="none"/></svg>'
  };
  return icons[slot] || '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6" fill="none"/></svg>';
}

function renderPremiumAgentConsole() {
  const lanes = ["codex", "hermes"].map((source) => {
    const signal = agentSignal(source);
    const active = source === state.activeRuntime;
    return `<button class="premium-agent-lane ${active ? "is-active" : ""} ${signal.unread ? "has-unread" : ""}" data-agent-key="${source}" data-runtime="${source}" data-status="${escapeHtml(signal.status)}" aria-label="${source} ${active ? "selected " : ""}${escapeHtml(signal.label)}" aria-pressed="${active ? "true" : "false"}">
      <span class="premium-agent-logo">${agentLogo(source)}</span>
      <span class="premium-agent-name"><b>${source.toUpperCase()}</b><small>${source === "codex" ? surfaceModeLabel() : "REMOTE"}</small></span>
      ${active ? '<span class="premium-agent-selected">ACTIVE</span>' : ""}
      <span class="premium-agent-rule" aria-hidden="true"></span>
      <span class="premium-agent-state"><b>${escapeHtml(signal.label)}</b><small>${escapeHtml(signal.detail)}</small></span>
      <span class="premium-agent-meter" aria-hidden="true"><i></i></span>
      <span class="premium-agent-dots" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
    </button>`;
  });
  el.agentKeys.innerHTML = `<div class="premium-agent-shell">${lanes[0]}<span class="premium-agent-switch"><button type="button" data-action="toggle-runtime" aria-label="Switch runtime">&#8249;<b>&#8250;</b></button></span>${lanes[1]}</div>`;
  el.runtimeTabs = [...el.agentKeys.querySelectorAll("[data-runtime]")];
}

function renderVioletHardwareDeck() {
  const controls = violetDeckControlsApproved(state.activeRuntime);
  el.hardwareDeck.innerHTML = controls.map((control) => `
    <button class="${escapeHtml(control.className)}" data-action="${escapeHtml(control.action)}" data-tone="${escapeHtml(control.tone)}" data-control-label="${escapeHtml(control.label)}" data-mock-slot="${escapeHtml(control.slot)}" data-turn="${escapeHtml(String(knobTurnFor(control)))}" style="${escapeHtml(knobStyleFor(control))}" aria-label="${escapeHtml(control.label)}" title="${escapeHtml(control.label)}">
      ${control.knob ? `<span class="vknob-face" aria-hidden="true"><i></i></span>` : `<span class="vkey-icon">${escapeHtml(control.icon || "")}</span>`}
      <span class="vkey-label">${escapeHtml(control.label)}</span>
      ${control.hint ? `<span class="vkey-hint">${escapeHtml(control.hint)}</span>` : ""}
    </button>
  `).join("");
}

function violetDeckControls(source) {
  const codex = source === "codex";
  return [
    { slot: "mode", className: "vkey vknob knob", action: "toggle-runtime", label: "MODE", tone: "green", knob: true },
    { slot: "status", className: "vkey vkey-dark", action: "status", icon: "◎", label: "STATUS", tone: "cyan" },
    { slot: "new", className: "vkey vkey-dark", action: codex ? "new-task" : "models", icon: "⚡", label: "NEW", tone: "orange" },
    { slot: "rate", className: "vkey vknob vknob-small knob dark", action: "reasoning", label: "RATE", tone: reasoningTone(state.reasoningLevel), knob: true },
    { slot: "run", className: "vkey vkey-dark", action: codex ? "continue" : "agents", icon: "▷", label: "RUN", tone: "blue" },
    { slot: "log", className: "vkey vkey-dark", action: codex ? "events" : "sessions", icon: "◉", label: "LOG", tone: "cyan" },
    { slot: "allow", className: "vkey vkey-dark", action: codex ? "approve" : "kanban", icon: "✓", label: "ALLOW", tone: "green" },
    { slot: "deny", className: "vkey vkey-dark", action: codex ? "reject" : "events", icon: "×", label: "DENY", tone: "red" },
    { slot: "task", className: "vkey vkey-light", action: codex ? "new-task" : "status", icon: "⚡", label: "TASK", tone: "orange" },
    { slot: "ok", className: "vkey vkey-light", action: "approve", icon: "✓", label: "OK", tone: "green" },
    { slot: "no", className: "vkey vkey-light", action: "reject", icon: "×", label: "NO", tone: "red" },
    { slot: "open", className: "vkey vkey-light", action: codex ? "sessions" : "metrics", icon: "↗", label: "SESS", tone: "cyan" },
    { slot: "prompt", className: "vkey vkey-light vkey-wide", action: "send", icon: "⊙", label: "PROMPT", hint: "TAP TO TYPE", tone: "green" },
    { slot: "stop", className: "vstop socket emergency", action: "stop", label: "STOP", tone: "red" },
    { slot: "flow", className: "vkey vkey-light", action: codex ? "continue" : "sessions", icon: "▷", label: "FLOW", tone: "blue" }
  ];
}

function violetDeckControlsApproved(source) {
  const codex = source === "codex";
  if (!codex) {
    return [
      { slot: "mode", className: "vkey vknob knob", action: "toggle-runtime", label: "MODE", tone: "green", knob: true },
      { slot: "status", className: "vkey vkey-dark", action: "status", icon: "\u25ce", label: "HEALTH", tone: "green" },
      { slot: "new", className: "vkey vkey-dark", action: "models", icon: "M", label: "MODELS", tone: "violet" },
      { slot: "rate", className: "vkey vknob knob dark", action: "reasoning", label: "RATE", tone: reasoningTone(state.reasoningLevel), knob: true },
      { slot: "run", className: "vkey vkey-dark", action: "agents", icon: "A", label: "AGENTS", tone: "violet" },
      { slot: "log", className: "vkey vkey-dark", action: "sessions", icon: "C", label: "CHAT", tone: "cyan" },
      { slot: "allow", className: "vkey vkey-dark", action: "kanban", icon: "K", label: "TASKS", tone: "green" },
      { slot: "deny", className: "vkey vkey-dark", action: "events", icon: "E", label: "EVENTS", tone: "red" },
      { slot: "task", className: "vkey vkey-light", action: "status", icon: "\u26a1", label: "PING", tone: "orange" },
      { slot: "ok", className: "vkey vkey-light", action: "approve", icon: "\u2713", label: "ALLOW", tone: "green" },
      { slot: "no", className: "vkey vkey-light", action: "reject", icon: "\u00d7", label: "DENY", tone: "red" },
      { slot: "open", className: "vkey vkey-light", action: "metrics", icon: "\u2197", label: "METR", tone: "violet" },
      { slot: "prompt", className: "vkey vkey-light vkey-wide", action: "send", icon: "\u2299", label: "PROMPT", hint: "TAP TO TYPE", tone: "violet" },
      { slot: "stop", className: "vstop socket emergency", action: "stop", label: "STOP", tone: "red" },
      { slot: "flow", className: "vkey vkey-light", action: "sessions", icon: "\u25b7", label: "SESS", tone: "violet" },
      { slot: "logs", className: "vnav", action: "events", label: "LOGS", tone: "violet" },
      { slot: "sessions", className: "vnav", action: "sessions", label: "SESSIONS", tone: "violet" },
      { slot: "tasks", className: "vnav", action: "kanban", label: "TASKS", tone: "violet" }
    ];
  }
  return [
    { slot: "mode", className: "vkey vknob knob", action: "toggle-runtime", label: "MODE", tone: "green", knob: true },
    { slot: "status", className: "vkey vkey-dark", action: "status", icon: "\u25ce", label: "STATUS", tone: "cyan" },
    { slot: "new", className: "vkey vkey-dark", action: codex ? "new-task" : "models", icon: "\u26a1", label: "NEW", tone: "violet" },
    { slot: "rate", className: "vkey vknob knob dark", action: "reasoning", label: "RATE", tone: reasoningTone(state.reasoningLevel), knob: true },
    { slot: "run", className: "vkey vkey-dark", action: codex ? "continue" : "agents", icon: "\u25b7", label: "RUN", tone: "violet" },
    { slot: "log", className: "vkey vkey-dark", action: codex ? "events" : "sessions", icon: "\u25c9", label: "LOG", tone: "cyan" },
    { slot: "allow", className: "vkey vkey-dark", action: codex ? "approve" : "kanban", icon: "\u2713", label: "ALLOW", tone: "green" },
    { slot: "deny", className: "vkey vkey-dark", action: codex ? "reject" : "events", icon: "\u00d7", label: "DENY", tone: "red" },
    { slot: "task", className: "vkey vkey-light", action: codex ? "new-task" : "status", icon: "\u26a1", label: "TASK", tone: "orange" },
    { slot: "ok", className: "vkey vkey-light", action: "approve", icon: "\u2713", label: "OK", tone: "green" },
    { slot: "no", className: "vkey vkey-light", action: "reject", icon: "\u00d7", label: "NO", tone: "red" },
    { slot: "open", className: "vkey vkey-light", action: codex ? "sessions" : "metrics", icon: "↗", label: "SESS", tone: "violet" },
    { slot: "prompt", className: "vkey vkey-light vkey-wide", action: "send", icon: "\u2299", label: "PROMPT", hint: "TAP TO TYPE", tone: "violet" },
    { slot: "stop", className: "vstop socket emergency", action: "stop", label: "STOP", tone: "red" },
    { slot: "flow", className: "vkey vkey-light", action: codex ? "continue" : "sessions", icon: "\u25b7", label: "FLOW", tone: "violet" },
    { slot: "logs", className: "vnav", action: "events", label: "LOGS", tone: "violet" },
    { slot: "sessions", className: "vnav", action: "sessions", label: "SESSIONS", tone: "violet" },
    { slot: "tasks", className: "vnav", action: codex ? "new-task" : "kanban", label: "TASKS", tone: "violet" }
  ];
}

function closestFromEvent(event, selector) {
  const target = event.target;
  if (target instanceof Element) return target.closest(selector);
  return target?.parentElement?.closest(selector) || null;
}

function bindControls() {
  document.addEventListener("pointerdown", (event) => {
    const button = closestFromEvent(event, "button");
    if (button) button.classList.add("is-pressing");
  });

  for (const eventName of ["pointerup", "pointercancel", "pointerleave"]) {
    document.addEventListener(eventName, (event) => {
      const button = closestFromEvent(event, "button");
      if (button) button.classList.remove("is-pressing");
    });
  }

  document.addEventListener("click", async (event) => {
    const runtimeTab = closestFromEvent(event, "[data-runtime]");
    const agentKey = closestFromEvent(event, "[data-agent-key]");
    const actionButton = closestFromEvent(event, "[data-action]");
    const refreshButton = closestFromEvent(event, "[data-refresh]");
    const sectionFilter = closestFromEvent(event, "[data-section-filter]");
    const promptOpen = closestFromEvent(event, "[data-prompt-open]");
    const promptClose = closestFromEvent(event, "[data-prompt-close]");
    const promptRuntime = closestFromEvent(event, "[data-prompt-runtime]");
    const promptSubmit = closestFromEvent(event, "[data-prompt-submit]");
    const promptMic = closestFromEvent(event, "[data-prompt-mic]");
    const tiltToggle = closestFromEvent(event, "#tiltToggle, #premiumTiltToggle");
    const streamPanel = closestFromEvent(event, "[data-stream-panel]");
    const inspectorButton = closestFromEvent(event, "[data-inspector]");
    const inspectorClose = closestFromEvent(event, "[data-inspector-close]");
    const conversationRow = closestFromEvent(event, "[data-conversation-id]");

    if (conversationRow) {
      pulseHaptic(8);
      state.selectedConversationId = conversationRow.dataset.conversationId;
      state.codexSessionMode = "current";
      localStorage.setItem("hermes_control_codex_session_mode_v1", "current");
      renderSessions();
      addLocalEvent(
        conversationRow.dataset.source || state.activeRuntime,
        "conversation.selected",
        conversationRow.dataset.conversationTitle || "Session selected."
      );
      return;
    }

    if (inspectorClose) {
      closePremiumInspector();
      return;
    }

    if (inspectorButton) {
      await openPremiumInspector(inspectorButton.dataset.inspector, inspectorButton);
      return;
    }

    if (tiltToggle) {
      await toggleTilt();
      return;
    }

    if (promptClose) {
      closePromptSheet();
      return;
    }

    if (promptOpen) {
      openPromptSheet();
      return;
    }

    if (promptRuntime) {
      pulseHaptic(8);
      flashButton(promptRuntime, "is-done");
      setActiveRuntime(promptRuntime.dataset.promptRuntime);
      return;
    }

    if (promptMic) {
      pulseHaptic(8);
      openPromptSheet({ focus: true });
      flashButton(promptMic, "is-done");
      addLocalEvent(state.activeRuntime, "ui.prompt.focused", "Keyboard dictation ready.");
      return;
    }

    if (promptSubmit) {
      await sendPrompt(promptSubmit);
      return;
    }

    if (agentKey) {
      pulseHaptic(10);
      flashButton(agentKey, "is-done");
      setActiveRuntime(agentKey.dataset.agentKey);
      clearRuntimeUnread(agentKey.dataset.agentKey);
      return;
    }

    if (runtimeTab) {
      pulseHaptic(9);
      flashButton(runtimeTab, "is-done");
      setActiveRuntime(runtimeTab.dataset.runtime);
      return;
    }

    if (sectionFilter) {
      pulseHaptic(7);
      flashButton(sectionFilter, "is-done");
      setSectionFilter(sectionFilter.dataset.sectionFilter, sectionFilter.dataset.source);
      refreshSection(sectionFilter.dataset.sectionFilter).catch((error) => {
        addLocalEvent(sectionFilter.dataset.source, "runtime.error", error.message);
      });
      return;
    }

    if (actionButton) {
      pulseHaptic(actionButton.dataset.action === "stop" ? 18 : 10);
      const action = actionButton.dataset.action;
      turnKnob(actionButton);
      if (action === "toggle-runtime") {
        flashButton(actionButton, "is-done");
        setActiveRuntime(state.activeRuntime === "codex" ? "hermes" : "codex");
        return;
      }
      if (action === "reasoning") {
        await cycleReasoning(actionButton);
        return;
      }
      if (action === "send") {
        flashButton(actionButton, "is-done");
        openPromptSheet();
        return;
      }
      await runAction(action, actionButton);
      return;
    }

    if (refreshButton) {
      await withBusy(refreshButton, async () => {
        try {
          await refreshSection(refreshButton.dataset.refresh, { force: true });
          return true;
        } catch (error) {
          addLocalEvent(state.activeRuntime, "runtime.error", error.message);
          return false;
        }
      });
      return;
    }

    if (streamPanel) {
      streamPanel.classList.toggle("is-expanded");
    }
  });
}

function bindPrompt() {
  if (!el.promptInput || !el.promptStrip) return;
  el.promptInput.addEventListener("input", () => {
    el.promptStrip.classList.toggle("has-input", Boolean(el.promptInput.value.trim()));
    updatePromptPreview();
    resizePromptInput();
  });
  el.promptInput.addEventListener("focus", resizePromptInput);
  el.promptInput.addEventListener("blur", resizePromptInput);
  el.promptInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    sendPrompt(el.promptRun || el.promptTrigger);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.promptOpen) closePromptSheet();
  });
  updatePromptPreview();
  resizePromptInput();
}

function initTilt() {
  if (!el.tiltToggle || !el.microDevice) return;
  el.tiltToggle.hidden = !isVioletTheme();
}

async function toggleTilt() {
  if (!el.tiltToggle || !el.microDevice) return;
  pulseHaptic(12);

  if (state.tilt.enabled) {
    stopTilt();
    addLocalEvent(state.activeRuntime, "ui.tilt.disabled", "Tilt off.");
    return;
  }

  await startTilt();
  addLocalEvent(state.activeRuntime, "ui.tilt.enabled", state.tilt.device ? "Device tilt enabled." : "Touch tilt enabled.");
}

async function startTilt() {
  state.tilt.enabled = true;
  state.tilt.device = false;
  document.body.classList.add("tilt-on");
  el.tiltToggle?.setAttribute("aria-pressed", "true");
  const label = el.tiltToggle?.querySelector("b");
  if (label) label.textContent = "TILT ON";

  if (canUseDeviceTilt()) {
    try {
      const permissionRequest = DeviceOrientationEvent.requestPermission();
      const permission = await Promise.race([
        permissionRequest,
        new Promise((resolve) => window.setTimeout(() => resolve("pending"), 700))
      ]);
      if (permission === "granted") {
        state.tilt.device = true;
        window.addEventListener("deviceorientation", handleDeviceTilt, true);
      } else if (permission === "pending") {
        permissionRequest.then((result) => {
          if (result !== "granted" || !state.tilt.enabled) return;
          state.tilt.device = true;
          window.addEventListener("deviceorientation", handleDeviceTilt, true);
        }).catch(() => {
          state.tilt.device = false;
        });
      }
    } catch {
      state.tilt.device = false;
    }
  } else if ("DeviceOrientationEvent" in window && window.isSecureContext) {
    state.tilt.device = true;
    window.addEventListener("deviceorientation", handleDeviceTilt, true);
  }

  window.addEventListener("pointermove", handlePointerTilt, { passive: true });
  window.addEventListener("pointerleave", resetTilt, { passive: true });
  setTilt(-2.4, 3.6);
}

function stopTilt() {
  state.tilt.enabled = false;
  state.tilt.device = false;
  document.body.classList.remove("tilt-on");
  el.tiltToggle?.setAttribute("aria-pressed", "false");
  const label = el.tiltToggle?.querySelector("b");
  if (label) label.textContent = "WŁĄCZ TILT";
  window.removeEventListener("deviceorientation", handleDeviceTilt, true);
  window.removeEventListener("pointermove", handlePointerTilt);
  window.removeEventListener("pointerleave", resetTilt);
  resetTilt();
}

function canUseDeviceTilt() {
  return "DeviceOrientationEvent" in window
    && typeof DeviceOrientationEvent.requestPermission === "function"
    && window.isSecureContext;
}

function handleDeviceTilt(event) {
  if (!state.tilt.enabled || !state.tilt.device) return;
  const beta = Number.isFinite(event.beta) ? event.beta : 45;
  const gamma = Number.isFinite(event.gamma) ? event.gamma : 0;
  const x = clamp((beta - 48) / -4.2, -9, 9);
  const y = clamp(gamma / 4.5, -9, 9);
  setTilt(x, y);
}

function handlePointerTilt(event) {
  if (!state.tilt.enabled || state.tilt.device || !el.microDevice) return;
  const rect = el.microDevice.getBoundingClientRect();
  const inside = event.clientX >= rect.left
    && event.clientX <= rect.right
    && event.clientY >= rect.top
    && event.clientY <= rect.bottom;
  if (!inside) return;
  const px = (event.clientX - rect.left) / Math.max(rect.width, 1);
  const py = (event.clientY - rect.top) / Math.max(rect.height, 1);
  setTilt((0.5 - py) * 12, (px - 0.5) * 14);
}

function setTilt(x, y) {
  state.tilt.x = x;
  state.tilt.y = y;
  if (state.tilt.raf) return;
  state.tilt.raf = window.requestAnimationFrame(() => {
    state.tilt.raf = 0;
    const glareX = clamp(50 + state.tilt.y * 3, 18, 82);
    const glareY = clamp(24 - state.tilt.x * 2.4, 10, 72);
    el.microDevice?.style.setProperty("--tilt-x", `${state.tilt.x.toFixed(2)}deg`);
    el.microDevice?.style.setProperty("--tilt-y", `${state.tilt.y.toFixed(2)}deg`);
    el.microDevice?.style.setProperty("--glare-x", `${glareX.toFixed(1)}%`);
    el.microDevice?.style.setProperty("--glare-y", `${glareY.toFixed(1)}%`);
  });
}

function resetTilt() {
  if (state.tilt.enabled && !state.tilt.device) {
    setTilt(-2.4, 3.6);
    return;
  }
  setTilt(0, 0);
}

function openPromptSheet(options = {}) {
  if (!el.promptOverlay) return;
  state.promptOpen = true;
  el.promptOverlay.hidden = false;
  document.body.classList.add("prompt-open");
  renderPromptRuntimeTabs();
  if (options.focus !== false) focusPromptInput();
  window.requestAnimationFrame(() => {
    el.promptOverlay.classList.add("is-open");
    resizePromptInput();
    if (options.focus !== false) focusPromptInput();
  });
}

function closePromptSheet() {
  if (!el.promptOverlay) return;
  state.promptOpen = false;
  el.promptOverlay.classList.remove("is-open");
  document.body.classList.remove("prompt-open");
  window.setTimeout(() => {
    if (!state.promptOpen) el.promptOverlay.hidden = true;
  }, 180);
}

function renderPromptRuntimeTabs() {
  if (!el.promptRuntimeTabs) return;
  const premium = isVioletTheme();
  el.promptRuntimeTabs.innerHTML = ["codex", "hermes"].map((source) => {
    const signal = agentSignal(source);
    return `
      <button class="${premium ? "premium-prompt-runtime-tab" : "prompt-runtime-tab"} ${source === state.activeRuntime ? "is-active" : ""}" type="button" data-prompt-runtime="${source}" data-status="${escapeHtml(signal.status)}">
        <span class="${premium ? "premium-prompt-logo" : "mini-logo"}">${agentLogo(source)}</span>
        <span>
          <b>${escapeHtml(source)}</b>
          <small>${escapeHtml(signal.label)} / ${escapeHtml(signal.detail)}</small>
        </span>
      </button>
    `;
  }).join("");
}

function focusPromptInput() {
  if (!el.promptInput) return;
  try {
    el.promptInput.focus({ preventScroll: true });
  } catch {
    el.promptInput.focus();
  }
}

function updatePromptPreview(sentText = "") {
  if (!el.promptPreview) return;
  const draft = el.promptInput?.value.trim() || "";
  const text = draft || sentText || state.lastPrompt;
  el.promptPreview.textContent = text ? compactLogText(text) : "tap to type";
  el.promptTrigger?.classList.toggle("has-input", Boolean(draft));
  el.promptTrigger?.classList.toggle("has-last", Boolean(!draft && state.lastPrompt));
}

function setActiveRuntime(source) {
  state.activeRuntime = source;
  for (const section of Object.keys(state.sectionFilters)) {
    state.sectionFilters[section] = source;
  }
  renderHardwareDeck();
  renderSectionTabs();
  renderAgents();
  renderTasks();
  renderSessions();
  renderApprovals();
  renderPromptRuntimeTabs();
  clearRuntimeUnread(source);
  addLocalEvent(source, "ui.runtime.selected", `Deck switched to ${source}.`);
}

function setSectionFilter(section, source) {
  state.sectionFilters[section] = source;
  renderSectionTabs();
  if (section === "agents") renderAgents();
  if (section === "tasks") renderTasks();
  if (section === "sessions") renderSessions();
  if (section === "approvals") renderApprovals();
}

async function refreshAll(options = {}) {
  setLed("boot", "SYNC");
  const results = await Promise.allSettled([
    refreshRuntimes(options),
    refreshSection("agents", options),
    refreshSection("tasks", options),
    refreshSection("sessions", options),
    refreshSection("approvals", options),
    refreshSection("events", options)
  ]);
  const failed = results.filter((result) => result.status === "rejected");
  for (const result of failed) {
    addLocalEvent(state.activeRuntime, "runtime.error", result.reason?.message || "Refresh failed.");
  }
  setLed(failed.length ? "error" : "live", failed.length ? "ERR" : "LIVE");
  renderStudioBoard();
}

function startLiveRefresh() {
  if (state.liveRefreshTimer) window.clearInterval(state.liveRefreshTimer);
  state.liveRefreshTimer = window.setInterval(() => {
    if (document.hidden) return;
    refreshRuntimes({ force: true }).catch((error) => {
      addLocalEvent("codex", "runtime.error", error.message);
    });
  }, 5000);
}

async function refreshRuntimes(options = {}) {
  if (state.runtimeRefreshPromise) return state.runtimeRefreshPromise;

  state.runtimeRefreshPromise = (async () => {
    const data = await getJson(refreshUrl("/api/runtimes", options));
    state.runtimes = data.items || [];
    persistCache("runtimes", state.runtimes);
    renderRuntimes(data.errors || []);
    return data;
  })();

  try {
    return await state.runtimeRefreshPromise;
  } finally {
    state.runtimeRefreshPromise = undefined;
  }
}

async function refreshSection(section, options = {}) {
  if (section === "agents") {
    const data = await getJson(refreshUrl("/api/agents", options));
    state.agents = data.items || [];
    persistCache("agents", state.agents);
    pushErrors(data.errors);
    renderAgents();
  }

  if (section === "tasks") {
    const data = await getJson(refreshUrl("/api/tasks", options));
    state.tasks = data.items || [];
    persistCache("tasks", state.tasks);
    pushErrors(data.errors);
    syncStreamsFromTasks(state.tasks);
    renderTasks();
  }

  if (section === "sessions") {
    const data = await getJson(refreshUrl("/api/conversations", options));
    state.conversations = data.items || [];
    persistCache("sessions", state.conversations);
    pushErrors(data.errors);
    renderSessions();
  }

  if (section === "approvals") {
    const data = await getJson(refreshUrl("/api/approvals", options));
    state.approvals = data.items || [];
    persistCache("approvals", state.approvals);
    pushErrors(data.errors);
    renderApprovals();
  }

  if (section === "events") {
    const data = await getJson(refreshUrl("/api/events?limit=80", options));
    state.events = mergeEvents(data.items || [], state.events);
    rebuildStreamsFromHistory(state.events);
    renderEvents();
  }
}

async function runAction(action, button) {
  const source = state.activeRuntime;
  const prompt = el.promptInput.value.trim();
  if (["new-task", "continue"].includes(action) && source === "codex" && !prompt) {
    flashButton(button, "is-done");
    openPromptSheet({ focus: true });
    addLocalEvent(source, "ui.prompt.focused", action === "continue" ? "Continue Codex task ready." : "New Codex task ready.");
    return false;
  }
  const approval = selectedPendingApprovalFor(source);
  if (["approve", "reject"].includes(action) && !approval) {
    addLocalEvent(source, "runtime.error", "No unambiguous pending approval for the selected task.");
    flashButton(button, "is-failed");
    return false;
  }
  const payload = {
    prompt,
    title: prompt ? prompt.slice(0, 80) : undefined,
    reasoning: state.reasoningLevel,
    surface: source === "codex" ? "cli" : undefined,
    conversationId: selectedConversationIdFor(source),
    resumeLast: shouldResumeCurrent(source, action),
    approvalId: approval?.id,
    approvalScope: approvalScopeForButton(action, button),
    approvalDecision: approvalDecisionForButton(action, button)
  };

  setRuntimeSignal(source, signalStatusForAction(action), signalLabelForAction(action), signalDetailForAction(action), { unread: false });
  setRuntimeActivity(source, "working");
  await withBusy(button, async () => {
    try {
        const data = await postJson("/api/actions", { source, action, payload });
        addLocalEvent(source, "task.progress", `${action} OK`, data.result);
        if (action === "new-task" && source === "codex") {
          state.selectedConversationId = undefined;
          state.codexSessionMode = "current";
          try {
            window.localStorage.setItem("hermes_control_codex_session_mode_v1", "current");
          } catch {
            // Optional local preference.
          }
        }
        await afterAction(action);
        if (keepsRuntimeWorking(action, source, payload) && !data.result?.metadata?.noop) {
          setRuntimeSignal(source, "thinking", signalLabelForAction(action), signalDetailForAction(action), { unread: false });
          setRuntimeActivity(source, "working");
        } else {
          setRuntimeSignal(source, "done", signalLabelForAction(action), `${action} OK`, { unread: false });
          setRuntimeActivity(source, "connected");
          scheduleRuntimeReady(source);
        }
        setLed("live", "LIVE");
        return true;
    } catch (error) {
      addLocalEvent(source, "runtime.error", error.message);
      setRuntimeActivity(source, "error");
      setLed("error", "ERR");
      return false;
    }
  });
}

function selectedPendingApprovalFor(source) {
  const pending = state.approvals.filter((approval) => approval.source === source && approval.status === "pending");
  if (pending.length <= 1) return pending[0];
  const conversationId = selectedConversationIdFor(source);
  if (!conversationId) return undefined;
  const matching = pending.filter((approval) => approval.conversationId === conversationId);
  return matching.length === 1 ? matching[0] : undefined;
}

function approvalScopeForButton(action, button) {
  if (action !== "approve") return undefined;
  return button?.dataset?.controlLabel === "OK" ? "session" : "once";
}

function approvalDecisionForButton(action, button) {
  if (action === "approve") return button?.dataset?.controlLabel === "OK" ? "acceptForSession" : "accept";
  if (action === "reject") return button?.dataset?.controlLabel === "NO" ? "cancel" : "decline";
  return undefined;
}

async function sendPrompt(button) {
  const source = state.activeRuntime;
  const content = el.promptInput.value.trim();
  if (!content) {
    openPromptSheet();
    addLocalEvent(source, "runtime.error", "Prompt is empty.");
    flashButton(button, "is-failed");
    return false;
  }

  setRuntimeSignal(source, "thinking", "RUN", "prompt queued", { unread: false });
  setRuntimeActivity(source, "working");
  const pendingKey = primePendingStream(source, content);
  el.promptStrip.classList.add("is-sending");
  let sent = false;
  try {
    await withBusy(button, async () => {
      try {
        const data = await postJson("/api/messages", {
          source,
          content,
          reasoning: state.reasoningLevel,
          surface: source === "codex" ? "cli" : undefined,
          conversationId: selectedConversationIdFor(source),
          resumeLast: shouldResumeCurrent(source, "send")
        });
        rekeyPendingStream(pendingKey, data.message);
        addLocalEvent(source, "conversation.message.created", "Prompt sent.", data.message);
        state.lastPrompt = content;
        el.promptInput.value = "";
        el.promptStrip.classList.remove("has-input");
        updatePromptPreview(content);
        resizePromptInput();
        closePromptSheet();
        afterAction("send").catch((error) => {
          addLocalEvent(source, "runtime.error", error.message);
        });
        setRuntimeActivity(source, "working");
        sent = true;
        return true;
      } catch (error) {
        markPendingStreamFailed(pendingKey, error.message);
        addLocalEvent(source, "runtime.error", error.message);
        setRuntimeActivity(source, "error");
        setLed("error", "ERR");
        return false;
      }
    });
  } finally {
    el.promptStrip.classList.remove("is-sending");
  }
  return sent;
}

function signalStatusForAction(action) {
  if (action === "stop") return "error";
  if (action === "approve" || action === "reject") return "thinking";
  if (["status", "models", "agents", "sessions", "events", "metrics", "kanban"].includes(action)) return "thinking";
  return "thinking";
}

function signalLabelForAction(action) {
  const labels = {
    approve: "ALLOW",
    reject: "DENY",
    stop: "STOP",
    status: "PING",
    models: "SYNC",
    agents: "SYNC",
    sessions: "SYNC",
    events: "LOG",
    metrics: "METR",
    kanban: "TASKS",
    continue: "RUN",
    "new-task": "TASK"
  };
  return labels[action] || "RUN";
}

function signalDetailForAction(action) {
  const details = {
    approve: "approval sent",
    reject: "approval denied",
    stop: "stop requested",
    status: "checking health",
    models: "loading models",
    agents: "loading agents",
    sessions: "loading sessions",
    events: "pulling events",
    metrics: "sampling metrics",
    kanban: "loading tasks",
    continue: "running task",
    "new-task": "starting task"
  };
  return details[action] || "working";
}

function keepsRuntimeWorking(action, source, payload = {}) {
  if (action === "new-task" && source === "hermes" && !payload.prompt) return false;
  return ["continue", "new-task", "approve"].includes(action);
}

function shouldResumeCurrent(source, action) {
  if (source !== "codex") return false;
  if (action === "new-task") return false;
  if (action === "continue") return true;
  return state.codexSessionMode === "current";
}

function selectedConversationIdFor(source) {
  const selected = state.conversations.find((conversation) =>
    conversation.id === state.selectedConversationId && conversation.source === source
  );
  if (selected) return selected.id;
  const active = state.conversations.find((conversation) =>
    conversation.source === source && conversation.metadata?.selected
  );
  return active?.id;
}

async function afterAction(action) {
  const sections = new Set();

  if (["new-task", "continue", "stop", "kanban", "send"].includes(action)) {
    focusSection("tasks", state.activeRuntime);
    sections.add("tasks");
  }
  if (["agents", "models"].includes(action)) {
    focusSection("agents", state.activeRuntime);
    sections.add("agents");
  }
  if (["sessions", "send", "new-task"].includes(action)) {
    focusSection("sessions", state.activeRuntime);
    sections.add("sessions");
  }
  if (["approve", "reject", "events", "send"].includes(action)) {
    focusSection("approvals", state.activeRuntime);
    sections.add("approvals");
  }

  await Promise.all([
    ...[...sections].map((section) => refreshSection(section)),
    refreshSection("events"),
    refreshRuntimes()
  ]);
}

function connectEvents() {
  const stream = new EventSource("/events");
  stream.onmessage = handleStreamEvent;
  stream.onopen = () => {
    setLed("live", "LIVE");
    refreshAll({ force: true }).catch((error) => {
      addLocalEvent(state.activeRuntime, "runtime.error", error.message);
    });
  };
  [
    "runtime.connected",
    "runtime.error",
    "ui.action.completed",
    "ui.data.refreshed",
    "ui.runtime.selected",
    "conversation.created",
    "conversation.message.created",
    "task.created",
    "task.progress",
    "task.completed",
    "task.failed",
    "agent.discovered",
    "approval.requested",
    "approval.resolved",
    "worker.updated",
    "system.metric.sampled"
  ].forEach((type) => stream.addEventListener(type, handleStreamEvent));
  stream.onerror = () => setLed("error", "LINK");
  window.addEventListener("online", refreshAfterResume);
  window.addEventListener("pageshow", refreshAfterResume);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshAfterResume();
  });
}

function refreshAfterResume() {
  window.clearTimeout(state.resumeRefreshTimer);
  state.resumeRefreshTimer = window.setTimeout(() => {
    refreshAll({ force: true }).catch((error) => {
      addLocalEvent(state.activeRuntime, "runtime.error", error.message || "Resume refresh failed.");
      setLed("error", "LINK");
    });
  }, 120);
}

function handleStreamEvent(message) {
  if (!message.data) return;
  const event = JSON.parse(message.data);
  ingestStreamEvent(event);
  applyRuntimeActivityFromEvent(event);
  applyTaskStateFromEvent(event);
  state.events.unshift(event);
  state.events = state.events.slice(0, 80);
  scheduleEventRender({ immediate: !isHighFrequencyStreamEvent(event) });
  renderStudioBoard();
}

function renderRuntimes(errors) {
  if (errors) state.runtimeErrors = errors;
  const runtimeErrors = errors || state.runtimeErrors;

  for (const error of runtimeErrors) {
    if (isDeadlineError(error)) {
      setRuntimeSignal(error.source, "input", "SLOW", error.message, { render: false, unread: false });
      setRuntimeActivity(error.source, "working", { render: false });
    } else {
      setRuntimeActivity(error.source, "error", { render: false });
    }
  }

  const rows = state.runtimes.map((runtime) => {
    const runtimeReady = isRuntimeReady(runtime);
    const hasCurrentError = runtimeErrors.some((error) => error.source === runtime.source);
    if (runtimeReady && !hasCurrentError) {
      const savedSignal = state.runtimeSignals[runtime.source];
      if (state.runtimeActivity[runtime.source] === "error") {
        state.runtimeActivity[runtime.source] = "connected";
      }
      if (savedSignal?.status === "error") {
        setRuntimeSignal(
          runtime.source,
          "ready",
          "READY",
          runtime.details?.mode || runtime.details?.status || "connected",
          { render: false }
        );
      }
    }
    const savedStatus = state.runtimeActivity[runtime.source] || "idle";
    const status = runtimeReady
      ? (savedStatus === "idle" ? "connected" : savedStatus)
      : "error";
    setRuntimeActivity(runtime.source, status, { render: false });
    return `
      <div class="signal ${runtimeReady ? "ok" : "bad"}" data-status="${escapeHtml(status)}">
        <i class="status-dot ${escapeHtml(status)}"></i>
        <b>${escapeHtml(runtime.source)}</b>
        <span>${escapeHtml(runtime.status)} / ${escapeHtml(runtime.details?.mode || runtime.details?.status || "runtime")}</span>
      </div>
    `;
  });

  const errorRows = runtimeErrors.map((error) => {
    const slow = isDeadlineError(error);
    return `
    <div class="signal ${slow ? "warn" : "bad"}" data-status="${slow ? "input" : "error"}">
      <i class="status-dot ${slow ? "input" : "error"}"></i>
      <b>${escapeHtml(error.source)}</b>
      <span>${escapeHtml(slow ? error.message.replace(/\s+deadline\s+\d+ms/i, " slow probe") : error.message)}</span>
    </div>
  `;
  });

  el.runtimeStrip.innerHTML = rows.concat(errorRows).join("") || `<div class="empty">No runtimes</div>`;
  renderAgentKeys();
  renderStudioBoard();
}

function renderAgentKeys() {
  if (!el.agentKeys) return;
  if (isVioletTheme()) {
    renderPremiumAgentConsole();
    return;
  }

  const sources = ["codex", "hermes"];
  el.agentKeys.innerHTML = sources.map((source) => {
    const signal = agentSignal(source);
    return `
      <button class="agent-key ${source === state.activeRuntime ? "is-active" : ""} ${signal.unread ? "has-unread" : ""}" data-agent-key="${source}" data-status="${escapeHtml(signal.status)}" data-signal-label="${escapeHtml(signal.label)}" aria-label="${escapeHtml(source)} ${escapeHtml(signal.label)}">
        <span class="agent-orb">
          ${agentLogo(source)}
          <i></i>
        </span>
        <span class="agent-readout">
          <b>${escapeHtml(source)}</b>
          <small>${escapeHtml(signal.detail)}</small>
        </span>
        <span class="agent-level">
          <b>${escapeHtml(signal.label)}</b>
          <small>${escapeHtml(state.reasoningLevel.toUpperCase())}</small>
        </span>
      </button>
    `;
  }).join("");
}

function renderVioletAgentConsole() {
  const sources = ["codex", "hermes"];
  const lanes = sources.map((source) => {
    const signal = agentSignal(source);
    const active = source === state.activeRuntime;
    return `
      <button class="agent-console-lane ${active ? "is-active" : ""} ${signal.unread ? "has-unread" : ""}" data-agent-key="${source}" data-status="${escapeHtml(signal.status)}" aria-label="${escapeHtml(source)} ${escapeHtml(signal.label)}">
        <span class="agent-console-logo">${agentLogo(source)}</span>
        <span class="agent-console-title">
          <b>${escapeHtml(source)}</b>
          <small>${escapeHtml(source === "codex" ? "local" : "remote")}</small>
        </span>
        <span class="agent-console-divider" aria-hidden="true"></span>
        <span class="agent-console-badge">${escapeHtml(signal.label)}</span>
        <span class="agent-console-state">${escapeHtml(signal.detail)}</span>
        <span class="agent-console-meter" aria-hidden="true"><i></i></span>
      </button>
    `;
  });

  el.agentKeys.innerHTML = `
    <div class="agent-console-shell" data-active="${escapeHtml(state.activeRuntime)}">
      ${lanes[0]}
      <span class="agent-console-center">
        <button class="agent-console-switch" type="button" data-action="toggle-runtime" aria-label="Switch runtime">
          <span aria-hidden="true">&lsaquo;</span>
          <span aria-hidden="true">&rsaquo;</span>
        </button>
      </span>
      ${lanes[1]}
    </div>
  `;
}

function agentSignal(source) {
  const saved = state.runtimeSignals[source] || {};
  const runtime = state.runtimes.find((item) => item.source === source);
  const runtimeReady = isRuntimeReady(runtime);
  if (runtime && !runtimeReady) {
    const detail = "offline";
    return { status: "error", label: "ERROR", detail, unread: true };
  }
  if (runtimeReady && (!saved.status || saved.status === "idle")) {
    return {
      status: "ready",
      label: "READY",
      detail: compactLogText(runtime.details?.mode || runtime.details?.status || "connected"),
      unread: Boolean(saved.unread)
    };
  }
  return {
    status: saved.status || (runtimeReady ? "ready" : "idle"),
    label: saved.label || (runtimeReady ? "READY" : "IDLE"),
    detail: compactLogText(saved.detail || runtime?.details?.mode || runtime?.details?.status || "waiting"),
    unread: Boolean(saved.unread)
  };
}

function isRuntimeReady(runtime) {
  if (!runtime?.ok) return false;
  return true;
}

function agentLogo(source) {
  if (source === "hermes") {
    return `<img src="/assets/hermes-logo.png" alt="" />`;
  }
  return `
    <img class="codex-original-mini" src="/assets/codex-logo.svg" alt="" onerror="this.hidden = true" />
    <span>C</span>
  `;
}

function renderAgents() {
  const source = state.sectionFilters.agents;
  const agents = state.agents.filter((agent) => agent.source === source);
  el.agentsList.innerHTML = agents.map((agent) => `
    <div class="row">
      <strong>${escapeHtml(agent.displayName || agent.id)}</strong>
      <span>${escapeHtml(agent.source)} / ${escapeHtml(agent.status || "unknown")} / ${escapeHtml(agent.model || "model")}</span>
    </div>
  `).join("") || `<div class="empty">No ${source} agents</div>`;
}

function renderTasks() {
  const source = state.sectionFilters.tasks;
  const tasks = state.tasks.filter((task) => task.source === source);
  el.tasksList.innerHTML = tasks.map((task) => `
    <div class="row task-row" data-task-id="${escapeHtml(task.id)}">
      <strong><small>TASK</small> ${escapeHtml(task.title || task.id)}</strong>
      <span>${escapeHtml(taskStatusLabel(task))} / ${escapeHtml(taskSurfaceLabel(task))} / ${escapeHtml(taskProgressLabel(task))}</span>
      <small>${escapeHtml(taskActivityLabel(task))}${task.conversationId ? ` / session ${escapeHtml(shortId(task.conversationId))}` : ""}</small>
    </div>
  `).join("") || `<div class="empty">No ${source} tasks</div>`;
}

function renderSessions() {
  const source = state.sectionFilters.sessions;
  const conversations = state.conversations.filter((conversation) => conversation.source === source);
  const activeId = selectedConversationIdFor(source);
  if (!state.selectedConversationId && activeId) state.selectedConversationId = activeId;
  el.sessionsList.innerHTML = conversations.map((conversation) => `
    <button class="row session-row${conversation.id === activeId ? " is-selected" : ""}" type="button"
      data-conversation-id="${escapeHtml(conversation.id)}"
      data-conversation-title="${escapeHtml(conversation.title || conversation.id)}"
      data-source="${escapeHtml(conversation.source)}"
      aria-pressed="${conversation.id === activeId ? "true" : "false"}">
      <strong><small>SESSION</small> ${escapeHtml(conversation.title || conversation.id)}</strong>
      <span>${conversation.id === activeId ? "SELECTED" : "AVAILABLE"} / ${escapeHtml(conversationSurfaceLabel(conversation))}</span>
      <small>${escapeHtml(conversation.updatedAt || "")} / conversation history</small>
    </button>
  `).join("") || `<div class="empty">No ${source} sessions</div>`;
}

function applyTaskStateFromEvent(event) {
  const payload = event.payload;
  const eventTask = payload?.task || (
    payload && typeof payload === "object" && (
      payload.id || payload.title || payload.status || payload.progress !== undefined
    )
      ? payload
      : undefined
  );
  const taskId = event.taskId || eventTask?.id;
  if (!taskId || !event.source) return;

  let task = state.tasks.find((item) => item.id === taskId);
  if (!task) {
    if (!["task.created", "task.progress", "task.completed", "task.failed", "approval.requested"].includes(event.type)) return;
    task = {
      id: taskId,
      source: event.source,
      agentId: event.agentId,
      title: eventTask?.title || event.payload?.message || taskId,
      status: "running",
      progress: undefined,
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
      metadata: {}
    };
    state.tasks.unshift(task);
  }

  if (eventTask && typeof eventTask === "object") {
    for (const key of ["title", "status", "progress", "createdAt", "updatedAt", "conversationId", "metadata"]) {
      if (eventTask[key] !== undefined) task[key] = eventTask[key];
    }
  }
  if (event.conversationId) task.conversationId = event.conversationId;
  if (event.timestamp) task.updatedAt = event.timestamp;
  const activity = activityTextFromEvent(event);
  if (activity) task.metadata = { ...(task.metadata || {}), lastActivity: activity, lastEventType: event.type };
  const eventStatus = String(eventTask?.status || event.payload?.status || "").toLowerCase();
  const eventIsTerminal = ["idle", "completed", "done", "failed", "cancelled", "canceled"].includes(eventStatus);
  if (["task.created", "task.progress", "worker.updated", "conversation.message.created"].includes(event.type) && !eventIsTerminal) {
    task.status = task.status === "waiting_approval" ? task.status : "running";
  }
  if (event.type === "approval.requested") task.status = "waiting_approval";
  if (event.type === "task.completed") task.status = event.payload?.status === "cancelled" ? "cancelled" : "completed";
  if (event.type === "task.failed" || event.type === "runtime.error") task.status = "failed";
  if (Number.isFinite(event.payload?.progress)) task.progress = event.payload.progress;
  state.tasks = state.tasks.slice(0, 50);
  persistCache("tasks", state.tasks);
  syncStreamsFromTasks(state.tasks);
  renderTasks();
}

function taskStatusLabel(task) {
  return String(task.status || "unknown").replaceAll("_", " ").toUpperCase();
}

function taskSurfaceLabel(task) {
  return String(task.metadata?.surface || task.metadata?.mode || task.agentId || "runtime").toUpperCase();
}

function taskProgressLabel(task) {
  return Number.isFinite(task.progress) ? `${Math.round(task.progress)}%` : "LIVE";
}

function taskActivityLabel(task) {
  return compactLogText(task.metadata?.lastActivity || task.metadata?.phase || task.metadata?.message || taskStatusLabel(task));
}

function conversationSurfaceLabel(conversation) {
  return String(conversation.metadata?.surface || conversation.metadata?.mode || "runtime").toUpperCase();
}

function shortId(value) {
  const text = String(value || "");
  return text.length > 18 ? `${text.slice(0, 8)}...${text.slice(-6)}` : text;
}

function renderApprovals() {
  const source = state.sectionFilters.approvals;
  const approvals = state.approvals.filter((approval) => approval.source === source);
  el.approvalsList.innerHTML = approvals.map((approval) => `
    <div class="row">
      <strong>${escapeHtml(approval.title || approval.id)}</strong>
      <span>${escapeHtml(approval.source)} / ${escapeHtml(approval.status || "pending")} / ${escapeHtml(approval.requestedAt || "")}</span>
    </div>
  `).join("") || `<div class="empty">No ${source} approvals</div>`;
}

function renderSectionTabs() {
  for (const section of ["agents", "tasks", "sessions", "approvals"]) {
    document.querySelectorAll(`[data-section-filter="${section}"]`).forEach((button) => {
      button.classList.toggle("is-active", button.dataset.source === state.sectionFilters[section]);
    });
  }
}

function focusSection(section, source) {
  if (!state.sectionFilters[section]) return;
  state.sectionFilters[section] = source;
  renderSectionTabs();
  flashReadout(section);
  if (section === "agents") renderAgents();
  if (section === "tasks") renderTasks();
  if (section === "sessions") renderSessions();
  if (section === "approvals") renderApprovals();
}

function flashReadout(section) {
  const readout = document.querySelector(`[data-readout="${section}"]`);
  if (!readout) return;
  readout.classList.remove("is-focused");
  void readout.offsetWidth;
  readout.classList.add("is-focused");
  window.setTimeout(() => readout.classList.remove("is-focused"), 900);
}

function renderEvents() {
  const events = timelineEvents();
  el.eventTimeline.innerHTML = events.map((event) => `
    <div class="event">
      <strong>${escapeHtml(event.type)}</strong>
      <span>${escapeHtml(event.source)} / ${formatTime(event.timestamp)}</span>
      <code>${escapeHtml(eventSummary(event))}</code>
    </div>
  `).join("") || `<div class="empty">No events</div>`;
  renderLiveLog();
  renderStudioBoard();
}

function scheduleEventRender(options = {}) {
  if (options.immediate) {
    if (state.eventRenderTimer) {
      window.clearTimeout(state.eventRenderTimer);
      state.eventRenderTimer = undefined;
    }
    state.lastEventRenderAt = Date.now();
    renderEvents();
    return;
  }

  const now = Date.now();
  const waitMs = Math.max(0, 140 - (now - state.lastEventRenderAt));
  if (state.eventRenderTimer) return;

  state.eventRenderTimer = window.setTimeout(() => {
    state.eventRenderTimer = undefined;
    state.lastEventRenderAt = Date.now();
    renderEvents();
  }, waitMs);
}

function addLocalEvent(source, type, message, payload = {}) {
  const event = {
    id: `ui:${Date.now()}:${Math.random().toString(16).slice(2)}`,
    source,
    type,
    timestamp: new Date().toISOString(),
    payload: { message, payload }
  };
  applyRuntimeActivityFromEvent(event);
  state.events.unshift(event);
  state.events = state.events.slice(0, 80);
  renderEvents();
}

function pushErrors(errors = []) {
  for (const error of errors || []) {
    const key = `${error.source}:${compactLogText(error.message)}`;
    const now = Date.now();
    if (state.recentErrors[key] && now - state.recentErrors[key] < 4500) continue;
    state.recentErrors[key] = now;
    addLocalEvent(error.source, "runtime.error", error.message);
  }
}

function setRuntimeTabState(source, status) {
  const tab = el.runtimeTabs.find((item) => item.dataset.runtime === source);
  if (!tab) return;
  const signal = agentSignal(source);
  const visualStatus = status === "working"
    ? (signal.status || "thinking")
    : status === "connected"
      ? (signal.status === "done" ? "done" : "ready")
      : status;
  tab.dataset.status = visualStatus;
  tab.dataset.stateLabel = signal.label || status.toUpperCase();
  tab.classList.toggle("is-error", visualStatus === "error");
  tab.classList.toggle("is-working", status === "working" || visualStatus === "thinking" || visualStatus === "input");
}

function setRuntimeActivity(source, status, options = {}) {
  if (!source) return;
  if (state.activityTimers[source]) {
    window.clearTimeout(state.activityTimers[source]);
    state.activityTimers[source] = undefined;
  }
  state.runtimeActivity[source] = status;
  setRuntimeTabState(source, status);
  if (!state.runtimeSignals[source]) {
    setRuntimeSignal(source, status === "error" ? "error" : "ready", status.toUpperCase(), status, { render: false });
  }
  if (options.render !== false && state.runtimes.length) {
    renderRuntimes();
  }
  if (options.render !== false) renderAgentKeys();
}

function scheduleRuntimeReady(source, delayMs = 1400) {
  if (state.activityTimers[source]) {
    window.clearTimeout(state.activityTimers[source]);
  }
  state.activityTimers[source] = window.setTimeout(() => {
    state.activityTimers[source] = undefined;
    const runtime = state.runtimes.find((item) => item.source === source);
    if (!runtime?.ok || state.runtimeActivity[source] === "working") return;
    setRuntimeSignal(source, "ready", "READY", "connected", { unread: false, render: false });
    setRuntimeActivity(source, "connected");
  }, delayMs);
}

function setRuntimeSignal(source, status, label, detail, options = {}) {
  if (!source) return;
  const previous = state.runtimeSignals[source] || {};
  state.runtimeSignals[source] = {
    status,
    label,
    detail: compactLogText(detail),
    unread: options.keepUnread ? Boolean(previous.unread) : Boolean(options.unread),
    since: Date.now()
  };
  setRuntimeTabState(source, status);
  if (options.render !== false) renderAgentKeys();
}

function clearRuntimeUnread(source) {
  if (!state.runtimeSignals[source]) return;
  state.runtimeSignals[source].unread = false;
  renderAgentKeys();
}

function signalLabelForEvent(event) {
  if (event.type === "task.created") return "RUNNING";
  if (event.type === "worker.updated") return "WORKING";
  if (event.type === "conversation.message.created") {
    if (event.payload?.role === "user") return "SENT";
    if (event.payload?.role === "assistant") return "WRITING";
    return "THINKING";
  }
  if (event.type === "task.progress") return "RUNNING";
  return "THINKING";
}

function setLed(stateName, label) {
  el.systemLed.dataset.state = stateName;
  el.systemLed.querySelector("strong").textContent = label;
}

async function withBusy(button, work) {
  button.classList.remove("is-done", "is-failed");
  button.classList.add("is-working");
  button.disabled = true;
  try {
    const ok = await work();
    flashButton(button, ok === false ? "is-failed" : "is-done");
  } finally {
    button.disabled = false;
    button.classList.remove("is-working", "is-pressing");
  }
}

async function getJson(url) {
  const response = await fetch(url, { credentials: "same-origin" });
  return parseJsonResponse(response);
}

function refreshUrl(url, options = {}) {
  if (!options.force) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}refresh=1`;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body)
  });
  return parseJsonResponse(response);
}

async function ensureControlSession() {
  let token = "";
  try {
    token = window.localStorage.getItem("hermes_control_auth_token_v1") || "";
  } catch {
    // Storage is optional; a one-time prompt still works.
  }
  while (true) {
    if (!token) token = await requestControlToken();
    if (!token) throw new Error("Control token required.");

    const response = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ token })
    });
    if (response.ok) {
      try { window.localStorage.setItem("hermes_control_auth_token_v1", token); } catch { /* optional */ }
      hideAuthOverlay();
      return;
    }

    try { window.localStorage.removeItem("hermes_control_auth_token_v1"); } catch { /* optional */ }
    token = await requestControlToken("Invalid Hermes Control token.");
  }
}

function requestControlToken(errorMessage = "") {
  if (!el.authOverlay || !el.authForm || !el.authTokenInput) {
    return Promise.resolve(typeof window.prompt === "function" ? window.prompt("Hermes Control token")?.trim() || "" : "");
  }

  el.authOverlay.hidden = false;
  el.authError.textContent = errorMessage;
  el.authError.hidden = !errorMessage;
  el.authTokenInput.value = "";

  return new Promise((resolve) => {
    const submit = (event) => {
      event.preventDefault();
      const nextToken = el.authTokenInput.value.trim();
      if (!nextToken) {
        el.authError.textContent = "Control token required.";
        el.authError.hidden = false;
        el.authTokenInput.focus();
        return;
      }
      el.authForm.removeEventListener("submit", submit);
      resolve(nextToken);
    };
    el.authForm.addEventListener("submit", submit);
    window.requestAnimationFrame(() => el.authTokenInput.focus());
  });
}

function hideAuthOverlay() {
  if (el.authOverlay) el.authOverlay.hidden = true;
}

async function parseJsonResponse(response) {
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

function labelFor(control) {
  if (control.action === "reasoning") return `${state.activeRuntime} reasoning ${state.reasoningLevel}`;
  return `${state.activeRuntime} ${control.label}`;
}

function toneFor(control) {
  if (control.action === "reasoning") return reasoningTone(state.reasoningLevel);
  if (control.action === "approve") return "green";
  if (control.action === "reject" || control.action === "stop") return "red";
  if (control.action === "continue") return "blue";
  if (control.action === "new-task" || control.action === "kanban") return "orange";
  if (control.action === "send") return "green";
  if (["events", "sessions", "agents", "models", "metrics"].includes(control.action)) return "cyan";
  return "green";
}

function displayLabelFor(control) {
  if (control.action === "reasoning") return isVioletTheme() ? "RATE" : state.reasoningLevel.toUpperCase();
  return control.label;
}

function mockSlotFor(index) {
  return [
    "mode",
    "status",
    "new",
    "rate",
    "run",
    "log",
    "allow",
    "deny",
    "task",
    "ok",
    "no",
    "open",
    "prompt",
    "stop",
    "flow"
  ][index] || String(index);
}

function displayIconFor(control) {
  if (control.action === "reasoning") return "R";
  return control.icon || "";
}

function knobKeyFor(action, source = state.activeRuntime) {
  return `${source}:${action}`;
}

function knobTurnFor(control) {
  if (!(control.knob || control.kind?.includes("knob"))) return 0;
  return state.knobTurns[knobKeyFor(control.action)] ?? -24;
}

function knobStyleFor(control) {
  if (!(control.knob || control.kind?.includes("knob"))) return "";
  return `--knob-turn: ${knobTurnFor(control)}deg`;
}

function reasoningTone(level) {
  if (level === "low") return "green";
  if (level === "med") return "cyan";
  if (level === "high") return "orange";
  return "red";
}

async function cycleReasoning(button) {
  const previousLevel = state.reasoningLevel;
  const index = reasoningLevels.indexOf(previousLevel);
  const fallbackLevel = reasoningLevels[(index + 1) % reasoningLevels.length];
  let nextLevel = fallbackLevel;

  state.reasoningLevel = nextLevel;
  try {
    window.localStorage.setItem("hermes_control_reasoning_v1", state.reasoningLevel);
  } catch {
    // Optional local preference.
  }
  flashButton(button, "is-done");
  refreshReasoningButton(button);
  renderAgentKeys();
  addLocalEvent(state.activeRuntime, "ui.reasoning.changed", `Reasoning ${state.reasoningLevel.toUpperCase()}.`);
  return true;
}

function normalizeUiReasoning(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "medium") return "med";
  return reasoningLevels.includes(normalized) ? normalized : undefined;
}

function refreshReasoningButton(button) {
  button.dataset.tone = reasoningTone(state.reasoningLevel);
  button.dataset.controlLabel = state.reasoningLevel.toUpperCase();
  button.setAttribute("aria-label", labelFor({ action: "reasoning", label: "REASONING" }));
  button.setAttribute("title", labelFor({ action: "reasoning", label: "REASONING" }));
  const label = button.querySelector(".label, .premium-label");
  if (label) label.textContent = state.reasoningLevel.toUpperCase();
  const readout = button.querySelector(".premium-knob-readout");
  if (readout) readout.textContent = state.reasoningLevel.toUpperCase();
}

function openPremiumInspector(section, button) {
  const panel = document.querySelector("#premiumInspector");
  if (!panel) return;
  const titles = { events: "Logs", sessions: "Sessions", tasks: "Tasks", agents: "Agents", approvals: "Approvals" };
  panel.hidden = false;
  panel.dataset.section = section;
  const title = document.querySelector("#premiumInspectorTitle");
  if (title) title.textContent = titles[section] || "Control data";
  panel.querySelectorAll("[data-readout]").forEach((readout) => {
    readout.hidden = readout.dataset.readout !== section;
  });
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  if (button?.dataset?.action) return runAction(button.dataset.action, button);
}

function closePremiumInspector() {
  const panel = document.querySelector("#premiumInspector");
  if (panel) panel.hidden = true;
}

function flashButton(button, className) {
  button.classList.remove("is-done", "is-failed");
  void button.offsetWidth;
  button.classList.add(className);
  window.setTimeout(() => button.classList.remove(className), 620);
}

function turnKnob(button) {
  if (!button.classList.contains("knob")) return;
  const key = knobKeyFor(button.dataset.action);
  const current = state.knobTurns[key] ?? Number(button.dataset.turn || -24);
  const next = (current + 58) % 360;
  state.knobTurns[key] = next;
  button.dataset.turn = String(next);
  button.style.setProperty("--knob-turn", `${next}deg`);
  button.classList.add("is-turning");
  window.setTimeout(() => button.classList.remove("is-turning"), 520);
}

function resizePromptInput() {
  if (!el.promptInput) return;
  const hasText = Boolean(el.promptInput.value.trim());
  const minHeight = hasText || document.activeElement === el.promptInput ? 46 : 38;
  const maxHeight = 78;
  el.promptInput.style.height = "auto";
  const nextHeight = Math.min(Math.max(el.promptInput.scrollHeight, minHeight), maxHeight);
  el.promptInput.style.height = `${nextHeight}px`;
  el.promptInput.style.overflowY = el.promptInput.scrollHeight > maxHeight ? "auto" : "hidden";
}

function pulseHaptic(ms) {
  try {
    if (navigator.vibrate) navigator.vibrate(ms);
  } catch {
    // Haptics are optional.
  }
}

function applyRuntimeActivityFromEvent(event) {
  if (!event?.source) return;
  if (event.type === "runtime.error" || event.type === "task.failed") {
    if (isDeadlineEvent(event)) {
      setRuntimeSignal(event.source, "input", "SLOW", eventSummary(event), { unread: false });
      setRuntimeActivity(event.source, "working");
      return;
    }
    setRuntimeSignal(event.source, "error", "ERROR", eventSummary(event), { unread: true });
    setRuntimeActivity(event.source, "error");
    return;
  }
  if (event.type === "approval.requested") {
    setRuntimeSignal(event.source, "input", "WAITING", "approval required - tap ALLOW or DENY", { unread: true });
    setRuntimeActivity(event.source, "working");
    return;
  }
  const eventStatus = String(event.payload?.task?.status || event.payload?.status || "").toLowerCase();
  if (eventStatus === "waiting_approval") {
    setRuntimeSignal(event.source, "input", "WAITING", "approval required - tap ALLOW or DENY", { unread: true });
    setRuntimeActivity(event.source, "working");
    return;
  }
  const eventIsTerminal = ["idle", "completed", "done", "failed", "cancelled", "canceled"].includes(eventStatus);
  if (event.type === "task.progress" && eventIsTerminal) {
    const failed = eventStatus === "failed";
    setRuntimeSignal(
      event.source,
      failed ? "error" : "done",
      failed ? "ERROR" : eventStatus === "idle" ? "READY" : "DONE",
      eventSummary(event),
      { unread: failed }
    );
    setRuntimeActivity(event.source, failed ? "error" : "connected");
    return;
  }
  if (["task.created", "task.progress", "worker.updated", "conversation.message.created"].includes(event.type) && !eventIsTerminal) {
    setRuntimeSignal(event.source, "thinking", signalLabelForEvent(event), logMessageFor(event), { unread: false });
    setRuntimeActivity(event.source, "working");
    return;
  }
  if (event.type === "task.completed") {
    if (event.payload?.status === "cancelled") {
      setRuntimeSignal(event.source, "input", "STOP", "task cancelled", { unread: false });
      setRuntimeActivity(event.source, "connected");
      scheduleRuntimeReady(event.source, 2200);
      return;
    }
    setRuntimeSignal(event.source, "done", "DONE", completedDetailForEvent(event), { unread: true });
    setRuntimeActivity(event.source, "connected");
    return;
  }
  if (["runtime.connected", "task.completed", "approval.resolved"].includes(event.type)) {
    setRuntimeSignal(event.source, "ready", "READY", event.type === "approval.resolved" ? "approval resolved" : "connected", { keepUnread: true });
    setRuntimeActivity(event.source, "connected");
  }
}

function isDeadlineError(error) {
  return /\bdeadline\b/i.test(error?.message || "");
}

function isDeadlineEvent(event) {
  return isDeadlineError({ message: eventSummary(event) });
}

function completedDetailForEvent(event) {
  const assistantText = assistantTextFromEvent(event);
  if (assistantText) return `assistant: ${assistantText}`;
  const message = event.payload?.message;
  if (typeof message === "string" && message.trim()) return message;
  return "task complete";
}

function ingestStreamEvent(event) {
  const key = streamKeyFor(event);
  if (!key) return;

  const stream = ensureStream(key, event);
  if (event.conversationId) stream.conversationId = event.conversationId;
  if (event.taskId) stream.taskId = event.taskId;
  if (event.payload?.streamId) stream.streamId = event.payload.streamId;
  if (event.payload?.reasoning) stream.reasoning = event.payload.reasoning;
  const eventAt = Date.parse(event.timestamp || "") || Date.now();
  stream.startedAt = Math.min(stream.startedAt || eventAt, eventAt);
  stream.lastAt = Math.max(stream.lastAt || eventAt, eventAt);
  stream.updatedAt = event.timestamp || new Date().toISOString();
  const nextStatus = statusForStreamEvent(event, stream.status);
  if (!["done", "error"].includes(stream.status) || ["done", "error"].includes(nextStatus)) {
    stream.status = nextStatus;
  }

  const userMessage = userMessageFromEvent(event);
  if (userMessage) stream.prompt = userMessage;

  const token = tokenTextFromEvent(event);
  if (token) {
    stream.text += token;
    stream.tokenEvents += 1;
    stream.outputTokens = Math.max(stream.outputTokens || 0, stream.tokenEvents);
  }

  const assistantText = assistantTextFromEvent(event);
  if (assistantText) {
    stream.text = assistantText;
  }

  const activity = activityTextFromEvent(event);
  if (activity) stream.activity = activity;
  if (!isHighFrequencyStreamEvent(event)) {
    const eventMessage = activity || logMessageFor(event);
    if (eventMessage) {
      const signature = `${event.type}:${eventMessage}`;
      if (!stream.activityEvents.some((item) => item.signature === signature)) {
        stream.activityEvents.unshift({
          signature,
          type: event.type,
          timestamp: event.timestamp || new Date().toISOString(),
          message: eventMessage,
          status: nextStatus
        });
        stream.activityEvents = stream.activityEvents.slice(0, 6);
      }
    }
  }

  const metrics = metricsFromEvent(event);
  if (metrics.tps !== undefined) stream.tps = metrics.tps;
  if (metrics.totalTokens !== undefined) stream.totalTokens = metrics.totalTokens;
  if (metrics.inputTokens !== undefined) {
    stream.inputTokens = metrics.inputTokens;
    stream.usageKnown = true;
  }
  if (metrics.outputTokens !== undefined) {
    stream.outputTokens = metrics.outputTokens;
    stream.usageKnown = true;
  }
  if (metrics.cacheHitPercent !== undefined) stream.cacheHitPercent = metrics.cacheHitPercent;
  if (metrics.durationSeconds !== undefined) stream.durationSeconds = metrics.durationSeconds;

  if (event.type === "runtime.error" || event.type === "task.failed") {
    stream.error = event.payload?.error || event.payload?.message || eventSummary(event);
  }

  state.streams = [stream, ...state.streams.filter((item) => item.key !== key)].slice(0, 6);
  queueStreamRender();
  revealStreamWhenUseful(stream, event);
}

function rebuildStreamsFromHistory(events) {
  const preserved = state.streams.filter((stream) => stream.key.startsWith("pending:") && stream.status === "working");
  state.streams = [];
  state.streamMap.clear();

  for (const event of [...events].reverse()) {
    ingestStreamEvent(event);
    applyRuntimeActivityFromEvent(event);
  }

  for (const stream of preserved) {
    if (!state.streamMap.has(stream.key)) {
      state.streamMap.set(stream.key, stream);
      state.streams.push(stream);
    }
  }

  state.streams = state.streams
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
    .slice(0, 6);
  queueStreamRender();
}

function syncStreamsFromTasks(tasks) {
  for (const source of ["codex", "hermes"]) {
    const sourceTasks = tasks
      .filter((task) => task?.source === source)
      .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
    const waitingTask = sourceTasks.find((task) => String(task.status || "").toLowerCase() === "waiting_approval");
    if (waitingTask) {
      setRuntimeSignal(source, "input", "WAITING", "approval required - tap ALLOW or DENY", {
        unread: true,
        render: false
      });
      setRuntimeActivity(source, "working");
      continue;
    }
    const runningTask = sourceTasks.find((task) =>
      ["running", "working", "thinking", "in_progress"].includes(String(task.status || "").toLowerCase())
    );
    if (runningTask && state.runtimeSignals[source]?.status !== "input") {
      setRuntimeSignal(
        source,
        "thinking",
        "RUNNING",
        runningTask.metadata?.lastActivity
          || runningTask.metadata?.phase
          || runningTask.metadata?.message
          || runningTask.title
          || "task in progress",
        { unread: false, render: false }
      );
      setRuntimeActivity(source, "working");
    }
  }
  renderAgentKeys();

  for (const task of tasks) {
    if (!task?.id || !task.source) continue;
    const status = String(task.status || "").toLowerCase();
    const active = ["running", "working", "thinking", "in_progress", "waiting_approval"].includes(status);
    const key = streamKeyFor({
      source: task.source,
      taskId: task.id,
      conversationId: task.conversationId
    });
    const existing = state.streamMap.get(key);
    if (!active && !existing) continue;

    const timestamp = task.updatedAt || task.createdAt || new Date().toISOString();
    const stream = ensureStream(key, {
      source: task.source,
      taskId: task.id,
      conversationId: task.conversationId,
      timestamp,
      payload: { message: task.metadata?.phase || task.metadata?.message || status }
    });
    stream.taskId = task.id;
    stream.conversationId ||= task.conversationId || "";
    stream.prompt ||= task.metadata?.prompt || task.title || "";
    const taskActivity = task.metadata?.lastActivity
      || task.metadata?.phase
      || task.metadata?.message
      || (status === "waiting_approval" ? "waiting for approval" : `working on: ${task.title || "active task"}`);
    stream.activity = taskActivity;
    stream.status = active ? (status === "waiting_approval" ? "waiting" : "working") : statusForTaskStream(status);
    stream.updatedAt = timestamp;
    stream.lastAt = Date.parse(timestamp) || stream.lastAt || Date.now();
    if (!stream.activityEvents?.length || stream.activityEvents[0]?.message !== taskActivity) {
      stream.activityEvents = [{
        signature: `task:${task.id}:${taskActivity}`,
        type: task.metadata?.lastEventType || "task.progress",
        timestamp,
        message: taskActivity,
        status: stream.status
      }, ...(stream.activityEvents || [])].slice(0, 6);
    }
    state.streams = [stream, ...state.streams.filter((item) => item.key !== stream.key)].slice(0, 6);
  }
  queueStreamRender();
}

function statusForTaskStream(status) {
  if (["completed", "complete", "done", "success"].includes(status)) return "done";
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  if (["failed", "error"].includes(status)) return "error";
  return "working";
}

function primePendingStream(source, prompt) {
  const key = `pending:${source}:${Date.now()}`;
  const stream = ensureStream(key, {
    source,
    timestamp: new Date().toISOString(),
    payload: {}
  });
  stream.prompt = prompt;
  stream.reasoning = state.reasoningLevel;
  stream.status = "working";
  stream.startedAt = Date.now();
  stream.lastAt = Date.now();
  state.streams = [stream, ...state.streams.filter((item) => item.key !== key)].slice(0, 6);
  queueStreamRender();
  return key;
}

function rekeyPendingStream(pendingKey, message) {
  const stream = state.streamMap.get(pendingKey);
  if (!stream) return;
  const nextKey = streamKeyFromMessage(message, stream.source);
  if (!nextKey || nextKey === pendingKey) return;

  const existing = state.streamMap.get(nextKey);
  if (existing && existing !== stream) {
    existing.prompt ||= stream.prompt;
    existing.reasoning ||= stream.reasoning;
    existing.startedAt = Math.min(existing.startedAt || Date.now(), stream.startedAt || Date.now());
    existing.lastAt = Math.max(existing.lastAt || 0, stream.lastAt || 0);
    existing.didReveal = existing.didReveal || stream.didReveal;
    state.streamMap.delete(pendingKey);
    state.streams = [
      existing,
      ...state.streams.filter((item) => item.key !== pendingKey && item.key !== nextKey)
    ].slice(0, 6);
    queueStreamRender();
    return;
  }

  state.streamMap.delete(pendingKey);
  stream.key = nextKey;
  stream.conversationId = message?.conversationId || stream.conversationId;
  stream.taskId = message?.metadata?.taskId || stream.taskId;
  stream.streamId = message?.metadata?.streamId || stream.streamId;
  state.streamMap.set(nextKey, stream);
}

function markPendingStreamFailed(pendingKey, message) {
  const stream = state.streamMap.get(pendingKey);
  if (!stream) return;
  stream.status = "error";
  stream.error = message;
  stream.lastAt = Date.now();
  queueStreamRender();
}

function ensureStream(key, event) {
  const existing = state.streamMap.get(key);
  if (existing) return existing;
  const eventAt = Date.parse(event.timestamp || "") || Date.now();

  const stream = {
    key,
    source: event.source || "system",
    status: "working",
    conversationId: event.conversationId || "",
    taskId: event.taskId || "",
    streamId: event.payload?.streamId || "",
    prompt: "",
    text: "",
    tokenEvents: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: undefined,
    tps: 0,
    cacheHitPercent: undefined,
    reasoning: "",
    activity: "",
    activityEvents: [],
    usageKnown: false,
    error: "",
    didReveal: false,
    startedAt: eventAt,
    lastAt: eventAt,
    updatedAt: event.timestamp || new Date().toISOString()
  };

  state.streamMap.set(key, stream);
  return stream;
}

function streamKeyFor(event) {
  if (!event?.source) return "";
  const streamId = event.payload?.streamId;
  const conversationId = event.conversationId;
  const taskId = event.taskId;
  const identity = taskId || (conversationId && streamId ? `${conversationId}:${streamId}` : conversationId || streamId);
  return identity ? `${event.source}:${identity}` : "";
}

function streamKeyFromMessage(message, source) {
  if (!message) return "";
  const streamId = message.metadata?.streamId;
  const taskId = message.metadata?.taskId;
  const conversationId = message.conversationId;
  const identity = taskId || (conversationId && streamId ? `${conversationId}:${streamId}` : conversationId || streamId);
  return identity ? `${source || message.source || "system"}:${identity}` : "";
}

function mergeEvents(snapshot, live) {
  const merged = new Map();
  for (const event of [...snapshot, ...live]) {
    const key = event.id || `${event.source}:${event.type}:${event.timestamp}:${event.taskId || ""}`;
    const existing = merged.get(key);
    if (!existing || Date.parse(event.timestamp || "") >= Date.parse(existing.timestamp || "")) {
      merged.set(key, event);
    }
  }
  return [...merged.values()]
    .sort((a, b) => (Date.parse(b.timestamp || "") || 0) - (Date.parse(a.timestamp || "") || 0))
    .slice(0, 80);
}

function statusForStreamEvent(event, fallback) {
  if (event.type === "task.completed") return event.payload?.status === "cancelled" ? "cancelled" : "done";
  if (event.type === "task.failed" || event.type === "runtime.error") return "error";
  const payloadStatus = String(event.payload?.status || event.payload?.task?.status || "").toLowerCase();
  if (event.type === "approval.requested" || payloadStatus === "waiting_approval") return "waiting";
  if (["completed", "complete", "done", "success", "idle"].includes(payloadStatus)) return "done";
  if (["cancelled", "canceled"].includes(payloadStatus)) return "cancelled";
  if (["failed", "error"].includes(payloadStatus)) return "error";
  if (["task.created", "task.progress", "worker.updated", "conversation.message.created"].includes(event.type)) {
    return "working";
  }
  return fallback || "working";
}

function metricsFromEvent(event) {
  const data = event.payload?.data || {};
  const cliEvent = event.payload?.cliEvent || {};
  const usage = data.usage
    || event.payload?.usage
    || cliEvent.usage
    || cliEvent.result?.usage
    || cliEvent.item?.usage
    || {};
  return {
    tps: numberOrUndefined(data.tps ?? usage.tps ?? usage.duration_tps ?? cliEvent.tps),
    totalTokens: numberOrUndefined(data.totalTokens ?? usage.total_tokens ?? usage.totalTokens ?? event.payload?.tokens),
    inputTokens: numberOrUndefined(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens),
    outputTokens: numberOrUndefined(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens),
    cacheHitPercent: numberOrUndefined(usage.cache_hit_percent ?? usage.turn_cache_hit_percent),
    durationSeconds: numberOrUndefined(usage.duration_seconds ?? data.duration_seconds)
  };
}

function queueStreamRender() {
  if (state.streamRenderQueued) return;
  state.streamRenderQueued = true;
  window.requestAnimationFrame(() => {
    state.streamRenderQueued = false;
    renderStreams();
  });
}

function renderStreams() {
  if (!el.streamConsole || !el.streamStats) return;
  const active = state.streams[0];

  if (!active) {
    el.streamStats.innerHTML = `<span class="stream-pill idle">STANDBY</span><span>no active run</span>`;
    el.streamConsole.innerHTML = `
      <div class="stream-empty">
        <b>STANDBY</b>
        <span>No active run</span>
      </div>
    `;
    return;
  }

  el.streamStats.innerHTML = `
    <span class="stream-pill ${escapeHtml(active.status)}">${escapeHtml(streamStatusLabel(active))}</span>
    ${streamMetricLabels(active).map((label) => `<span>${escapeHtml(label)}</span>`).join("")}
    <span>${escapeHtml(formatElapsed(active))}</span>
  `;

  el.streamConsole.innerHTML = state.streams.map((stream, index) => {
    const approvalRequired = stream.status === "waiting";
    const activityEvents = approvalRequired
      ? [{
          timestamp: stream.updatedAt || new Date().toISOString(),
          message: "APPROVAL REQUIRED - TAP ALLOW OR DENY",
          status: "waiting"
        }, ...(stream.activityEvents || []).filter((item) =>
          !/approval required|waiting for approval/i.test(String(item.message || ""))
        )].slice(0, 4)
      : (stream.activityEvents || []).slice(0, 4);

    return `
    <article class="stream-card ${escapeHtml(stream.status)}">
      <div class="stream-card-head">
        <strong>${escapeHtml(stream.source.toUpperCase())} ${escapeHtml(streamSignalLabel(stream))}</strong>
        <span>${escapeHtml(index === 0 ? "live" : "recent")} / ${escapeHtml(formatElapsed(stream))}</span>
      </div>
      <div class="stream-brief">
        <b>NOW</b>
        <span>${escapeHtml(streamDisplayText(stream))}</span>
      </div>
      <div class="stream-activity-list" aria-label="Recent runtime activity">
        ${activityEvents.map((item) => `
          <div class="stream-activity-row" data-status="${escapeHtml(item.status || stream.status)}">
            <time>${escapeHtml(formatTime(item.timestamp))}</time>
            <span>${escapeHtml(item.message)}</span>
          </div>
        `).join("") || `<div class="stream-activity-row is-empty"><time>--:--</time><span>waiting for first runtime event</span></div>`}
      </div>
      ${stream.prompt ? `<div class="stream-prompt">prompt / ${escapeHtml(compactLogText(stream.prompt))}</div>` : ""}
      ${stream.text || stream.error ? `<pre class="stream-detail">${escapeHtml(streamDisplayText(stream))}</pre>` : ""}
      <div class="stream-meta">
        <span>${escapeHtml(formatElapsed(stream))}</span>
        ${streamMetricLabels(stream).map((label) => `<span>${escapeHtml(label)}</span>`).join("")}
        ${stream.reasoning ? `<span>${escapeHtml(stream.reasoning.toUpperCase())} rsn</span>` : ""}
        ${stream.cacheHitPercent !== undefined ? `<span>cache ${escapeHtml(formatNumber(stream.cacheHitPercent, 0))}%</span>` : ""}
        ${stream.streamId ? `<span>${escapeHtml(stream.streamId.slice(0, 10))}</span>` : ""}
      </div>
    </article>
  `;
  }).join("");
  renderStudioBoard();
}

function streamSignalLabel(stream) {
  if (stream.status === "waiting") return "WAITING";
  if (stream.status === "cancelled") return "STOP";
  if (stream.status === "done") return "DONE";
  if (stream.status === "error") return "ERROR";
  if (stream.text) return "WRITE";
  return "RUN";
}

function streamStatusLabel(stream) {
  if (stream.status === "waiting") return "APPROVAL";
  if (stream.status === "cancelled") return "STOPPED";
  if (stream.status === "done") return "COMPLETE";
  if (stream.status === "error") return "ERROR";
  if (stream.status === "working") return "WORKING";
  return String(stream.status || "STANDBY").toUpperCase();
}

function streamMetricLabels(stream) {
  const labels = [];
  if (Number.isFinite(stream.totalTokens) || stream.usageKnown || stream.tokenEvents > 0) labels.push(tokenLabel(stream));
  if (Number.isFinite(stream.tps) && stream.tps > 0) labels.push(`${formatNumber(stream.tps, 1)} tps`);
  return labels;
}

function renderStudioBoard() {
  if (!state.stageMode || !el.studioBoard) return;

  const active = state.streams[0];
  const lastEvent = state.events.find((event) => !isHighFrequencyStreamEvent(event));
  const activeSource = active?.source || lastEvent?.source || state.activeRuntime;
  const headline = active?.text
    ? streamDisplayText(active)
    : lastEvent
      ? logMessageFor(lastEvent)
      : "Waiting for phone command";
  const subline = active
    ? `${active.source.toUpperCase()} / ${active.status.toUpperCase()} / ${tokenLabel(active)} / ${formatElapsed(active)}`
    : lastEvent
      ? `${String(lastEvent.source || "system").toUpperCase()} / ${lastEvent.type.replaceAll(".", " ").toUpperCase()}`
      : "Open Hermes Control on the phone and press a deck key.";

  el.studioBoard.dataset.source = activeSource;
  el.studioHeadline.textContent = headline;
  el.studioSubline.textContent = subline;

  el.studioAgents.innerHTML = ["codex", "hermes"].map((source) => {
    const signal = agentSignal(source);
    return `
      <article class="studio-agent ${source === activeSource ? "is-hot" : ""}" data-status="${escapeHtml(signal.status)}">
        <span class="studio-logo">${agentLogo(source)}</span>
        <span>
          <b>${escapeHtml(source)}</b>
          <small>${escapeHtml(signal.label)} / ${escapeHtml(signal.detail)}</small>
        </span>
      </article>
    `;
  }).join("");

  el.studioMeter.innerHTML = `
    <span>${escapeHtml(active?.status || agentSignal(activeSource).status || "idle")}</span>
    <span>${escapeHtml(active ? tokenLabel(active) : "0 tok")}</span>
    <span>${escapeHtml(active ? `${formatNumber(active.tps, 1)} tps` : "0.0 tps")}</span>
    <span>${escapeHtml(active ? formatElapsed(active) : "standby")}</span>
  `;

  const feed = timelineEvents().slice(0, 8);
  el.studioFeed.innerHTML = feed.map((event) => `
    <div class="studio-feed-row" data-source="${escapeHtml(event.source || "system")}">
      <b>${escapeHtml(String(event.source || "system").toUpperCase())}</b>
      <span>${escapeHtml(logMessageFor(event))}</span>
    </div>
  `).join("") || `<div class="studio-feed-row"><b>SYSTEM</b><span>waiting for events</span></div>`;
}

function revealStreamWhenUseful(stream, event) {
  if (stream.didReveal || !el.streamPanel) return;
  const hasAnswer = Boolean(stream.text || stream.error);
  const terminal = ["done", "cancelled", "error"].includes(stream.status);
  const activeTaskEvent = ["conversation.message.created", "task.completed", "task.failed", "runtime.error"].includes(event.type);
  if (!hasAnswer && !terminal) return;
  if (!activeTaskEvent) return;

  stream.didReveal = true;
  window.setTimeout(() => {
    el.streamPanel.classList.add("is-alert");
    window.setTimeout(() => el.streamPanel.classList.remove("is-alert"), 1100);
    if (window.innerWidth >= 760) {
      el.streamPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, 90);
}

function streamDisplayText(stream) {
  if (stream.status === "waiting") return "APPROVAL REQUIRED - TAP ALLOW OR DENY";
  if (stream.status === "cancelled") return "Task cancelled.";
  if (stream.error) return stream.error;
  if (stream.text) return stream.text;
  if (stream.status === "done") return "Task completed. No streamed text payload was received.";
  if (stream.status === "error") return "Task failed before a response token was received.";
  return stream.activity || "RUNNING - awaiting runtime output...";
}

function renderLiveLog() {
  if (!el.liveLog) return;
  const seen = new Set();
  const compactEvents = [];

  const candidates = state.events.filter((event) => !isHighFrequencyStreamEvent(event));
  for (const event of candidates.slice(0, 40)) {
    const key = `${event.source}:${logMessageFor(event)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    compactEvents.push(event);
    if (compactEvents.length >= 14) break;
  }

  const entries = compactEvents.map((event) => {
    const source = String(event.source || "system").toUpperCase();
    return `<span><b>${escapeHtml(source)}&gt;</b>${escapeHtml(logMessageFor(event))}</span>`;
  });
  el.liveLog.innerHTML = entries.concat(entries).join("") || `<span><b>SYSTEM&gt;</b>waiting for events</span>`;
}

function timelineEvents() {
  const filtered = state.events.filter((event) => !isHighFrequencyStreamEvent(event));
  return (filtered.length ? filtered : state.events).slice(0, 80);
}

function isHighFrequencyStreamEvent(event) {
  const streamEvent = event?.payload?.event;
  return streamEvent === "token" || streamEvent === "metering" || streamEvent === "reasoning" || streamEvent === "thinking" || streamEvent === "trace";
}

function logMessageFor(event) {
  const assistantText = assistantTextFromEvent(event);
  if (assistantText) return compactLogText(`assistant: ${assistantText}`);

  const messageText = messageTextFromEvent(event);
  if (messageText) return compactLogText(messageText);

  const tokenText = tokenTextFromEvent(event);
  if (tokenText) return compactLogText(`token: ${tokenText}`);

  const message = event.payload?.message;
  if (message) return compactLogText(message);
  if (event.type === "ui.action.completed") {
    return `${event.payload?.action || "action"} ready`;
  }
  if (event.type === "ui.data.refreshed") {
    return `${event.payload?.section || "data"} refreshed`;
  }
  if (event.type === "task.progress") return "planning task...";
  if (event.type === "conversation.message.created") return "writing response...";
  if (event.type === "worker.updated") return "tool running...";
  if (event.type === "approval.requested") return "waiting for approval...";
  if (event.type === "runtime.error") return compactLogText(event.payload?.error || summarize(event.payload));
  return event.type.replaceAll(".", " ");
}

function activityTextFromEvent(event) {
  const action = runtimeActionFromEvent(event);
  if (action) return action;
  const candidates = [
    event.payload?.message,
    event.payload?.detail,
    event.payload?.phase,
    event.payload?.statusText,
    event.payload?.cliEvent?.message,
    event.payload?.cliEvent?.status
  ];
  const message = candidates.find((value) => typeof value === "string" && value.trim());
  if (message) return compactLogText(message);
  if (event.type === "approval.requested") return "approval needed";
  if (event.type === "task.created") return "task queued";
  if (event.type === "task.progress") return "task progressing";
  if (event.type === "worker.updated") return "worker active";
  if (event.type === "conversation.message.created") return "response received";
  if (event.type === "runtime.error") return compactLogText(event.payload?.error || "runtime error");
  return "";
}

function runtimeActionFromEvent(event) {
  const payload = event.payload || {};
  const cli = payload.cliEvent || {};
  const item = cli.item || payload.item || payload.raw?.item;
  if (item && typeof item === "object") {
    const itemText = item.text || item.message || item.detail;
    if (typeof itemText === "string" && itemText.trim()) return compactLogText(itemText);
    if (typeof item.command === "string" && item.command.trim()) return compactLogText(`running: ${item.command}`);
    if (typeof item.path === "string" && item.path.trim()) return compactLogText(`working on: ${item.path}`);
    if (typeof item.name === "string" && item.name.trim()) return compactLogText(`using: ${item.name}`);
    if (typeof item.type === "string") {
      const labels = {
        command_execution: "running command",
        file_change: "writing files",
        mcp_tool_call: "calling tool",
        agent_message: "writing response",
        reasoning: "reasoning"
      };
      if (labels[item.type]) return labels[item.type];
    }
  }
  const phase = payload.phase || payload.detail || payload.statusText || cli.status;
  if (typeof phase === "string" && phase.trim()) return compactLogText(phase);
  if (event.type === "approval.requested") return "waiting for approval";
  if (event.type === "approval.resolved") return "approval resolved";
  if (event.type === "task.created") return "task queued";
  if (event.type === "task.progress") return "task progressing";
  if (event.type === "worker.updated") return "worker active";
  if (event.type === "conversation.message.created") return event.payload?.role === "assistant" ? "writing response" : "prompt sent";
  if (event.type === "task.completed") return "task complete";
  if (event.type === "task.failed" || event.type === "runtime.error") return "runtime error";
  return "";
}

function compactLogText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const activityLabels = {
    js: "inspecting application",
    exec: "running command",
    apply_patch: "editing files",
    wait: "waiting for process",
    reasoning: "planning next step",
    "writing response": "writing response",
    "prompt received": "prompt received",
    "tool completed": "tool completed"
  };
  const activityLabel = activityLabels[text.toLowerCase()];
  if (activityLabel) return activityLabel;
  if (text.includes("Hermes password missing")) return "auth required";
  if (text.includes("fetch failed")) return "link failed";
  if (text.includes("No pending")) return "no pending approval";
  if (text.includes("Prompt is empty")) return "prompt empty";
  return text.slice(0, 72);
}

function eventSummary(event) {
  const assistantText = assistantTextFromEvent(event);
  if (assistantText) return `assistant: ${assistantText}`;

  const messageText = messageTextFromEvent(event);
  if (messageText) return messageText;

  const tokenText = tokenTextFromEvent(event);
  if (tokenText) return `token: ${tokenText}`;

  return summarize(event.payload);
}

function assistantTextFromEvent(event) {
  if (event.payload?.role === "assistant" && typeof event.payload.content === "string" && event.payload.content.trim()) {
    return event.payload.content;
  }

  const cliText = cliAssistantTextFromEvent(event);
  if (cliText) return cliText;

  const messages = event.payload?.data?.session?.messages || event.payload?.session?.messages;
  if (!Array.isArray(messages)) return "";

  const assistant = [...messages].reverse().find((message) => {
    return message?.role === "assistant" && typeof message.content === "string" && message.content.trim();
  });
  return assistant?.content || "";
}

function cliAssistantTextFromEvent(event) {
  const item = event.payload?.cliEvent?.item || event.payload?.item;
  if (!item || typeof item !== "object") return "";

  if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
    return item.text;
  }

  if (Array.isArray(item.content)) {
    const text = item.content
      .map((part) => part?.text || part?.content || "")
      .filter(Boolean)
      .join("");
    if (text.trim()) return text;
  }

  return "";
}

function messageTextFromEvent(event) {
  const role = event.payload?.role;
  const content = event.payload?.content;
  if (role && typeof content === "string" && content.trim()) {
    return `${role}: ${content}`;
  }
  return "";
}

function userMessageFromEvent(event) {
  const role = event.payload?.role;
  const content = event.payload?.content;
  if (role === "user" && typeof content === "string" && content.trim()) return content;

  const nested = event.payload?.payload;
  if (nested?.role === "user" && typeof nested.content === "string" && nested.content.trim()) {
    return nested.content;
  }

  return "";
}

function tokenTextFromEvent(event) {
  const text = event.payload?.data?.text;
  return typeof text === "string" ? text : "";
}

function tokenLabel(stream) {
  if (Number.isFinite(stream.totalTokens) && stream.totalTokens > 0) return `${stream.totalTokens} tok`;
  const output = Number.isFinite(stream.outputTokens) ? stream.outputTokens : 0;
  const input = Number.isFinite(stream.inputTokens) ? stream.inputTokens : 0;
  if (input > 0) return `${output} out / ${input} in`;
  return `${output} tok`;
}

function formatElapsed(stream) {
  const active = ["working", "waiting"].includes(stream.status);
  if (!active && Number.isFinite(stream.durationSeconds)) {
    const seconds = Math.max(0, stream.durationSeconds);
    if (seconds < 60) return `${formatNumber(seconds, 1)}s`;
    return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  }
  const end = active ? Date.now() : stream.lastAt;
  const seconds = Math.max(0, (end - stream.startedAt) / 1000);
  if (seconds < 60) return `${formatNumber(seconds, 1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

function formatNumber(value, digits = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return number.toFixed(digits);
}

function numberOrUndefined(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hydrateFromCache() {
  state.runtimes = readCache("runtimes", []);
  state.agents = readCache("agents", []);
  state.tasks = readCache("tasks", []);
  state.conversations = readCache("sessions", []);
  state.approvals = readCache("approvals", []);
  renderRuntimes();
  renderAgents();
  syncStreamsFromTasks(state.tasks);
  renderTasks();
  renderSessions();
  renderApprovals();
}

function persistCache(name, value) {
  const config = cacheConfig[name];
  if (!config) return;
  try {
    window.localStorage.setItem(config.key, JSON.stringify({
      savedAt: Date.now(),
      value
    }));
  } catch {
    // Local cache is optional.
  }
}

function readCache(name, fallback) {
  const config = cacheConfig[name];
  if (!config) return fallback;
  try {
    const raw = window.localStorage.getItem(config.key);
    if (!raw) return fallback;
    const cached = JSON.parse(raw);
    if (!cached?.savedAt || Date.now() - cached.savedAt > config.ttlMs) return fallback;
    return Array.isArray(cached.value) ? cached.value : fallback;
  } catch {
    return fallback;
  }
}

function readStoredReasoning() {
  try {
    const saved = window.localStorage.getItem("hermes_control_reasoning_v1");
    return reasoningLevels.includes(saved) ? saved : "med";
  } catch {
    return "med";
  }
}

function readStoredCodexSessionMode(theme) {
  try {
    const saved = window.localStorage.getItem("hermes_control_codex_session_mode_v1");
    if (saved === "current" || saved === "new") return saved;
  } catch {
    // Optional local preference.
  }
  return theme === "violet" ? "current" : "new";
}

function sessionModeLabel() {
  return state.codexSessionMode === "current" ? "CURRENT" : "NEW";
}

function surfaceModeLabel() {
  const codex = state.runtimes.find((runtime) => runtime.source === "codex");
  return String(codex?.details?.surface || codex?.details?.mode || "cli").toUpperCase();
}

function isStageMode() {
  const params = new URLSearchParams(window.location.search);
  return params.has("stage") || params.has("monitor") || window.location.hash.includes("stage");
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js", { updateViaCache: "none" }).catch(() => {
      // PWA caching is a bonus; the control deck must stay usable without it.
    });
  });
}

function markAppReady(minimumVisibleMs = 0) {
  const loader = document.querySelector("#bootLoader");
  const remaining = Math.max(0, minimumVisibleMs - (performance.now() - bootStartedAt));
  window.setTimeout(() => {
    document.body.classList.add("app-ready");
    if (loader) window.setTimeout(() => loader.remove(), 720);
  }, remaining);
}

function summarize(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.slice(0, 180);
  try {
    return JSON.stringify(value).slice(0, 180);
  } catch {
    return String(value).slice(0, 180);
  }
}

function formatTime(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat("pl-PL", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
