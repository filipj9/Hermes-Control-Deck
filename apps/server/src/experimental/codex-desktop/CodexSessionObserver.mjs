import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const INITIAL_TAIL_BYTES = 2 * 1024 * 1024;
const SESSION_RESCAN_MS = 10000;
const APPROVAL_RESCAN_MS = 750;
const APPROVAL_TAIL_BYTES = 512 * 1024;
const APPROVAL_SESSION_LIMIT = 24;

export class CodexSessionObserver {
  constructor(config = {}) {
    this.sessionsRoot = path.join(
      config.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
      "sessions"
    );
    this.filePath = undefined;
    this.offset = 0;
    this.partial = "";
    this.lastScanAt = 0;
    this.pendingApprovalCallIds = new Set();
    this.explicitApprovalPending = false;
    this.approvalStates = new Map();
    this.lastApprovalScanAt = 0;
    this.pendingApprovals = [];
    this.snapshotValue = emptySnapshot();
  }

  describe() {
    return {
      available: fs.existsSync(this.sessionsRoot),
      transport: "session-jsonl/read-only",
      sessionsRoot: this.sessionsRoot,
      activeThreadId: this.snapshotValue.threadId,
      working: this.snapshotValue.working
    };
  }

  snapshot() {
    this.selectLatestSession();
    if (this.readUpdates()) this.lastApprovalScanAt = 0;
    this.pendingApprovals = this.scanPendingApprovals();
    this.snapshotValue.pendingApprovals = this.pendingApprovals.map((approval) => ({ ...approval }));
    const activeApproval = this.pendingApprovals.find((approval) => approval.threadId === this.snapshotValue.threadId);
    if (activeApproval) {
      this.snapshotValue.waitingApproval = true;
      this.snapshotValue.detail = "Waiting for approval";
      this.snapshotValue.approvalDetection = activeApproval.approvalDetection;
      this.snapshotValue.approvalCallId = activeApproval.callId;
    }
    return { ...this.snapshotValue };
  }

  selectLatestSession() {
    const now = Date.now();
    const currentExists = this.filePath && fs.existsSync(this.filePath);
    if (currentExists && now - this.lastScanAt < SESSION_RESCAN_MS) return;
    this.lastScanAt = now;

    const latest = newestSessionFile(this.sessionsRoot);
    if (!latest || latest.filePath === this.filePath) return;

    this.filePath = latest.filePath;
    this.offset = Math.max(0, latest.size - INITIAL_TAIL_BYTES);
    this.partial = "";
    this.resetApprovalState();
    this.snapshotValue = {
      ...emptySnapshot(),
      threadId: threadIdFromFile(latest.filePath),
      title: "Codex Desktop task",
      updatedAt: latest.mtime.toISOString()
    };
  }

  readUpdates() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return false;
    const stats = fs.statSync(this.filePath);
    if (stats.size < this.offset) {
      this.offset = Math.max(0, stats.size - INITIAL_TAIL_BYTES);
      this.partial = "";
      this.resetApprovalState();
      this.snapshotValue = {
        ...emptySnapshot(),
        threadId: threadIdFromFile(this.filePath)
      };
    }
    if (stats.size === this.offset) return false;

    const length = stats.size - this.offset;
    const buffer = Buffer.allocUnsafe(length);
    const descriptor = fs.openSync(this.filePath, "r");
    try {
      fs.readSync(descriptor, buffer, 0, length, this.offset);
    } finally {
      fs.closeSync(descriptor);
    }
    this.offset = stats.size;
    this.snapshotValue.updatedAt = stats.mtime.toISOString();

