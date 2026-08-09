import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ALLOWED_STAGES = new Set([
  "stream_start",
  "reasoning",
  "tool",
  "done",
  "approval_requested",
  "approval_resolved"
]);
const ALLOWED_SOURCES = new Set([
  "hermes-gateway-state-db",
  "hermes-control-relay",
  "hermes-world-event-adapter"
]);

export class HermesBridgeError extends Error {
  constructor(message, statusCode = 400, code = "invalid_event") {
    super(message);
    this.name = "HermesBridgeError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class HermesBridgeReceiver {
  constructor(config, eventBus, options = {}) {
    this.config = config;
    this.eventBus = eventBus;
    this.logger = options.logger || (() => {});
    this.state = loadState(config.stateFile, this.logger);
    const requiresStateMigration = this.state.version !== 2;
    const reconciledTasks = reconcileOrphanedTasks(Object.values(this.state.tasksById));
    const repairedTaskState = reconciledTasks.some((task) => (
      this.state.tasksById[task.id]?.status !== task.status
    ));
    this.state = {
      ...this.state,
      version: 2,
      tasksById: Object.fromEntries(reconciledTasks.map((task) => [task.id, task]))
    };
    if (requiresStateMigration || repairedTaskState) this.persist();
    this.reconcileTerminalFailedApprovals();
    this.acceptedIds = new Set(this.state.acceptedEventIds);
  }

  health() {
    const configured = Boolean(this.config.enabled && this.config.token);
    return {
      ok: configured,
      enabled: Boolean(this.config.enabled),
      configured,
      status: configured ? "ready" : this.config.enabled ? "missing_token" : "disabled",
      lastAcceptedAt: this.state.lastAcceptedAt || null,
      lastAcceptedEventId: this.state.lastAcceptedEventId || null,
      acceptedEventCount: this.state.acceptedEventCount || 0,
      trackedRuns: Object.keys(this.state.lastSeqByRun).length,
      trackedTasks: Object.keys(this.state.tasksById).length,
      pendingApprovals: this.listApprovals().length,
      queuedDecisions: Object.values(this.state.decisionsById).filter((item) => item.status === "queued").length
    };
  }

  listTasks() {
    return reconcileOrphanedTasks(Object.values(this.state.tasksById))
      .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0))
      .slice(0, this.config.maxTrackedRuns);
  }

  reconcileWithRuntimeHealth(details = {}) {
    const status = String(details.status || "").toLowerCase();
    const rawActiveRuns = details.active_runs ?? details.activeRuns;
    const hasActiveRuns = rawActiveRuns !== undefined && rawActiveRuns !== null && rawActiveRuns !== "";
    const hasRunList = Array.isArray(details.runs);
    const activeRuns = hasActiveRuns ? Number(rawActiveRuns) : undefined;

    // Only reconcile when Hermes gives an explicit healthy, idle snapshot.
    // An incomplete or failed health response must never hide a real run.
    if (status !== "ok" || (!hasActiveRuns && !hasRunList)) return [];
    if (hasActiveRuns && (!Number.isFinite(activeRuns) || activeRuns > 0)) return [];
    if (hasRunList && details.runs.length > 0) return [];

    const pendingTaskIds = new Set(this.listApprovals()
      .map((approval) => approval.metadata?.taskId)
      .filter(Boolean)
      .map((taskId) => `hermes:bridge:${taskId}`));
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const reconciled = [];

    for (const [id, task] of Object.entries(this.state.tasksById)) {
      if (!id.startsWith("hermes:bridge:") || !isActiveTaskStatus(task.status)) continue;
      if (task.status === "waiting_approval" || pendingTaskIds.has(id)) continue;
      const taskAt = Date.parse(task.updatedAt || task.createdAt || "");
      if (!Number.isFinite(taskAt) || nowMs - taskAt < 60_000) continue;
      const next = {
        ...task,
        status: "completed",
        updatedAt: now,
        metadata: {
          ...(task.metadata || {}),
          reconciled: true,
          lastActivity: "Hermes reports no active run",
          phase: "reconciled idle"
        }
      };
      this.state.tasksById[id] = next;
      reconciled.push(next);
    }

    if (!reconciled.length) return reconciled;
    this.persist();
    for (const task of reconciled) {
      this.eventBus.publish({
        id: `hermes-bridge:${task.id}:reconciled:${Date.now()}`,
        source: "hermes",
        type: "task.completed",
        timestamp: now,
        agentId: task.agentId || "hermes:default",
        taskId: task.id,
        conversationId: task.conversationId,
        payload: {
          status: "completed",
          message: "Hermes reports no active run",
          reconciled: true,
          task
        }
      });
    }
    return reconciled.map((task) => ({ ...task }));
  }

  listApprovals() {
    this.reconcileTerminalFailedApprovals();
    return Object.values(this.state.approvalsById)
      .filter((approval) => ["pending", "decision_queued"].includes(approval.status))
      .map(toDomainApproval)
      .sort((left, right) => Date.parse(right.requestedAt || 0) - Date.parse(left.requestedAt || 0));
  }

  getApproval(approvalId) {
    return this.state.approvalsById[String(approvalId || "")];
  }

  queueDecision({ approvalId, choice, reason = "" }) {
    const id = requiredString(approvalId, "approval_id", 180);
    const approval = this.state.approvalsById[id];
    if (!approval || !["pending", "decision_queued"].includes(approval.status)) {
      throw new HermesBridgeError("Hermes gateway approval is not pending", 409, "approval_not_pending");
    }
    const normalizedChoice = normalizeApprovalChoice(choice);
    const existing = Object.values(this.state.decisionsById).find((item) => item.approvalId === id && item.status !== "failed");
    if (existing) {
      if (existing.choice !== normalizedChoice) {
        throw new HermesBridgeError("A different Hermes approval decision is already queued", 409, "decision_conflict");
      }
      return { ...existing, duplicate: true };
    }

    const now = new Date().toISOString();
    const decision = {
      id: `hermes-decision:${crypto.randomUUID()}`,
      approvalId: id,
      gatewayId: approval.gatewayId,
      sessionId: approval.sessionId,
      // Keep the internal camelCase shape, but also emit the exact wire
      // contract consumed by Hermes Gateway approval claimers.
      approval_id: id,
      gateway_id: approval.gatewayId,
      session_id: approval.sessionId,
      choice: normalizedChoice,
      reason: safeText(reason, 500),
      status: "queued",
      createdAt: now,
      updatedAt: now,
      claimedAt: null,
      claimExpiresAt: null,
      ackedAt: null,
      attempts: 0
    };
    this.state.decisionsById[decision.id] = decision;
    this.state.approvalsById[id] = { ...approval, status: "decision_queued", updatedAt: now };
    this.persist();
    return { ...decision, duplicate: false };
  }

  claimDecisions({ gatewayId, limit = 1, leaseMs = 30_000 }) {
    const owner = requiredString(gatewayId, "gateway_id", 120);
    const now = Date.now();
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 1, 10));
    const boundedLease = Math.max(5_000, Math.min(Number(leaseMs) || 30_000, 120_000));
    const available = Object.values(this.state.decisionsById)
      .filter((item) => item.gatewayId === owner)
      .filter((item) => item.status === "queued" || (
        item.status === "claimed" && Date.parse(item.claimExpiresAt || 0) <= now
      ))
      .sort((left, right) => Date.parse(left.createdAt || 0) - Date.parse(right.createdAt || 0))
      .slice(0, boundedLimit);

    if (!available.length) return [];
    const claimedAt = new Date(now).toISOString();
    const claimExpiresAt = new Date(now + boundedLease).toISOString();
    for (const item of available) {
      Object.assign(item, {
        status: "claimed",
        claimedAt,
        claimExpiresAt,
        updatedAt: claimedAt,
        attempts: (item.attempts || 0) + 1
      });
    }
    this.persist();
    return available.map(toClaimDecision);
  }

  ackDecision({ decisionId, gatewayId, status, error = "" }) {
    const id = requiredString(decisionId, "decision_id", 220);
    const owner = requiredString(gatewayId, "gateway_id", 120);
    const decision = this.state.decisionsById[id];
    if (!decision) throw new HermesBridgeError("Hermes approval decision was not found", 404, "decision_not_found");
    if (decision.gatewayId !== owner) throw new HermesBridgeError("Hermes approval decision belongs to another gateway", 403, "gateway_mismatch");
    const normalizedStatus = String(status || "").toLowerCase();
    if (!new Set(["applied", "failed"]).has(normalizedStatus)) {
      throw new HermesBridgeError("Decision ACK status must be applied or failed", 422, "invalid_ack_status");
    }
    const now = new Date().toISOString();
    Object.assign(decision, {
      status: normalizedStatus === "applied" ? "acked" : "failed",
      ackedAt: now,
      updatedAt: now,
      error: safeText(error, 500)
    });
    const approval = this.state.approvalsById[decision.approvalId];
    let task;
    if (normalizedStatus === "applied" && approval) {
      this.state.approvalsById[approval.id] = {
        ...approval,
        status: "resolved",
        updatedAt: now,
        resolvedAt: now,
        resolution: { choice: decision.choice, status: "applied" }
      };
      const taskId = approval.taskId ? `hermes:bridge:${approval.taskId}` : undefined;
      task = taskId ? this.state.tasksById[taskId] : undefined;
      if (task) {
        this.state.tasksById[taskId] = {
          ...task,
          status: "running",
          updatedAt: now,
          metadata: { ...(task.metadata || {}), lastActivity: "approval resolved", phase: "approval resolved" }
        };
        task = this.state.tasksById[taskId];
      }
    } else if (approval && isTerminalMissingApprovalError(error)) {
      task = this.expireApprovalAfterMissingGatewayDecision(approval, decision, now, error);
    } else if (approval) {
      this.state.approvalsById[approval.id] = {
        ...approval,
        status: "pending",
        updatedAt: now,
        resolution: { choice: decision.choice, status: "failed", error: safeText(error, 500) }
      };
      const taskId = approval.taskId ? `hermes:bridge:${approval.taskId}` : undefined;
      task = taskId ? this.state.tasksById[taskId] : undefined;
      if (task) {
        this.state.tasksById[taskId] = {
          ...task,
          status: "waiting_approval",
          updatedAt: now,
          metadata: {
            ...(task.metadata || {}),
            lastActivity: "approval delivery failed - retry required",
            phase: "approval delivery failed"
          }
        };
        task = this.state.tasksById[taskId];
      }
    }
    this.persist();
    if (normalizedStatus === "applied" && approval) {
      this.eventBus.publish({
        id: `hermes-bridge:${decision.id}:acked`,
        source: "hermes",
        type: "approval.resolved",
        timestamp: now,
        agentId: "hermes:default",
        taskId: approval.taskId ? `hermes:bridge:${approval.taskId}` : undefined,
        conversationId: approval.sessionId ? `hermes:${approval.sessionId}` : undefined,
        payload: {
          approvalId: approval.id,
          decisionId: decision.id,
          choice: decision.choice,
          status: "resolved",
          message: "approval resolved",
          ...(task ? { task } : {})
        }
      });
    } else if (approval && isTerminalMissingApprovalError(error)) {
      this.eventBus.publish({
        id: `hermes-bridge:${decision.id}:expired`,
        source: "hermes",
        type: "approval.resolved",
        timestamp: now,
        agentId: "hermes:default",
        taskId: approval.taskId ? `hermes:bridge:${approval.taskId}` : undefined,
        conversationId: approval.sessionId ? `hermes:${approval.sessionId}` : undefined,
        payload: {
          approvalId: approval.id,
          decisionId: decision.id,
          choice: decision.choice,
          status: "expired",
          message: "approval expired - Hermes no longer has a matching pending approval",
          error: safeText(error, 500),
          ...(task ? { task } : {})
        }
      });
      if (task) {
        this.eventBus.publish({
          id: `hermes-bridge:${decision.id}:task-completed`,
          source: "hermes",
          type: "task.completed",
          timestamp: now,
          agentId: task.agentId || "hermes:default",
          taskId: task.id,
          conversationId: task.conversationId,
          payload: {
            status: "completed",
            message: "Hermes approval expired because the gateway no longer had a matching request",
            approvalExpired: true,
            task
          }
        });
      }
    } else if (approval) {
      this.eventBus.publish({
        id: `hermes-bridge:${decision.id}:failed`,
        source: "hermes",
        type: "approval.requested",
        timestamp: now,
        agentId: "hermes:default",
        taskId: approval.taskId ? `hermes:bridge:${approval.taskId}` : undefined,
        conversationId: approval.sessionId ? `hermes:${approval.sessionId}` : undefined,
        payload: {
          approvalId: approval.id,
          decisionId: decision.id,
          status: "pending",
          message: "approval delivery failed - retry required",
          error: safeText(error, 500),
          ...(task ? { task } : {})
        }
      });
    }
    return { ...decision };
  }

  reconcileTerminalFailedApprovals() {
    const now = new Date().toISOString();
    let changed = false;

    for (const decision of Object.values(this.state.decisionsById)) {
      if (decision.status !== "failed" || !isTerminalMissingApprovalError(decision.error)) continue;
      const approval = this.state.approvalsById[decision.approvalId];
      if (!approval || ["resolved", "expired"].includes(approval.status)) continue;
      this.expireApprovalAfterMissingGatewayDecision(approval, decision, now, decision.error);
      changed = true;
    }

    if (changed) this.persist();
    return changed;
  }

  expireApprovalAfterMissingGatewayDecision(approval, decision, now, error) {
    this.state.approvalsById[approval.id] = {
      ...approval,
      status: "expired",
      updatedAt: now,
      resolvedAt: now,
      resolution: {
        choice: decision.choice,
        status: "expired",
        error: safeText(error, 500)
      }
    };

    const taskId = approval.taskId ? `hermes:bridge:${approval.taskId}` : undefined;
    const task = taskId ? this.state.tasksById[taskId] : undefined;
    if (!task) return undefined;

    this.state.tasksById[taskId] = {
      ...task,
      status: "completed",
      progress: 100,
      updatedAt: now,
      metadata: {
        ...(task.metadata || {}),
        lastActivity: "Hermes approval expired",
        phase: "approval expired",
        approvalExpired: true,
        approvalError: safeText(error, 500)
      }
    };
    return this.state.tasksById[taskId];
  }

  listRecentSessionIds(options = {}) {
    const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
    const limit = options.limit ?? 12;
    const since = Date.now() - maxAgeMs;
    const ids = [];

    for (const task of this.listTasks()) {
      if ((Date.parse(task.updatedAt || 0) || 0) < since) continue;
      const sessionId = task.metadata?.bridgeSessionId
        || String(task.conversationId || "").replace(/^hermes:/, "");
      if (sessionId && !ids.includes(sessionId)) ids.push(sessionId);
      if (ids.length >= limit) break;
    }

    return ids;
  }

  authorize(headers = {}) {
    if (!this.config.enabled) {
      throw new HermesBridgeError("Hermes event bridge is disabled", 404, "bridge_disabled");
    }
    if (!this.config.token) {
      throw new HermesBridgeError("Hermes event bridge token is not configured", 503, "bridge_misconfigured");
    }

    const bearer = String(headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1];
    const supplied = bearer || headers["x-hermes-control-token"];
    if (!constantTimeEqual(String(supplied || ""), this.config.token)) {
      throw new HermesBridgeError("Unauthorized Hermes event bridge request", 401, "unauthorized");
    }
  }

  accept(input) {
    const event = normalizeHermesBridgeEvent(input);
    if (this.acceptedIds.has(event.eventId)) {
      return {
        accepted: true,
        duplicate: true,
        eventId: event.eventId,
        runId: event.runId,
        seq: event.seq,
        publishedTypes: []
      };
    }

    const lastSeq = this.state.lastSeqByRun[event.runId];
    if (Number.isInteger(lastSeq) && event.seq <= lastSeq) {
      throw new HermesBridgeError(
        `Out-of-order Hermes event: ${event.runId} seq ${event.seq} after ${lastSeq}`,
        409,
        "out_of_order"
      );
    }

    const mappedEvents = mapHermesBridgeEvent(event);
    const mappedTask = mappedEvents[0]?.payload?.task;
    const acceptedAt = new Date().toISOString();
    const nextIds = [event.eventId, ...this.state.acceptedEventIds]
      .filter((value, index, values) => values.indexOf(value) === index)
      .slice(0, this.config.maxEventIds);

    this.state = {
      version: 2,
      lastAcceptedAt: acceptedAt,
      lastAcceptedEventId: event.eventId,
      acceptedEventCount: (this.state.acceptedEventCount || 0) + 1,
      acceptedEventIds: nextIds,
      lastSeqByRun: updateRunSequence(
        this.state.lastSeqByRun,
        event.runId,
        event.seq,
        this.config.maxTrackedRuns
      ),
      tasksById: updateTrackedTask(
        reconcileTrackedTasks(this.state.tasksById, mappedTask, event),
        mappedTask,
        this.config.maxTrackedRuns
      ),
      approvalsById: updateApprovalState(this.state.approvalsById, event),
      decisionsById: updateDecisionState(this.state.decisionsById, event)
    };
    this.persist();
    this.acceptedIds = new Set(nextIds);

    for (const mapped of mappedEvents) {
      this.eventBus.publish(mapped);
    }

    return {
      accepted: true,
      duplicate: false,
      acceptedAt,
      eventId: event.eventId,
      runId: event.runId,
      seq: event.seq,
      publishedTypes: mappedEvents.map((item) => item.type)
    };
  }

  persist() {
    this.state = pruneTerminalApprovalState(
      this.state,
      this.config.maxTerminalApprovals
    );
    persistState(this.config.stateFile, this.state);
  }
}

export function normalizeHermesBridgeEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HermesBridgeError("Hermes bridge event must be a JSON object");
  }

  const payload = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
    ? input.payload
    : {};
  const eventId = requiredString(input.event_id ?? input.eventId, "event_id", 180);
  const runId = requiredString(input.run_id ?? input.runId, "run_id", 140);
  const stage = requiredString(input.event ?? input.event_type ?? input.eventType ?? input.type, "event", 40).toLowerCase();
  const seq = Number(input.seq);

  if (!ALLOWED_STAGES.has(stage)) {
    throw new HermesBridgeError(`Unsupported Hermes bridge event: ${stage}`, 422, "unsupported_event");
  }
  if (!Number.isInteger(seq) || seq < 0) {
    throw new HermesBridgeError("seq must be a non-negative integer");
  }

  const source = optionalString(input.source, "hermes-gateway-state-db", 80);
  if (!ALLOWED_SOURCES.has(source)) {
    throw new HermesBridgeError(`Unsupported Hermes bridge source: ${source}`, 422, "unsupported_source");
  }

  const timestamp = normalizeTimestamp(input.created_at ?? input.createdAt ?? input.timestamp);
  const profile = optionalString(input.profile, "default", 80);
  const topLevelSessionId = input.session_id
    ?? input.sessionId
    ?? input.session_key
    ?? input.sessionKey;
  const sessionId = optionalString(
    topLevelSessionId ?? (stage.startsWith("approval_")
      ? undefined
      : payload.session_id
        ?? payload.sessionId
        ?? payload.session_key
        ?? payload.sessionKey),
    "",
    180
  );
  const taskId = optionalString(input.task_id ?? input.taskId, runId, 180);

  const approvalId = safeText(
    payload.approval_id
      ?? payload.approvalId
      ?? input.approval_id
      ?? input.approvalId,
    180
  );
  const gatewayId = safeText(
    payload.gateway_id
      ?? payload.gatewayId
      ?? input.gateway_id
      ?? input.gatewayId,
    120
  );
  if (stage.startsWith("approval_") && (!approvalId || !gatewayId || !sessionId)) {
    throw new HermesBridgeError(
      "approval_id, gateway_id and top-level session_id are required for Hermes approval events",
      422,
      "invalid_approval_event"
    );
  }

  return {
    eventId,
    runId,
    seq,
    stage,
    timestamp,
    sessionId,
    taskId,
    profile,
    source,
    taskTitle: safeText(payload.task_title ?? payload.taskTitle, 96),
    toolName: safeText(payload.tool_name ?? payload.toolName, 80),
    contentLength: safeInteger(payload.content_length ?? payload.contentLength),
    approvalId,
    gatewayId,
    decisionId: safeText(payload.decision_id ?? payload.decisionId, 220),
    command: safeText(payload.command, 1200),
    question: safeText(payload.question ?? payload.description, 800),
    choice: safeText(payload.choice, 40),
    approvalStatus: safeText(payload.status, 40),
    surface: safeText(payload.surface, 40)
  };
}