    const text = this.partial + buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    this.partial = lines.pop() || "";
    for (const line of lines) this.ingestLine(line);
    return true;
  }

  ingestLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    const payload = event?.payload || {};
    const payloadType = payload.type || "";
    if (event?.type === "turn_context" && payload.turn_id) {
      this.resetApprovalState();
      this.snapshotValue.turnId = String(payload.turn_id);
      this.snapshotValue.hasTurnState = true;
      this.snapshotValue.working = true;
      this.snapshotValue.waitingApproval = false;
      this.snapshotValue.detail = "Turn started";
    }

    if (event?.type === "event_msg" && payloadType === "user_message") {
      this.resetApprovalState();
      this.snapshotValue.hasTurnState = true;
      this.snapshotValue.working = true;
      this.snapshotValue.waitingApproval = false;
      this.snapshotValue.title = compactText(
        payload.message || payload.text || payload.content || this.snapshotValue.title
      );
      this.snapshotValue.detail = "Prompt received";
    }

    if (event?.type === "event_msg" && payloadType === "task_complete") {
      this.snapshotValue.hasTurnState = true;
      if (!this.snapshotValue.turnId || !payload.turn_id || String(payload.turn_id) === this.snapshotValue.turnId) {
        this.snapshotValue.working = false;
        this.resetApprovalState();
        this.snapshotValue.detail = "Task complete";
      }
    }

    if (/approval.*request|request.*approval/i.test(payloadType)) {
      this.explicitApprovalPending = true;
      this.snapshotValue.hasTurnState = true;
      this.snapshotValue.working = true;
      this.snapshotValue.waitingApproval = true;
      this.snapshotValue.detail = "Waiting for approval";
      this.snapshotValue.approvalDetection = "session-jsonl/explicit-approval-event";
    }

    if (/approval.*(?:resolved|completed|decision)|(?:resolved|completed|decision).*approval/i.test(payloadType)) {
      this.explicitApprovalPending = false;
      this.refreshApprovalSnapshot();
    }

    if (event?.type === "response_item" && ["function_call", "custom_tool_call"].includes(payloadType)) {
      if (isEscalatedToolCall(payload)) {
        const callId = approvalCallId(payload);
        this.pendingApprovalCallIds.add(callId);
        this.snapshotValue.hasTurnState = true;
        this.snapshotValue.working = true;
        this.snapshotValue.waitingApproval = true;
        this.snapshotValue.detail = "Waiting for approval";
        this.snapshotValue.approvalDetection = "session-jsonl/escalated-tool-call";
        this.snapshotValue.approvalCallId = callId;
      }
    }

    if (event?.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(payloadType)) {
      const callId = approvalCallId(payload);
      if (callId) this.pendingApprovalCallIds.delete(callId);
      this.refreshApprovalSnapshot();
    }

    if (event?.type === "event_msg" && payloadType === "token_count") {
      const usage = payload.info?.last_token_usage;
      if (usage && Number.isFinite(Number(usage.total_tokens))) {
        this.snapshotValue.tokens = Number(usage.total_tokens);
      }
    }

    const detail = eventDetail(event, payloadType);
    if (detail && !this.snapshotValue.waitingApproval) this.snapshotValue.detail = detail;
    if (event?.timestamp) this.snapshotValue.updatedAt = event.timestamp;
  }

  resetApprovalState() {
    this.pendingApprovalCallIds.clear();
    this.explicitApprovalPending = false;
    if (this.snapshotValue) {
      this.snapshotValue.waitingApproval = false;
      this.snapshotValue.approvalDetection = undefined;
      this.snapshotValue.approvalCallId = undefined;
    }
  }

  refreshApprovalSnapshot() {
    const waiting = this.explicitApprovalPending || this.pendingApprovalCallIds.size > 0;
    this.snapshotValue.waitingApproval = waiting;
    if (waiting) {
      this.snapshotValue.detail = "Waiting for approval";
      return;
    }
    this.snapshotValue.approvalDetection = undefined;
    this.snapshotValue.approvalCallId = undefined;
  }

  scanPendingApprovals() {
    const now = Date.now();
    if (now - this.lastApprovalScanAt < APPROVAL_RESCAN_MS) return this.pendingApprovals;
    this.lastApprovalScanAt = now;

    const sessions = newestSessionFiles(this.sessionsRoot, APPROVAL_SESSION_LIMIT, { includeSubagents: true });
    const activePaths = new Set(sessions.map((session) => session.filePath));
    for (const filePath of this.approvalStates.keys()) {
      if (!activePaths.has(filePath)) this.approvalStates.delete(filePath);
    }

    for (const session of sessions) this.readApprovalUpdates(session);
    return [...this.approvalStates.values()]
      .flatMap((state) => [...state.pending.values()])
      .sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""));
  }

  readApprovalUpdates(session) {
    let state = this.approvalStates.get(session.filePath);
    if (!state) {
      const offset = Math.max(0, session.size - APPROVAL_TAIL_BYTES);
      state = {
        offset,
        partial: "",
        skipPartial: offset > 0,
        pending: new Map(),
        threadId: threadIdFromFile(session.filePath),
        turnId: undefined,
        title: "Codex Desktop task"
      };
      this.approvalStates.set(session.filePath, state);
    }
    if (session.size < state.offset) {
      state.offset = Math.max(0, session.size - APPROVAL_TAIL_BYTES);
      state.partial = "";
      state.skipPartial = state.offset > 0;
      state.pending.clear();
    }
    if (session.size === state.offset) return;

    const length = session.size - state.offset;
    const buffer = Buffer.allocUnsafe(length);
    const descriptor = fs.openSync(session.filePath, "r");
    try {
      fs.readSync(descriptor, buffer, 0, length, state.offset);
    } finally {
      fs.closeSync(descriptor);
    }
    state.offset = session.size;
    const lines = (state.partial + buffer.toString("utf8")).split(/\r?\n/);
    state.partial = lines.pop() || "";
    if (state.skipPartial) {
      lines.shift();
      state.skipPartial = false;
    }
    for (const line of lines) ingestApprovalLine(state, line);
  }
}