export function mapHermesBridgeEvent(event) {
  const taskId = `hermes:bridge:${event.taskId}`;
  const conversationId = event.sessionId ? `hermes:${event.sessionId}` : undefined;
  const title = event.taskTitle || "Hermes runtime task";
  const activity = activityFor(event);
  const status = event.stage === "done"
    ? "completed"
    : event.stage === "approval_requested"
      ? "waiting_approval"
      : "running";
  const task = {
    id: taskId,
    source: "hermes",
    agentId: `hermes:${event.profile}`,
    conversationId,
    title,
    status,
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
    metadata: {
      bridgeEventId: event.eventId,
      bridgeRunId: event.runId,
      bridgeSeq: event.seq,
      bridgeStage: event.stage,
      bridgeSource: event.source,
      ...(event.sessionId ? { bridgeSessionId: event.sessionId } : {}),
      lastActivity: activity,
      phase: activity,
      ...(event.toolName ? { toolName: event.toolName } : {}),
      ...(event.contentLength !== undefined ? { contentLength: event.contentLength } : {})
    }
  };

  if (event.stage === "approval_requested" || event.stage === "approval_resolved") {
    const approval = approvalFromBridgeEvent(event);
    return [{
      id: `hermes-bridge:${event.eventId}`,
      source: "hermes",
      type: event.stage === "approval_requested" ? "approval.requested" : "approval.resolved",
      timestamp: event.timestamp,
      agentId: task.agentId,
      taskId,
      conversationId,
      payload: {
        approvalId: event.approvalId,
        status: event.stage === "approval_requested" ? "pending" : "resolved",
        choice: event.choice || undefined,
        approval,
        task,
        message: event.stage === "approval_requested" ? "approval required" : "approval resolved",
        bridge: { eventId: event.eventId, runId: event.runId, seq: event.seq, source: event.source }
      }
    }];
  }

  const type = event.stage === "stream_start"
    ? "task.created"
    : event.stage === "done"
      ? "task.completed"
      : "task.progress";

  return [{
    id: `hermes-bridge:${event.eventId}`,
    source: "hermes",
    type,
    timestamp: event.timestamp,
    agentId: task.agentId,
    taskId,
    conversationId,
    payload: {
      event: event.stage,
      status,
      message: activity,
      task,
      bridge: {
        eventId: event.eventId,
        runId: event.runId,
        seq: event.seq,
        source: event.source
      }
    }
  }];
}

function activityFor(event) {
  if (event.stage === "stream_start") return event.taskTitle ? `received: ${event.taskTitle}` : "command received";
  if (event.stage === "reasoning") return "planning task...";
  if (event.stage === "tool") return event.toolName ? `using ${event.toolName}` : "using runtime tool";
  if (event.stage === "approval_requested") return "approval required";
  if (event.stage === "approval_resolved") return "approval resolved";
  return "task complete";
}

function loadState(filePath, logger) {
  const empty = {
    version: 2,
    lastAcceptedAt: null,
    lastAcceptedEventId: null,
    acceptedEventCount: 0,
    acceptedEventIds: [],
    lastSeqByRun: {},
    tasksById: {},
    approvalsById: {},
    decisionsById: {}
  };
  if (!filePath || !fs.existsSync(filePath)) return empty;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      ...empty,
      ...parsed,
      acceptedEventIds: Array.isArray(parsed.acceptedEventIds) ? parsed.acceptedEventIds.map(String) : [],
      lastSeqByRun: parsed.lastSeqByRun && typeof parsed.lastSeqByRun === "object" ? parsed.lastSeqByRun : {},
      tasksById: parsed.tasksById && typeof parsed.tasksById === "object" ? parsed.tasksById : {},
      approvalsById: parsed.approvalsById && typeof parsed.approvalsById === "object" ? parsed.approvalsById : {},
      decisionsById: parsed.decisionsById && typeof parsed.decisionsById === "object" ? parsed.decisionsById : {}
    };
  } catch (error) {
    logger(`Hermes bridge receiver state ignored: ${error.message}`);
    return empty;
  }
}