function isEscalatedToolCall(payload = {}) {
  const rawInput = payload.input ?? payload.arguments ?? "";
  const input = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput);
  return /["']sandbox_permissions["']\s*:\s*["']require_escalated["']/.test(input)
    && /["']justification["']\s*:/.test(input);
}

function approvalCallId(payload = {}) {
  return String(payload.call_id || payload.callId || payload.id || "");
}

function newestSessionFile(root) {
  return newestSessionFiles(root, 1)[0];
}

function newestSessionFiles(root, limit, options = {}) {
  if (!fs.existsSync(root)) return [];
  const sessions = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(filePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const stats = fs.statSync(filePath);
      if (options.includeSubagents || isPrimaryUserSession(filePath)) {
        sessions.push({
          filePath,
          size: stats.size,
          mtime: stats.mtime,
          mtimeMs: stats.mtimeMs
        });
      }
    }
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions.slice(0, limit);
}

function ingestApprovalLine(state, line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  const payload = event?.payload || {};
  const payloadType = payload.type || "";
  const updatedAt = event?.timestamp || new Date().toISOString();

  if (event?.type === "turn_context" && payload.turn_id) {
    state.turnId = String(payload.turn_id);
    state.pending.clear();
  }
  if (event?.type === "event_msg" && payloadType === "user_message") {
    state.title = compactText(payload.message || payload.text || payload.content || state.title);
    state.pending.clear();
  }
  if (event?.type === "event_msg" && payloadType === "task_complete") state.pending.clear();

  if (/approval.*request|request.*approval/i.test(payloadType)) {
    const callId = approvalCallId(payload) || `explicit:${state.turnId || "active"}`;
    state.pending.set(callId, {
      threadId: state.threadId,
      turnId: state.turnId,
      title: state.title,
      callId,
      approvalDetection: "session-jsonl/explicit-approval-event",
      updatedAt
    });
  }
  if (/approval.*(?:resolved|completed|decision)|(?:resolved|completed|decision).*approval/i.test(payloadType)) {
    state.pending.clear();
  }
  if (event?.type === "response_item" && ["function_call", "custom_tool_call"].includes(payloadType) && isEscalatedToolCall(payload)) {
    const callId = approvalCallId(payload);
    if (callId) {
      state.pending.set(callId, {
        threadId: state.threadId,
        turnId: state.turnId,
        title: state.title,
        callId,
        approvalDetection: "session-jsonl/escalated-tool-call",
        updatedAt
      });
    }
  }
  if (event?.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(payloadType)) {
    const callId = approvalCallId(payload);
    if (callId) state.pending.delete(callId);
  }
}

function isPrimaryUserSession(filePath) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0];
    const event = JSON.parse(firstLine);
    const meta = event?.type === "session_meta" ? event.payload : undefined;
    if (!meta) return true;
    return String(meta.thread_source || "user").toLowerCase() !== "subagent";
  } catch {
    return true;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function threadIdFromFile(filePath) {
  return path.basename(filePath).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i)?.[1];
}

function eventDetail(event, payloadType) {
  if (event?.type === "response_item") {
    if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      return compactText(payloadName(event.payload) || "Running tool");
    }
    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      return "Tool completed";
    }
    if (payloadType === "reasoning") return "Reasoning";
    if (payloadType === "message" && event.payload?.role === "assistant") return "Writing response";
  }
  if (event?.type === "event_msg" && payloadType === "agent_reasoning") return "Reasoning";
  if (event?.type === "event_msg" && payloadType === "agent_message") return "Writing response";
  return "";
}

function payloadName(payload = {}) {
  return payload.name || payload.tool_name || payload.toolName || payload.command;
}

function compactText(value) {
  if (Array.isArray(value)) {
    value = value.map((item) => item?.text || item?.content || "").join(" ");
  }
  if (value && typeof value === "object") {
    value = value.text || value.content || value.message || "";
  }
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 120) : "";
}

function emptySnapshot() {
  return {
    threadId: undefined,
    turnId: undefined,
    title: "Codex Desktop task",
    hasTurnState: false,
    working: false,
    waitingApproval: false,
    approvalDetection: undefined,
    approvalCallId: undefined,
    pendingApprovals: [],
    detail: "Idle",
    tokens: undefined,
    updatedAt: new Date(0).toISOString()
  };
}