function persistState(filePath, state) {
  if (!filePath) throw new HermesBridgeError("Hermes bridge state file is not configured", 503, "bridge_misconfigured");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function isTerminalMissingApprovalError(value) {
  return /no pending hermes gateway approval matched the decision/i.test(String(value || ""));
}

function updateRunSequence(input, runId, seq, maxRuns) {
  const entries = Object.entries(input).filter(([key]) => key !== runId);
  entries.push([runId, seq]);
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - maxRuns)));
}

function updateTrackedTask(input, task, maxTasks) {
  if (!task?.id) return input;
  const entries = Object.entries(input).filter(([key]) => key !== task.id);
  entries.push([task.id, task]);
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - maxTasks)));
}

function reconcileTrackedTasks(input, currentTask, event) {
  if (!currentTask?.conversationId || !["stream_start", "done"].includes(event.stage)) return input;
  const cutoff = Date.parse(event.timestamp || 0) || Date.now();
  const updated = { ...input };
  for (const [id, task] of Object.entries(updated)) {
    if (id === currentTask.id || task.conversationId !== currentTask.conversationId) continue;
    if (!isActiveTaskStatus(task.status)) continue;
    const taskTime = Date.parse(task.updatedAt || task.createdAt || 0) || 0;
    if (taskTime > cutoff) continue;
    updated[id] = {
      ...task,
      status: "completed",
      updatedAt: event.timestamp,
      metadata: { ...(task.metadata || {}), reconciled: true, lastActivity: "superseded by newer gateway run" }
    };
  }
  return updated;
}

function reconcileOrphanedTasks(tasks) {
  const newestTerminalByConversation = new Map();
  for (const task of tasks) {
    if (!task.conversationId || isActiveTaskStatus(task.status)) continue;
    const time = Date.parse(task.updatedAt || task.createdAt || 0) || 0;
    newestTerminalByConversation.set(task.conversationId, Math.max(newestTerminalByConversation.get(task.conversationId) || 0, time));
  }
  return tasks.map((task) => {
    if (!isActiveTaskStatus(task.status)) return task;
    const terminalAt = newestTerminalByConversation.get(task.conversationId) || 0;
    const taskAt = Date.parse(task.updatedAt || task.createdAt || 0) || 0;
    if (!terminalAt || terminalAt < taskAt) return task;
    return {
      ...task,
      status: "completed",
      metadata: { ...(task.metadata || {}), reconciled: true, lastActivity: "superseded by completed gateway run" }
    };
  });
}

function isActiveTaskStatus(status) {
  return new Set(["running", "working", "thinking", "in_progress", "waiting_approval"]).has(String(status || "").toLowerCase());
}

function updateApprovalState(input, event) {
  if (!event.approvalId) return input;
  const now = event.timestamp;
  const existing = input[event.approvalId] || {};
  if (event.stage === "approval_requested") {
    return {
      ...input,
      [event.approvalId]: {
        ...existing,
        id: event.approvalId,
        gatewayId: event.gatewayId,
        sessionId: event.sessionId,
        runId: event.runId,
        taskId: event.taskId,
        command: event.command,
        question: event.question,
        surface: event.surface || "gateway",
        status: existing.status === "decision_queued" ? "decision_queued" : "pending",
        requestedAt: existing.requestedAt || now,
        updatedAt: now,
        resolvedAt: null,
        resolution: null
      }
    };
  }
  if (event.stage === "approval_resolved") {
    return {
      ...input,
      [event.approvalId]: {
        ...existing,
        id: event.approvalId,
        gatewayId: event.gatewayId,
        sessionId: event.sessionId || existing.sessionId,
        status: "resolved",
        updatedAt: now,
        resolvedAt: now,
        resolution: { choice: event.choice, status: event.approvalStatus || "applied" }
      }
    };
  }
  return input;
}

function updateDecisionState(input, event) {
  if (event.stage !== "approval_resolved") return input;
  const updated = { ...input };
  const decision = event.decisionId
    ? updated[event.decisionId]
    : Object.values(updated).find((item) => item.approvalId === event.approvalId && ["queued", "claimed", "acked"].includes(item.status));
  if (!decision) return input;
  updated[decision.id] = {
    ...decision,
    status: "acked",
    ackedAt: event.timestamp,
    updatedAt: event.timestamp
  };
  return updated;
}

function pruneTerminalApprovalState(state, configuredLimit) {
  const limit = Math.max(1, Math.min(Number(configuredLimit) || 50, 1000));
  return {
    ...state,
    approvalsById: retainActiveAndRecentTerminal(
      state.approvalsById,
      (item) => ["pending", "decision_queued"].includes(item.status),
      limit
    ),
    decisionsById: retainActiveAndRecentTerminal(
      state.decisionsById,
      (item) => ["queued", "claimed"].includes(item.status),
      limit
    )
  };
}

function retainActiveAndRecentTerminal(input, isActive, terminalLimit) {
  const entries = Object.entries(input || {});
  const active = entries.filter(([, item]) => isActive(item));
  const terminal = entries
    .filter(([, item]) => !isActive(item))
    .sort((left, right) => recordTimestamp(right[1]) - recordTimestamp(left[1]))
    .slice(0, terminalLimit);
  return Object.fromEntries([...active, ...terminal]);
}

function recordTimestamp(item) {
  const timestamp = Date.parse(item?.updatedAt || item?.ackedAt || item?.resolvedAt || item?.createdAt || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function approvalFromBridgeEvent(event) {
  return toDomainApproval({
    id: event.approvalId,
    gatewayId: event.gatewayId,
    sessionId: event.sessionId,
    runId: event.runId,
    taskId: event.taskId,
    command: event.command,
    question: event.question,
    surface: event.surface || "gateway",
    status: event.stage === "approval_requested" ? "pending" : "resolved",
    requestedAt: event.timestamp,
    updatedAt: event.timestamp,
    resolvedAt: event.stage === "approval_resolved" ? event.timestamp : null
  });
}

function toDomainApproval(approval) {
  return {
    id: approval.id,
    source: "hermes",
    conversationId: approval.sessionId ? `hermes:${approval.sessionId}` : undefined,
    title: approval.command || "Hermes gateway approval",
    body: approval.question || approval.command || "Hermes is waiting for approval.",
    status: ["pending", "decision_queued"].includes(approval.status) ? "pending" : approval.status,
    requestedAt: approval.requestedAt,
    resolvedAt: approval.resolvedAt || undefined,
    metadata: {
      transport: "gateway_bridge",
      gatewayId: approval.gatewayId,
      sessionId: approval.sessionId,
      runId: approval.runId,
      taskId: approval.taskId,
      surface: approval.surface,
      bridgeStatus: approval.status
    }
  };
}

function toClaimDecision(decision) {
  return {
    ...decision,
    approval_id: decision.approval_id || decision.approvalId,
    gateway_id: decision.gateway_id || decision.gatewayId,
    session_id: decision.session_id || decision.sessionId
  };
}

function normalizeApprovalChoice(value) {
  const choice = String(value || "").toLowerCase();
  const aliases = { approve: "once", approved: "once", allow: "once", reject: "deny", rejected: "deny" };
  const normalized = aliases[choice] || choice;
  if (!new Set(["once", "session", "always", "deny"]).has(normalized)) {
    throw new HermesBridgeError("Unsupported Hermes approval choice", 422, "invalid_approval_choice");
  }
  return normalized;
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requiredString(value, name, maxLength) {
  const result = String(value ?? "").trim();
  if (!result) throw new HermesBridgeError(`${name} is required`);
  if (result.length > maxLength) throw new HermesBridgeError(`${name} exceeds ${maxLength} characters`);
  return result;
}

function optionalString(value, fallback, maxLength) {
  const result = String(value ?? fallback).trim();
  if (result.length > maxLength) throw new HermesBridgeError(`Value exceeds ${maxLength} characters`);
  return result;
}

function safeText(value, maxLength) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function safeInteger(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeTimestamp(value) {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) return new Date().toISOString();
  return new Date(parsed).toISOString();
}
