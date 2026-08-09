import { HermesApiClient } from "./HermesApiClient.mjs";
import { HermesWsClient, HermesWsError } from "./HermesWsClient.mjs";
import { toHermesAgents, toHermesConversations, toHermesTasks, toMetricEvent } from "./HermesEventMapper.mjs";

const DEFAULT_EXTERNAL_SESSION_LIMIT = 50;
const DEFAULT_EXTERNAL_SESSION_REFRESH_MS = 2000;
const DEFAULT_EXTERNAL_APPROVAL_POLL_MS = 2500;
const HERMES_STALE_ACTIVE_TASK_GRACE_MS = 60_000;

export class HermesRuntimeAdapter {
  constructor(config, eventBus, options = {}) {
    this.source = "hermes";
    this.config = config;
    this.client = new HermesApiClient(config);
    this.wsClient = options.wsClient || (
      config.ws?.enabled && config.ws?.url
        ? new HermesWsClient(config.ws, {
            onEvent: (message) => this.handleHermesWsEvent(message),
            onError: (error) => this.recordHermesWsError(error)
          })
        : undefined
    );
    this.eventBus = eventBus;
    this.activeSessionId = undefined;
    this.wsActiveSessionId = undefined;
    this.activeStreamId = undefined;
    this.streamStates = new Map();
    this.wsSessions = new Map();
    this.hermesWsLastError = "";
    this.hermesWsLastErrorAt = 0;
    this.streamReconnectAttempts = nonNegativeInteger(config.streamReconnectAttempts, 3);
    this.streamReconnectBackoffMs = nonNegativeInteger(config.streamReconnectBackoffMs, 250);
    this.bridgeReceiver = options.bridgeReceiver;
    this.wsObservationPromise = undefined;
    this.wsObservedSessionId = undefined;
    this.externalApprovals = new Map();
    this.pendingApprovalSessions = new Map();
    this.externalApprovalScanPromise = undefined;
    this.externalApprovalTimer = undefined;
    this.externalSessionIds = [];
    this.externalSessionDiscoveredAt = 0;
    this.externalSessionDiscoveryPromise = undefined;
    this.externalSessionLimit = positiveInteger(config.externalSessionLimit, DEFAULT_EXTERNAL_SESSION_LIMIT);
    this.externalSessionRefreshMs = nonNegativeInteger(
      config.externalSessionRefreshMs,
      DEFAULT_EXTERNAL_SESSION_REFRESH_MS
    );
    this.externalApprovalPollMs = Math.min(
      Math.max(
        positiveInteger(config.externalApprovalPollMs, DEFAULT_EXTERNAL_APPROVAL_POLL_MS),
        2000
      ),
      3000
    );
    this.externalApprovalLastScanAt = 0;
    this.externalApprovalLastScanDurationMs = 0;
    this.externalApprovalLastScanError = "";
    this.externalApprovalLastErrorAt = 0;
    this.externalApprovalLastDiscoveryRoute = "";
    this.externalApprovalLastCheckedSessionCount = 0;
    this.externalApprovalLastPendingCount = 0;
    if (options.monitorExternalApprovals !== false) this.startExternalApprovalMonitor();
  }

  async health() {
    const data = await this.client.health();
    if (this.wsClient?.isConfigured?.() && stripHermesPrefix(this.config.ws?.sessionId)) {
      this.observeConfiguredWsSession().catch((error) => this.recordHermesWsError(error));
    }
    return {
      source: this.source,
      ok: data?.status === "ok",
      status: data?.status === "ok" ? "connected" : "degraded",
      details: {
        ...data,
        capabilities: this.capabilities(),
        control: {
          externalApproval: this.externalApprovalDiagnostics(),
          websocket: this.wsDiagnostics()
        }
      }
    };
  }

  capabilities() {
    return [
      "health",
      "auth",
      "profiles",
      "sessions",
      "new-session",
      "prompt",
      "stream",
      "stop",
      "approve",
      "deny",
      "models",
      "tasks",
      ...(this.wsClient?.isConfigured?.() ? ["tui-websocket", "session-resume"] : []),
      ...(this.bridgeReceiver?.health?.().enabled ? ["gateway-events", "gateway-approvals"] : [])
    ];
  }

  async preflight() {
    const checks = [
      { name: "auth-status", routes: [`${this.config.apiPrefix}/auth/status`], auth: false },
      { name: "profiles", routes: [`${this.config.apiPrefix}/profiles`] },
      { name: "sessions", routes: [`${this.config.apiPrefix}/sessions/search?limit=1`, `${this.config.apiPrefix}/sessions`] },
      { name: "models", routes: [`${this.config.apiPrefix}/models`] },
      { name: "kanban", routes: [`${this.config.apiPrefix}/kanban/boards`, `${this.config.apiPrefix}/kanban/tasks?status=all&sort=updated`] },
      { name: "chat", method: "POST", routes: [`${this.config.apiPrefix}/chat/start`, `${this.config.apiPrefix}/chat`], safe: false, reason: "write-required" },
      { name: "stream", method: "GET", routes: [`${this.config.apiPrefix}/chat/stream`], safe: false, reason: "stream-id-required" },
      { name: "cancel", method: "GET", routes: [`${this.config.apiPrefix}/chat/cancel`], safe: false, reason: "stream-id-required" },
      { name: "approvals", method: "GET", routes: [`${this.config.apiPrefix}/approval/pending`], safe: false, reason: "session-id-required" },
      { name: "approval-respond", method: "POST", routes: [`${this.config.apiPrefix}/approval/respond`], safe: false, reason: "write-required" }
    ];
    const results = await Promise.all(checks.map(async (check) => {
      if (check.safe === false) {
        return { ...check, ok: null, tested: false, status: "not-tested", error: null };
      }
      try {
        const result = await this.client.firstJson(check.routes, { auth: check.auth !== false });
        return { ...check, ok: true, tested: true, status: "available", route: result.route };
      } catch (error) {
        return { ...check, ok: false, tested: true, status: "unavailable", error: error.message };
      }
    }));
    return { source: this.source, checkedAt: new Date().toISOString(), results };
  }

  wsDiagnostics() {
    return {
      ...(this.wsClient?.describe?.() || {
        transport: "hermes-tui/websocket",
        configured: false,
        connected: false,
        pendingRequests: 0
      }),
      activeSessionId: this.wsActiveSessionId || null,
      configuredSessionId: stripHermesPrefix(this.config.ws?.sessionId) || null,
      observedSessionId: this.wsObservedSessionId || null,
      activeTaskCount: [...this.wsSessions.values()].filter((state) => !state.terminalPublished).length,
      lastError: this.hermesWsLastError || null,
      lastErrorAt: this.hermesWsLastErrorAt ? new Date(this.hermesWsLastErrorAt).toISOString() : null
    };
  }

  recordHermesWsError(error, options = {}) {
    const message = String(error?.message || error || "Hermes TUI WebSocket error").slice(0, 300);
    if (message === this.hermesWsLastError) return;
    this.hermesWsLastError = message;
    this.hermesWsLastErrorAt = Date.now();
    if (options.publish === false) return;
    this.eventBus?.publish({
      source: this.source,
      type: "runtime.error",
      payload: { transport: "websocket", method: "hermes-tui", error: message }
    });
  }

  async observeConfiguredWsSession() {
    const sessionId = stripHermesPrefix(this.config.ws?.sessionId);
    if (!sessionId || !this.wsClient?.isConfigured?.()) return undefined;
    if (this.wsObservedSessionId === sessionId && this.wsClient.isConnected?.()) return sessionId;
    if (this.wsObservationPromise) return this.wsObservationPromise;

    this.wsObservationPromise = (async () => {
      const resumed = await this.wsClient.request("session.resume", { session_id: sessionId });
      const canonicalSessionId = sessionIdFromResumeResult(resumed) || sessionId;
      this.wsObservedSessionId = canonicalSessionId;
      this.wsActiveSessionId = canonicalSessionId;
      return canonicalSessionId;
    })().catch((error) => {
      this.wsObservedSessionId = undefined;
      throw error;
    }).finally(() => {
      this.wsObservationPromise = undefined;
    });

    return this.wsObservationPromise;
  }

  externalApprovalDiagnostics() {
    return {
      lastScanAt: this.externalApprovalLastScanAt ? new Date(this.externalApprovalLastScanAt).toISOString() : null,
      lastScanDurationMs: this.externalApprovalLastScanDurationMs,
      lastScanError: this.externalApprovalLastScanError || null,
      lastErrorAt: this.externalApprovalLastErrorAt ? new Date(this.externalApprovalLastErrorAt).toISOString() : null,
      lastDiscoveryRoute: this.externalApprovalLastDiscoveryRoute || null,
      pollingMode: "active-sessions-only",
      pollIntervalMs: this.externalApprovalPollMs,
      checkedSessionCount: this.externalApprovalLastCheckedSessionCount,
      pendingCount: this.externalApprovalLastPendingCount,
      cachedApprovalCount: this.externalApprovals.size
    };
  }

  async listAgents() {
    const result = await this.client.firstJson([
      `${this.config.apiPrefix}/profiles`,
      "/profiles"
    ]);
    const agents = toHermesAgents(result.data);
    this.eventBus.publish({
      source: this.source,
      type: "agent.discovered",
      payload: { route: result.route, count: agents.length }
    });
    return agents;
  }

  async listTasks() {
    let result;
    let tasks;

    try {
      result = await this.client.firstJson([
        `${this.config.apiPrefix}/kanban/tasks?status=all&sort=updated`,
        "/kanban/tasks?status=all&sort=updated",
        `${this.config.apiPrefix}/tasks`,
        "/tasks"
      ]);
      tasks = toHermesTasks(result.data);

      // The WebUI Kanban is historical state. Always compare it with /health:
      // a direct WSL/CLI run can be visible there before it appears in Kanban,
      // while a stale Kanban card must not keep the deck in RUNNING forever.
      try {
        const health = await this.client.health();
        const liveTasks = toHermesTasks(health).filter(isLiveTask);
        if (liveTasks.length) {
          tasks = mergeLiveTasks(tasks, liveTasks);
          result = { ...result, route: `${result.route}+/health` };
        } else if (isExplicitIdleHealth(health)) {
          const reconciled = reconcileStaleActiveTasks(tasks, Date.now());
          if (reconciled !== tasks) {
            tasks = reconciled;
            result = { ...result, route: `${result.route}+/health:idle` };
          }
        }
      } catch {
        // Keep the Kanban snapshot when the extra live probe is unavailable.
      }
    } catch (error) {
      const health = await this.client.health();
      result = { route: "/health:runs", data: health };
      tasks = toHermesTasks(health);
    }

    this.eventBus.publish({
      source: this.source,
      type: "ui.data.refreshed",
      payload: { section: "tasks", route: result.route, count: tasks.length }
    });
    return tasks;
  }

  async listWorkers() {
    return [];
  }

  async listApprovals() {
    const bridgeApprovals = this.bridgeReceiver?.listApprovals?.() || [];
    // A bridge approval must never suppress the WebUI scan. Hermes OS Cat can
    // have a pending approval in a different WebUI session at the same time.
    const externalScan = this.scanExternalApprovals();
    if (!bridgeApprovals.length) await externalScan;
    else externalScan.catch(() => {});
    const byId = new Map([...this.externalApprovals.values()].map((approval) => [approval.id, approval]));
    for (const approval of bridgeApprovals) byId.set(approval.id, approval);
    return [...byId.values()]
      .sort((left, right) => Date.parse(right.requestedAt || 0) - Date.parse(left.requestedAt || 0));
  }

  async listConversations() {
    const result = await this.client.firstJson([
      `${this.config.apiPrefix}/sessions/search?limit=50`,
      "/sessions/search?limit=50",
      `${this.config.apiPrefix}/sessions`,
      "/sessions",
      `${this.config.apiPrefix}/conversations`,
      "/conversations"
    ]);
    const conversations = toHermesConversations(result.data);
    const wsSessionId = this.wsActiveSessionId || stripHermesPrefix(this.config.ws?.sessionId);
    if (this.wsClient?.isConfigured?.() && wsSessionId) {
      const tuiConversationId = `hermes:${wsSessionId}`;
      const existing = conversations.find((conversation) => conversation.id === tuiConversationId);
      if (existing) {
        existing.title = existing.title || "Live TUI session";
        existing.metadata = {
          ...existing.metadata,
          transport: "websocket",
          surface: "tui",
          mode: "tui",
          wsSessionId,
          liveTui: true,
          selected: true
        };
      } else {
        conversations.unshift({
          id: tuiConversationId,
          source: "hermes",
          title: "Live TUI session",
          taskIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: {
            transport: "websocket",
            surface: "tui",
            mode: "tui",
            wsSessionId,
            liveTui: true,
            selected: true
          }
        });
      }
    }
    return conversations;
  }

  async startTask(input) {
    const message = input.prompt || input.title;
    if (!message) throw new Error("Hermes task requires prompt or title.");
    const response = await this.sendMessage({
      source: this.source,
      content: message,
      conversationId: input.conversationId,
      metadata: input.metadata
    });

    return {
      id: `hermes:chat:${Date.now()}`,
      source: this.source,
      agentId: `hermes:${this.config.profile}`,
      conversationId: response.conversationId,
      title: message.slice(0, 80),
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: response.metadata
    };
  }

  async cancelTask(taskId) {
    const wsState = this.findWsTask(taskId);
    if (wsState) {
      try {
        await this.cancelWsTask(wsState);
      } catch (error) {
        if (!/method|unknown|not found|unsupported/i.test(String(error?.message || ""))) throw error;
        await this.wsClient.request("session.stop", { session_id: wsState.sessionId });
      }
      this.finalizeWsTask(wsState, "cancelled", { reason: "user_requested" });
      return { ok: true, taskId: wsState.taskId, sessionId: wsState.sessionId, transport: "websocket" };
    }

    const requestedStreamId = streamIdFromTaskId(taskId);
    const streamId = requestedStreamId || this.activeStreamId;
    if (!streamId) return { ok: true, metadata: { noop: true } };

    const state = this.streamStates.get(streamId);
    if (requestedStreamId && !state && requestedStreamId !== this.activeStreamId) {
      return { ok: true, streamId, metadata: { noop: true, stale: true } };
    }
    if (state) state.cancelRequested = true;

    try {
      await this.client.request(`${this.config.apiPrefix}/chat/cancel?stream_id=${encodeURIComponent(streamId)}`);
    } catch (error) {
      if (state) state.cancelRequested = false;
      throw error;
    }

    this.finalizeStream(state || {
      streamId,
      sessionId: this.activeSessionId,
      terminalPublished: false
    }, {
      type: "task.completed",
      taskId,
      payload: { status: "cancelled", streamId }
    });
    return { ok: true, streamId };
  }

  async sendMessage(input) {
    const content = input.content || input.prompt || input.message;
    if (!content) throw new Error("Hermes message is empty.");

    const reasoning = normalizeReasoning(input.reasoning);
    if (this.wsClient?.isConfigured?.()) {
      try {
        return await this.sendMessageViaWebSocket(input, content, reasoning);
      } catch (error) {
        if (!(error instanceof HermesWsError) || !error.beforeSend) throw error;
        this.recordHermesWsError(error, { publish: false });
        // The existing HTTP/SSE path remains the safe fallback when the
        // optional TUI transport cannot accept the request before sending it.
      }
    }

    return this.sendMessageViaHttp(input, content, reasoning);
  }

  async sendMessageViaHttp(input, content, reasoning) {
    const sessionId = await this.ensureSession(input.conversationId, { transport: "http" });
    const model = this.config.model;

    const payload = {
      session_id: sessionId,
      message: content,
      profile: this.config.profile,
      ...reasoningPayload(reasoning),
      ...(model ? { model, explicit_model_pick: true } : {})
    };

    const result = await this.startHermesChat(payload);

    const streamId = result?.stream_id || result?.active_stream_id;
    this.activeStreamId = streamId;

    this.eventBus.publish({
      source: this.source,
      type: "conversation.message.created",
      conversationId: `hermes:${sessionId}`,
      payload: { role: "user", content, sessionId, streamId, reasoning }
    });

    if (streamId) {
      this.followChatStream(streamId, sessionId);
    } else if (result) {
      this.eventBus.publish({
        source: this.source,
        type: "conversation.message.created",
        conversationId: `hermes:${sessionId}`,
        payload: { role: "assistant", result }
      });
    }

    return {
      id: `hermes-message:${Date.now()}`,
      conversationId: `hermes:${sessionId}`,
      source: this.source,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
      metadata: { result, sessionId, streamId, reasoning }
    };
  }

  async getConversation(conversationId) {
    const conversations = await this.listConversations();
    return conversations.find((conversation) => conversation.id === conversationId);
  }

  async decideApproval(input) {
    const bridgeApproval = this.resolveBridgeApproval(input);
    if (bridgeApproval && ["pending", "decision_queued"].includes(bridgeApproval.status)) {
      const sessionApproval = input.approvalScope === "session"
        || String(input.approvalDecision || "").toLowerCase() === "acceptforsession";
      const choice = input.decision === "approve" ? (sessionApproval ? "session" : "once") : "deny";
      const decision = this.bridgeReceiver.queueDecision({
        approvalId: bridgeApproval.id,
        choice,
        reason: input.reason
      });
      this.eventBus.publish({
        source: this.source,
        type: "task.progress",
        conversationId: bridgeApproval.sessionId ? `hermes:${bridgeApproval.sessionId}` : undefined,
        taskId: bridgeApproval.taskId ? `hermes:bridge:${bridgeApproval.taskId}` : undefined,
        payload: {
          status: "waiting_approval",
          message: `approval ${choice} queued for Hermes gateway`,
          approvalId: bridgeApproval.id,
          decisionId: decision.id
        }
      });
      return {
        id: bridgeApproval.id,
        source: this.source,
        title: bridgeApproval.command || "Hermes gateway approval",
        body: bridgeApproval.question || "",
        status: "pending",
        requestedAt: bridgeApproval.requestedAt,
        metadata: {
          transport: "gateway_bridge",
          decisionId: decision.id,
          decisionStatus: decision.status,
          choice,
          duplicate: decision.duplicate
        }
      };
    }

    // A bridge id must never fall through to the WebUI resolver. The bridge
    // and WebUI approval stores are independent, so doing that turns a stale
    // or late click into a misleading successful no-op.
    if (isBridgeApprovalId(input.approvalId)) {
      return {
        id: input.approvalId,
        source: this.source,
        title: "No pending Hermes gateway approval",
        body: "Hermes is no longer waiting for this approval.",
        status: "idle",
        requestedAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(),
        metadata: { noop: true, transport: "gateway_bridge", reason: "approval_not_pending" }
      };
    }

    const knownSessionId = input.approvalId ? this.pendingApprovalSessions.get(input.approvalId) : undefined;
    const sessionId = await this.ensureSession(
      input.conversationId || (knownSessionId ? `hermes:${knownSessionId}` : undefined),
      { transport: "http" }
    );
    const cachedApproval = input.approvalId ? this.externalApprovals.get(input.approvalId) : undefined;
    let approval = cachedApproval || (input.approvalId && !input.approvalId.startsWith("hermes:approval:")
      ? { id: input.approvalId }
      : await this.findPendingApproval(sessionId));

    if (!approval?.id) {
      return {
        id: input.approvalId || `hermes:approval:none:${Date.now()}`,
        source: this.source,
        title: "No pending Hermes approval",
        body: "Hermes is not waiting for approval right now.",
        status: "idle",
        requestedAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(),
        metadata: { noop: true, sessionId }
      };
    }

    const sessionApproval = input.approvalScope === "session"
      || String(input.approvalDecision || "").toLowerCase() === "acceptforsession";
    const choice = input.decision === "approve" ? (sessionApproval ? "session" : "once") : "deny";
    const decisionResult = await this.sendApprovalDecision(approval, sessionId, choice);
    const result = decisionResult.result;
    const resolvedApprovalId = decisionResult.approvalId || approval.id;
    await this.settleStreamAfterApproval(approval);
    this.externalApprovals.delete(approval.id);
    this.pendingApprovalSessions.delete(approval.id);

    this.eventBus.publish({
      source: this.source,
      type: "approval.resolved",
      conversationId: `hermes:${sessionId}`,
      payload: { approvalId: resolvedApprovalId, requestedApprovalId: approval.id, choice, result }
    });

    return {
      id: resolvedApprovalId,
      source: this.source,
      title: "Hermes approval",
      body: input.reason ?? "",
      status: input.decision === "approve" ? "approved" : "rejected",
      requestedAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(),
      metadata: { result, sessionId, choice }
    };
  }

  resolveBridgeApproval(input = {}) {
    const receiver = this.bridgeReceiver;
    if (!receiver) return undefined;

    const explicitId = String(input.approvalId || "").trim();
    const explicit = explicitId ? receiver.getApproval?.(explicitId) : undefined;
    if (explicit && ["pending", "decision_queued"].includes(explicit.status)) return explicit;

    const pending = receiver.listApprovals?.() || [];
    if (!pending.length) return undefined;

    const conversationId = normalizeHermesConversationId(input.conversationId);
    const matching = conversationId
      ? pending.filter((approval) => bridgeApprovalMatchesConversation(approval, conversationId))
      : pending;
    if (matching.length === 1) {
      return receiver.getApproval?.(matching[0].id) || matching[0];
    }
    if (matching.length > 1) {
      const error = new Error("Multiple Hermes approvals are pending; select the active task first.");
      error.statusCode = 409;
      error.code = "approval_selection_ambiguous";
      throw error;
    }
    if (pending.length === 1) {
      return receiver.getApproval?.(pending[0].id) || pending[0];
    }
    if (explicitId && pending.some((approval) => approval.id === explicitId)) {
      return receiver.getApproval?.(explicitId) || pending.find((approval) => approval.id === explicitId);
    }
    return undefined;
  }

  async sendApprovalDecision(approval, sessionId, choice) {
    const runApprovalRoute = approval?.metadata?.approvalProtocol === "run"
      ? approval.metadata.responseRoute
      : undefined;
    if (runApprovalRoute) {
      try {
        return {
          result: await this.client.request(runApprovalRoute, {
            method: "POST",
            body: { choice }
          }),
          approvalId: approval.id
        };
      } catch (error) {
        // A stream id is not necessarily a /v1/runs id on older WebUI builds.
        // If Hermes exposes the real pending id through the legacy WebUI route,
        // use that contract instead of treating a 404 as a successful click.
        const pending = await this.findPendingApprovalWithRetry(sessionId);
        if (!pending?.id) throw error;
        return {
          result: await this.respondToPendingApproval(pending, sessionId, choice),
          approvalId: pending.id
        };
      }
    }

    if (approval?.metadata?.approvalProtocol === "webui-stream") {
      const pending = await this.findPendingApprovalWithRetry(sessionId);
      if (!pending?.id) {
        // Some WebUI builds emit the approval SSE frame without an id and do
        // not expose the same pending item through /api/approval/pending. The
        // stable session-scoped WebUI contract is still able to resolve the
        // active approval with only session_id + choice.
        return {
          result: await this.respondToSessionApproval(sessionId, choice),
          approvalId: approval.id
        };
      }
      return {
        result: await this.respondToPendingApproval(pending, sessionId, choice),
        approvalId: pending.id
      };
    }

    return {
      result: await this.respondToPendingApproval(approval, sessionId, choice),
      approvalId: approval.id
    };
  }

  async respondToPendingApproval(approval, sessionId, choice) {
    return this.client.request(`${this.config.apiPrefix}/approval/respond`, {
      method: "POST",
      body: {
        session_id: approval.sessionId || sessionId,
        approval_id: approval.id,
        choice
      }
    });
  }

  async respondToSessionApproval(sessionId, choice) {
    return this.client.request(`${this.config.apiPrefix}/approval/respond`, {
      method: "POST",
      body: { session_id: sessionId, choice }
    });
  }

  async findPendingApprovalWithRetry(sessionId) {
    const retryDelays = [0, 100, 250, 500];
    let pending;
    for (let index = 0; index < retryDelays.length; index += 1) {
      if (retryDelays[index] > 0) await delay(retryDelays[index]);
      try {
        pending = await this.findPendingApproval(sessionId, { publish: false });
      } catch {
        pending = undefined;
      }
      if (pending?.id) return pending;
    }
    return undefined;
  }

  async runAction(action, payload = {}) {
    if (action === "capabilities" || action === "preflight") return this.preflight();
    if (action === "status") return this.health();
    if (action === "agents") return this.listAgents();
    if (action === "tasks" || action === "kanban") return this.listTasks();
    if (action === "sessions") return this.listConversations();
    if (action === "metrics") {
      const result = await this.client.firstJson([
        `${this.config.apiPrefix}/system/metrics`,
        "/system/metrics",
        "/health"
      ], { auth: action !== "status" });
      this.eventBus.publish(toMetricEvent(this.source, result.data));
      return result.data;
    }
    if (action === "models") {
      const result = await this.client.firstJson([
        `${this.config.apiPrefix}/models`,
        `${this.config.apiPrefix}/v1/models`,
        "/models"
      ]);
      this.eventBus.publish({
        source: this.source,
        type: "agent.discovered",
        payload: { route: result.route }
      });
      return result.data;
    }
    if (action === "events") {
      return this.eventBus.list(50).filter((event) => event.source === this.source);
    }
    if (action === "new-task") {
      this.activeSessionId = undefined;
      const sessionId = await this.ensureSession();
      const content = payload.prompt || payload.title;
      if (content) {
        return this.sendMessage({
          ...payload,
          content,
          conversationId: `hermes:${sessionId}`
        });
      }
      return { ok: true, sessionId, conversationId: `hermes:${sessionId}` };
    }
    if (action === "continue") {
      return this.sendMessage({
        ...payload,
        content: payload.prompt || payload.title || "Continue."
      });
    }
    if (action === "stop") {
      return this.cancelTask(payload.taskId || `hermes:stream:${this.activeStreamId || "active"}`);
    }
    if (action === "send") return this.sendMessage(payload);
    if (action === "approve" || action === "reject") {
      return this.decideApproval({
        source: this.source,
        approvalId: payload.approvalId || `hermes:approval:${Date.now()}`,
        decision: action === "approve" ? "approve" : "reject",
        approvalDecision: payload.approvalDecision,
        approvalScope: payload.approvalScope,
        reason: payload.reason,
        conversationId: payload.conversationId
      });
    }
    throw new Error(`Unknown Hermes action: ${action}`);
  }

  async sendMessageViaWebSocket(input, content, reasoning) {
    let promptAttempted = false;
    let state;
    try {
      const sessionId = await this.ensureSession(input.conversationId, { transport: "websocket" });
      const taskId = `hermes:ws:${sessionId}:${Date.now()}`;
      const now = new Date().toISOString();
      state = {
        taskId,
        sessionId,
        conversationId: `hermes:${sessionId}`,
        title: content.slice(0, 80),
        createdAt: now,
        updatedAt: now,
        waitingApproval: false,
        pendingApprovalId: undefined,
        taskPublished: false,
        terminalPublished: false
      };
      this.wsSessions.set(taskId, state);
      this.publishWsTaskStarted(state, content, reasoning);

      promptAttempted = true;
      const result = await this.wsClient.request("prompt.submit", {
        session_id: sessionId,
        text: content
      });
      return {
        id: `hermes-message:${Date.now()}`,
        conversationId: state.conversationId,
        source: this.source,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
        metadata: {
          result,
          sessionId,
          taskId,
          transport: "websocket",
          reasoning
        }
      };
    } catch (error) {
      const safeToFallback = error instanceof HermesWsError && error.beforeSend;
      if (state && safeToFallback) {
        // No prompt reached Hermes. Close the visible provisional task before
        // the HTTP/SSE fallback so a failed WS connect cannot leave RUNNING behind.
        this.finalizeWsTask(state, "failed", {
          error: String(error?.message || error || "Hermes TUI WebSocket unavailable"),
          fallback: true
        });
      } else if (state && !state.terminalPublished) {
        // The request was sent or failed after the transport accepted it; keep
        // the failure visible and close the task instead of leaking WS state.
        this.finalizeWsTask(state, "failed", {
          error: String(error?.message || error || "Hermes TUI prompt failed")
        });
      }
      if (!promptAttempted && error instanceof HermesWsError) error.beforeSend = true;
      throw error;
    }
  }

  publishWsTaskStarted(state, content, reasoning, options = {}) {
    if (!state || state.taskPublished || state.terminalPublished) return false;
    state.taskPublished = true;
    this.eventBus.publish({
      source: this.source,
      type: "task.created",
      taskId: state.taskId,
      agentId: `hermes:${this.config.profile}`,
      conversationId: state.conversationId,
      payload: {
        id: state.taskId,
        source: this.source,
        agentId: `hermes:${this.config.profile}`,
        conversationId: state.conversationId,
        title: state.title,
        status: "running",
        progress: 10,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        metadata: { transport: "websocket", wsSessionId: state.sessionId, reasoning }
      }
    });
    if (options.publishUserMessage !== false) {
      this.eventBus.publish({
        source: this.source,
        type: "conversation.message.created",
        conversationId: state.conversationId,
        taskId: state.taskId,
        payload: { role: "user", content, sessionId: state.sessionId, reasoning, transport: "websocket" }
      });
    }
    return true;
  }

  findWsTask(taskId) {
    const requested = String(taskId || "");
    const exact = this.wsSessions.get(requested);
    if (exact && !exact.terminalPublished) return exact;
    return [...this.wsSessions.values()]
      .reverse()
      .find((state) => !state.terminalPublished && (
        !requested
        || requested === "hermes:stream:active"
        || requested === "hermes:stream:"
        || requested === state.taskId
      ));
  }

  findWsSession(sessionId) {
    const normalized = String(sessionId || "");
    const exact = [...this.wsSessions.values()]
      .reverse()
      .find((state) => !state.terminalPublished && state.sessionId === normalized);
    if (exact) return exact;
    const active = [...this.wsSessions.values()].filter((state) => !state.terminalPublished);
    return active.length === 1 ? active[0] : undefined;
  }

  async cancelWsTask(state) {
    if (!this.wsClient?.isConfigured?.()) throw new Error("Hermes TUI WebSocket is not configured.");
    await this.wsClient.request("prompt.cancel", { session_id: state.sessionId });
  }

  finalizeWsTask(state, status, payload = {}) {
    if (!state || state.terminalPublished) return false;
    state.terminalPublished = true;
    state.waitingApproval = false;
    state.updatedAt = new Date().toISOString();
    this.wsSessions.delete(state.taskId);
    const terminalType = ["failed", "error"].includes(status) ? "task.failed" : "task.completed";
    this.eventBus.publish({
      source: this.source,
      type: terminalType,
      taskId: state.taskId,
      conversationId: state.conversationId,
      payload: {
        ...payload,
        status,
        transport: "websocket",
        taskId: state.taskId,
        sessionId: state.sessionId
      }
    });
    return true;
  }

  handleHermesWsEvent(message) {
    const params = message?.params || {};
    const eventType = String(params.type || message?.type || "").toLowerCase();
    const rawPayload = params.payload ?? params.data ?? {};
    const payload = rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
      ? rawPayload
      : { value: rawPayload };
    if (eventType === "gateway.ready") return;

    const sessionId = String(
      payload.session_id
      ?? payload.sessionId
      ?? params.session_id
      ?? params.sessionId
      ?? payload.session?.session_id
      ?? this.wsActiveSessionId
      ?? ""
    );
    let state = this.findWsSession(sessionId);
    if (!state && isWsActivityEvent(eventType)) {
      state = this.ensureObservedWsTask(sessionId, eventType);
    }
    if (!state) return;

    const eventPayload = {
      ...payload,
      event: eventType,
      transport: "websocket",
      sessionId: state.sessionId,
      taskId: state.taskId
    };
    const text = wsTextFromPayload(payload);

    if (["message.delta", "message.token", "assistant.delta"].includes(eventType)) {
      this.eventBus.publish({
        source: this.source,
        type: "conversation.message.created",
        taskId: state.taskId,
        conversationId: state.conversationId,
        payload: {
          ...eventPayload,
          role: "assistant",
          content: text,
          delta: text,
          event: "token"
        }
      });
      return;
    }

    if (["reasoning.delta", "thinking.delta"].includes(eventType)) {
      this.publishWsProgress(state, eventType.startsWith("reasoning") ? "reasoning" : "thinking", text, eventPayload);
      return;
    }

    if (["tool.call", "tool.result", "tool.start", "tool.progress", "tool.complete"].includes(eventType)) {
      this.eventBus.publish({
        source: this.source,
        type: "worker.updated",
        taskId: state.taskId,
        conversationId: state.conversationId,
        payload: { ...eventPayload, status: eventType === "tool.result" ? "completed" : "working", message: text }
      });
      return;
    }

    if (["approval.requested", "approval.request", "approval.required", "approval.pending"].includes(eventType)) {
      state.waitingApproval = true;
      state.pendingApprovalId = payload.approval_id ?? payload.approvalId ?? payload.id;
      this.publishWsProgress(
        state,
        "waiting_approval",
        "approval required - choose ALLOW or DENY",
        { ...eventPayload, approvalRequested: true }
      );
      this.captureWsApproval(state, payload).catch((error) => this.recordHermesWsError(error));
      return;
    }

    if (isWsTerminalEvent(eventType)) {
      this.finalizeWsTask(state, "completed", eventPayload);
      return;
    }

    if (["error", "runtime.error", "session.error"].includes(eventType)) {
      this.finalizeWsTask(state, "failed", { ...eventPayload, error: text || "Hermes TUI reported an error." });
      return;
    }

    this.publishWsProgress(state, "running", text || `Hermes TUI event: ${eventType}`, eventPayload);
  }

  ensureObservedWsTask(sessionId, eventType) {
    const normalized = String(
      sessionId
      || this.wsActiveSessionId
      || stripHermesPrefix(this.config.ws?.sessionId)
      || ""
    );
    if (!normalized) return undefined;
    const existing = this.findWsSession(normalized);
    if (existing) return existing;

    const now = new Date().toISOString();
    const state = {
      taskId: `hermes:ws:${normalized}:observed:${Date.now()}`,
      sessionId: normalized,
      conversationId: `hermes:${normalized}`,
      title: "Observed Hermes TUI activity",
      createdAt: now,
      updatedAt: now,
      waitingApproval: false,
      pendingApprovalId: undefined,
      taskPublished: false,
      terminalPublished: false,
      observed: true,
      firstEventType: eventType
    };
    this.wsSessions.set(state.taskId, state);
    this.wsActiveSessionId = normalized;
    this.publishWsTaskStarted(state, "", undefined, { publishUserMessage: false });
    return state;
  }

  publishWsProgress(state, status, message, payload = {}) {
    if (!state || state.terminalPublished) return;
    state.updatedAt = new Date().toISOString();
    this.eventBus.publish({
      source: this.source,
      type: "task.progress",
      taskId: state.taskId,
      conversationId: state.conversationId,
      payload: { ...payload, status, message, transport: "websocket" }
    });
  }

  async captureWsApproval(state, eventData = {}) {
    let pending;
    try {
      pending = await this.findPendingApproval(state.sessionId, { publish: false });
    } catch {
      pending = undefined;
    }
    if (!pending?.id) return undefined;
    const approval = approvalFromPending(state.sessionId, {
      approval_id: pending.id,
      command: pending.command || eventData.command || "Hermes command approval",
      question: pending.question || eventData.question || "Allow Hermes to continue?",
      session_id: pending.sessionId || state.sessionId
    }, {
      route: `${this.config.apiPrefix}/approval/respond`
    });
    approval.metadata = {
      ...approval.metadata,
      transport: "websocket",
      wsSessionId: state.sessionId,
      wsTaskId: state.taskId,
      approvalProtocol: "webui-stream"
    };
    const existing = this.externalApprovals.get(approval.id);
    this.pendingApprovalSessions.set(approval.id, state.sessionId);
    this.externalApprovals.set(approval.id, existing ? {
      ...approval,
      requestedAt: existing.requestedAt,
      metadata: { ...approval.metadata, ...existing.metadata }
    } : approval);
    if (!existing) {
      this.eventBus.publish({
        source: this.source,
        type: "approval.requested",
        taskId: state.taskId,
        conversationId: state.conversationId,
        payload: approval
      });
    }
    state.pendingApprovalId = approval.id;
    return approval;
  }

  async startHermesChat(payload) {
    const bodies = hasReasoningPayload(payload) ? [payload, stripReasoningPayload(payload)] : [payload];
    let lastError;

    for (let index = 0; index < bodies.length; index += 1) {
      const body = bodies[index];
      try {
        return await this.client.request(`${this.config.apiPrefix}/chat/start`, {
          method: "POST",
          body,
          timeoutMs: Math.max(this.config.timeoutMs, 10000)
        });
      } catch (startError) {
        lastError = startError;
        const canRetryWithoutReasoning = index === 0
          && bodies.length > 1
          && shouldRetryWithoutReasoning(startError);
        if (!isUnavailableChatStart(startError)) {
          if (canRetryWithoutReasoning) continue;
          break;
        }
        try {
          const result = await this.client.request(`${this.config.apiPrefix}/chat`, {
            method: "POST",
            body,
            timeoutMs: Math.max(this.config.timeoutMs, 20000)
          });
          if (result && typeof result === "object") {
            result.fallback_from_chat_start = startError.message;
          }
          return result;
        } catch (chatError) {
          lastError = chatError;
          const canRetryFallbackWithoutReasoning = index === 0
            && bodies.length > 1
            && shouldRetryWithoutReasoning(startError, chatError);
          if (!canRetryFallbackWithoutReasoning) break;
        }
      }
    }

    throw lastError;
  }

  async *subscribeEvents() {
    yield {
      id: `hermes-subscribe:${Date.now()}`,
      source: this.source,
      type: "runtime.connected",
      timestamp: new Date().toISOString(),
      payload: { mode: "local-event-bus" }
    };
  }

  async ensureSession(conversationId, options = {}) {
    const useWebSocket = options.transport !== "http" && this.wsClient?.isConfigured?.();
    const explicitSessionId = stripHermesPrefix(conversationId);
    if (explicitSessionId) {
      if (useWebSocket && this.wsActiveSessionId !== explicitSessionId) {
        const resumed = await this.wsClient.request("session.resume", { session_id: explicitSessionId });
        this.wsActiveSessionId = sessionIdFromResumeResult(resumed) || explicitSessionId;
      }
      return this.setActiveSessionId(this.wsActiveSessionId || explicitSessionId);
    }

    if (useWebSocket) {
      if (this.wsActiveSessionId) {
        this.setActiveSessionId(this.wsActiveSessionId);
        return this.wsActiveSessionId;
      }

      const configuredSessionId = stripHermesPrefix(this.config.ws?.sessionId);
      let sessionId = configuredSessionId;
      if (sessionId) {
        const resumed = await this.wsClient.request("session.resume", { session_id: sessionId });
        sessionId = sessionIdFromResumeResult(resumed) || sessionId;
      } else {
        const created = await this.wsClient.request("session.create", {
          cols: this.config.gateway?.cols || 120,
          title: "Control Deck"
        });
        sessionId = created?.session_id || created?.session?.session_id;
      }
      if (!sessionId) throw new Error("Hermes TUI did not return session_id.");
      this.wsActiveSessionId = String(sessionId);
      this.setActiveSessionId(this.wsActiveSessionId);
      this.eventBus.publish({
        source: this.source,
        type: "conversation.created",
        conversationId: `hermes:${this.wsActiveSessionId}`,
        payload: { sessionId: this.wsActiveSessionId, transport: "websocket" }
      });
      return this.wsActiveSessionId;
    }

    if (this.activeSessionId) return this.activeSessionId;

    const session = await this.client.request(`${this.config.apiPrefix}/session/new`, {
      method: "POST",
      body: {
        profile: this.config.profile,
        ...(this.config.model ? { model: this.config.model } : {})
      }
    });

    const sessionId = session?.session?.session_id || session?.session_id;
    if (!sessionId) {
      throw new Error("Hermes did not return session_id from /api/session/new.");
    }

    this.setActiveSessionId(sessionId);
    this.eventBus.publish({
      source: this.source,
      type: "conversation.created",
      conversationId: `hermes:${sessionId}`,
      payload: { sessionId }
    });
    return this.activeSessionId;
  }

  setActiveSessionId(sessionId) {
    const next = sessionId ? String(sessionId) : undefined;
    if (next !== this.activeSessionId) this.externalApprovalLastScanAt = 0;
    this.activeSessionId = next;
    return this.activeSessionId;
  }

  async findPendingApproval(sessionId, options = {}) {
    const data = await this.client.request(`${this.config.apiPrefix}/approval/pending?session_id=${encodeURIComponent(sessionId)}`);
    const pending = pendingFromResponse(data);
    if (!pending) return undefined;

    if (options.publish !== false) {
      this.eventBus.publish({
        source: this.source,
        type: "approval.requested",
        conversationId: `hermes:${sessionId}`,
        payload: pending
      });
    }

    return {
      id: String(pending.approval_id),
      command: pending.command,
      question: pending.question,
      sessionId: pending.session_id || sessionId
    };
  }

  async captureStreamApproval(state, eventData = {}) {
    let pending;
    try {
      pending = await this.findPendingApproval(state.sessionId, { publish: false });
    } catch {
      // The stream event is still authoritative enough to surface a run-level
      // approval when the legacy pending endpoint is unavailable.
    }

    const eventApprovalId = eventData?.approval_id ?? eventData?.approvalId ?? eventData?.id;
    const explicitRunId = eventData?.run_id ?? eventData?.runId;
    const runId = explicitRunId ? String(explicitRunId) : undefined;
    const command = eventData?.command ?? eventData?.args?.command ?? "Hermes command approval";
    const question = eventData?.question ?? eventData?.description ?? `Allow Hermes to run: ${command}`;
    const approval = pending?.id
      ? approvalFromPending(state.sessionId, {
        approval_id: pending.id,
        command: pending.command ?? command,
        question: pending.question ?? question,
        session_id: pending.sessionId || state.sessionId
      }, {
        route: `${this.config.apiPrefix}/approval/pending`,
        streamId: state.streamId,
        runId
      })
      : eventApprovalId
        ? approvalFromPending(state.sessionId, {
          approval_id: eventApprovalId,
          command,
          question,
          session_id: state.sessionId
        }, {
          route: `${this.config.apiPrefix}/approval/respond`,
          streamId: state.streamId,
          runId
        })
        : {
          id: `hermes:run:${runId || state.streamId}`,
          source: this.source,
          conversationId: `hermes:${state.sessionId}`,
          title: String(command),
          body: String(question),
          status: "pending",
          requestedAt: new Date().toISOString(),
          metadata: {
            ...eventData,
            sessionId: state.sessionId,
            externalSession: true,
            approvalProtocol: runId ? "run" : "webui-stream",
            responseMethod: "POST",
            ...(runId ? {
              responseRoute: `/v1/runs/${encodeURIComponent(runId)}/approval`,
              runId
            } : {}),
            streamId: state.streamId
          }
        };
    const existing = this.externalApprovals.get(approval.id);
    this.pendingApprovalSessions.set(approval.id, state.sessionId);
    state.waitingApproval = true;
    state.pendingApprovalId = approval.id;
    this.externalApprovals.set(
      approval.id,
      existing ? {
        ...approval,
        requestedAt: existing.requestedAt,
        metadata: { ...approval.metadata, ...existing.metadata }
      } : approval
    );
    return approval;
  }

  async settleStreamAfterApproval(approval) {
    const wsTaskId = approval?.metadata?.wsTaskId;
    if (wsTaskId) {
      const wsState = this.wsSessions.get(wsTaskId);
      if (wsState && !wsState.terminalPublished) {
        wsState.waitingApproval = false;
        wsState.pendingApprovalId = undefined;
        wsState.updatedAt = new Date().toISOString();
      }
    }

    const streamId = approval?.metadata?.streamId;
    if (!streamId) return;
    const state = this.streamStates.get(streamId);
    if (!state || state.terminalPublished) return;

    state.waitingApproval = false;
    state.pendingApprovalId = undefined;
    const backend = await this.probeStreamState(streamId, state.sessionId);
    if (backend.reported && !backend.active) {
      this.finalizeStream(state, {
        type: "task.completed",
        payload: {
          status: "completed",
          streamId,
          event: "approval_resolved",
          synthetic: true,
          reason: "approval_resolved_backend_inactive"
        }
      });
      return;
    }

    // The approval can close the original SSE connection while the backend
    // continues the run. Reattach it so the deck receives the remaining
    // output instead of staying on a stale RUNNING state.
    state.reconnects = 0;
    state.promise = this.consumeChatStream(state);
  }

  startExternalApprovalMonitor() {
    if (this.externalApprovalTimer) return;
    this.externalApprovalTimer = setInterval(() => {
      this.scanExternalApprovals().catch((error) => this.recordExternalApprovalScanError(error));
    }, this.externalApprovalPollMs);
    this.externalApprovalTimer.unref?.();
    this.scanExternalApprovals().catch((error) => this.recordExternalApprovalScanError(error));
  }

  async scanExternalApprovals() {
    if (this.externalApprovalScanPromise) return this.externalApprovalScanPromise;
    if (
      this.externalApprovalLastScanAt
      && Date.now() - this.externalApprovalLastScanAt < this.externalApprovalPollMs
    ) {
      return [...this.externalApprovals.values()];
    }
    const startedAt = Date.now();
    this.externalApprovalScanPromise = this.performExternalApprovalScan()
      .then((result) => {
        this.externalApprovalLastScanAt = Date.now();
        this.externalApprovalLastScanDurationMs = Date.now() - startedAt;
        this.externalApprovalLastScanError = "";
        return result;
      })
      .catch((error) => {
        this.externalApprovalLastScanAt = Date.now();
        this.externalApprovalLastScanDurationMs = Date.now() - startedAt;
        this.recordExternalApprovalScanError(error);
        return [...this.externalApprovals.values()];
      });
    try {
      return await this.externalApprovalScanPromise;
    } finally {
      this.externalApprovalScanPromise = undefined;
    }
  }

  recordExternalApprovalScanError(error) {
    const message = String(error?.message || error || "Hermes external approval scan failed").slice(0, 300);
    const changed = message !== this.externalApprovalLastScanError;
    this.externalApprovalLastScanError = message;
    this.externalApprovalLastErrorAt = Date.now();
    if (!changed) return;
    this.eventBus.publish({
      source: this.source,
      type: "runtime.error",
      payload: { method: "externalApprovalScan", error: message }
    });
  }

  async performExternalApprovalScan() {
    let healthSessionIds = [];
    let healthRuns = [];
    try {
      const health = await this.client.request("/health", {
        auth: false,
        timeoutMs: Math.min(this.config.timeoutMs, 1500)
      });
      healthSessionIds = sessionIdsFromHealth(health);
      healthRuns = Array.isArray(health?.runs) ? health.runs : [];
    } catch {
      // Bridge and already tracked approval sessions remain usable during
      // a transient health probe failure.
    }

    // Only poll sessions that are demonstrably active or already have a
    // pending approval. Historical session discovery caused one pending
    // request per stored session on every scan (50 requests per second with
    // the old 1s timer), even when Hermes was idle.
    const activeWsSessionIds = [...this.wsSessions.values()]
      .filter((state) => !state.terminalPublished)
      .map((state) => state.sessionId);
    // The Deck's selected HTTP session is the only idle session worth
    // checking. This preserves WebUI approvals that can appear before a
    // stream id exists without returning to historical-session fan-out.
    const activeHttpSessionIds = this.activeSessionId ? [this.activeSessionId] : [];
    const sessionIds = [...new Set([
      ...this.pendingApprovalSessions.values(),
      ...activeHttpSessionIds,
      ...activeWsSessionIds,
      ...healthSessionIds,
    ].filter(Boolean))];
    const runRecords = healthRuns
      .map((run) => ({
        runId: run?.run_id ?? run?.runId ?? run?.stream_id ?? run?.streamId ?? run?.id,
        sessionId: run?.session_id
          ?? run?.sessionId
          ?? run?.conversation_id
          ?? run?.conversationId
      }))
      .filter((run) => run.runId)
      .map((run) => ({ ...run, runId: String(run.runId), sessionId: run.sessionId ? String(run.sessionId) : undefined }))
      .filter((run, index, values) => values.findIndex((candidate) => candidate.runId === run.runId) === index);
    if (!sessionIds.length && !runRecords.length) return [...this.externalApprovals.values()];

    const sessionResults = await Promise.allSettled(sessionIds.map(async (sessionId) => {
      const data = await this.client.request(
        `${this.config.apiPrefix}/approval/pending?session_id=${encodeURIComponent(sessionId)}`,
        { timeoutMs: Math.min(this.config.timeoutMs, 2500) }
      );
      return { sessionId, pending: pendingFromResponse(data), route: `${this.config.apiPrefix}/approval/pending` };
    }));

    const runResults = await Promise.allSettled(runRecords.map(async ({ runId, sessionId }) => {
      const routes = [
        `${this.config.apiPrefix}/runs/${encodeURIComponent(runId)}/approval`,
        `${this.config.apiPrefix}/v1/runs/${encodeURIComponent(runId)}/approval`,
        `/v1/runs/${encodeURIComponent(runId)}/approval`,
        `/runs/${encodeURIComponent(runId)}/approval`
      ];
      for (const route of routes) {
        try {
          const data = await this.client.request(route, { timeoutMs: Math.min(this.config.timeoutMs, 2500) });
          const pending = pendingFromResponse(data);
          if (pending) {
            return {
              sessionId: pending.session_id || pending.sessionId || sessionId || runId,
              pending,
              route,
              runId
            };
          }
        } catch {
          // Try the next known Hermes approval route for this run.
        }
      }
      return { sessionId: sessionId || runId, pending: undefined, route: "", runId };
    }));

    const results = [...sessionResults, ...runResults];
    this.externalApprovalLastCheckedSessionCount = results.length;

    const checkedSessionIds = new Set();
    const seenIds = new Set();
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      checkedSessionIds.add(result.value.sessionId);
      if (!result.value.pending?.approval_id) continue;
      const { sessionId, pending, route, runId } = result.value;
      const approval = approvalFromPending(sessionId, pending, { route, runId });
      seenIds.add(approval.id);
      this.pendingApprovalSessions.set(approval.id, sessionId);
      const existing = this.externalApprovals.get(approval.id);
      this.externalApprovals.set(approval.id, existing ? {
        ...approval,
        requestedAt: existing.requestedAt,
        metadata: { ...approval.metadata, ...existing.metadata }
      } : approval);
      if (!existing) {
        this.eventBus.publish({
          source: this.source,
          type: "approval.requested",
          conversationId: approval.conversationId,
          payload: approval
        });
      }
    }

    for (const [approvalId, approval] of this.externalApprovals) {
      const sessionId = this.pendingApprovalSessions.get(approvalId);
      if (checkedSessionIds.has(sessionId) && !seenIds.has(approvalId)) {
        const streamId = approval.metadata?.streamId;
        const activeStream = streamId ? this.streamStates.get(streamId) : undefined;
        if (approval.metadata?.approvalProtocol && activeStream && !activeStream.terminalPublished) {
          continue;
        }
        await this.settleStreamAfterApproval(approval);
        this.externalApprovals.delete(approvalId);
        this.pendingApprovalSessions.delete(approvalId);
        this.eventBus.publish({
          source: this.source,
          type: "approval.resolved",
          conversationId: approval.conversationId,
          payload: { approvalId, status: "resolved", external: true }
        });
      }
    }

    this.externalApprovalLastPendingCount = this.externalApprovals.size;
    return [...this.externalApprovals.values()];
  }

  async discoverExternalSessionIds() {
    const now = Date.now();
    if (now - this.externalSessionDiscoveredAt < this.externalSessionRefreshMs) {
      return this.externalSessionIds;
    }
    if (this.externalSessionDiscoveryPromise) return this.externalSessionDiscoveryPromise;

    this.externalSessionDiscoveryPromise = (async () => {
      const limit = this.externalSessionLimit;
      const routes = [
        `${this.config.apiPrefix}/sessions/search?limit=${limit}`,
        `${this.config.apiPrefix}/sessions?limit=${limit}`,
        `${this.config.apiPrefix}/conversations?limit=${limit}`,
        `/sessions/search?limit=${limit}`,
        `/sessions?limit=${limit}`,
        `/conversations?limit=${limit}`
      ];
      const errors = [];
      for (const route of routes) {
        try {
          const data = await this.client.request(route);
          const ids = sessionIdsFromList(data).slice(0, limit);
          if (ids.length) {
            this.externalSessionIds = ids;
            this.externalSessionDiscoveredAt = Date.now();
            this.externalApprovalLastDiscoveryRoute = route;
            return this.externalSessionIds;
          }
        } catch (error) {
          errors.push(`${route}: ${error.message}`);
        }
      }
      if (errors.length === routes.length) throw new Error(errors.join(" | "));
      this.externalSessionIds = [];
      this.externalSessionDiscoveredAt = Date.now();
      this.externalApprovalLastDiscoveryRoute = "empty session list";
      return this.externalSessionIds;
    })();

    try {
      return await this.externalSessionDiscoveryPromise;
    } finally {
      this.externalSessionDiscoveryPromise = undefined;
    }
  }

  followChatStream(streamId, sessionId) {
    const existing = this.streamStates.get(streamId);
    if (existing && !existing.terminalPublished) return existing.promise;

    const state = {
      streamId,
      sessionId,
      cancelRequested: false,
      terminalPublished: false,
      waitingApproval: false,
      pendingApprovalId: undefined,
      reconnects: 0,
      promise: undefined
    };
    this.streamStates.set(streamId, state);
    state.promise = this.consumeChatStream(state);
    return state.promise;
  }

  async consumeChatStream(state) {
    const route = `${this.config.apiPrefix}/chat/stream?stream_id=${encodeURIComponent(state.streamId)}`;

    while (!state.terminalPublished) {
      let streamError;
      try {
        await this.client.streamSse(route, async (event) => {
          if (state.terminalPublished) return;
          const terminal = ["done", "stream_end", "apperror"].includes(event.event);
          const input = {
            source: this.source,
            type: mapChatEventType(event.event),
            conversationId: `hermes:${state.sessionId}`,
            payload: {
              streamId: state.streamId,
              event: event.event,
              data: event.data,
              ...(state.cancelRequested && terminal ? { status: "cancelled" } : {})
            },
            raw: event.raw
          };

          if (event.event === "approval") {
            try {
              const approval = await this.captureStreamApproval(state, event.data);
              if (approval) {
                input.payload = {
                  ...input.payload,
                  approvalId: approval.id,
                  approval
                };
              }
            } catch (error) {
              this.recordExternalApprovalScanError(error);
            }
          }

          if (terminal) this.finalizeStream(state, input);
          else this.eventBus.publish(input);
        });
      } catch (error) {
        streamError = error;
      }

      if (state.terminalPublished || state.cancelRequested) return;
      if (state.waitingApproval) {
        this.eventBus.publish({
          source: this.source,
          type: "task.progress",
          conversationId: `hermes:${state.sessionId}`,
          payload: {
            status: "waiting_approval",
            streamId: state.streamId,
            approvalId: state.pendingApprovalId
          }
        });
        return;
      }
      const backend = await this.probeStreamState(state.streamId, state.sessionId);
      if (backend.active && state.reconnects < this.streamReconnectAttempts) {
        state.reconnects += 1;
        this.eventBus.publish({
          source: this.source,
          type: "task.progress",
          conversationId: `hermes:${state.sessionId}`,
          payload: {
            status: "reconnecting",
            streamId: state.streamId,
            attempt: state.reconnects,
            maxAttempts: this.streamReconnectAttempts
          }
        });
        await delay(this.streamReconnectBackoffMs * state.reconnects);
        continue;
      }

      if (backend.active) {
        this.finalizeStream(state, {
          type: "runtime.error",
          payload: {
            status: "failed",
            streamId: state.streamId,
            error: `Hermes stream reconnect limit reached after ${state.reconnects} attempt(s).`
          }
        });
        return;
      }

      if (!backend.reported || streamError) {
        this.finalizeStream(state, {
          type: "runtime.error",
          payload: {
            status: "failed",
            streamId: state.streamId,
            error: streamError?.message || backend.error?.message || "Hermes stream state could not be verified."
          }
        });
        return;
      }

      this.finalizeStream(state, {
        type: "task.completed",
        payload: {
          status: "completed",
          streamId: state.streamId,
          event: "stream_end",
          synthetic: true,
          reason: "sse_eof_backend_inactive"
        }
      });
      return;
    }
  }

  async probeStreamState(streamId, sessionId) {
    try {
      const data = await this.client.request(
        `${this.config.apiPrefix}/session?session_id=${encodeURIComponent(sessionId)}`,
        { timeoutMs: Math.min(this.config.timeoutMs, 2500) }
      );
      const session = data?.session || data;
      const reportedStreamId = session?.active_stream_id ?? session?.activeStreamId;
      return {
        reported: true,
        active: session?.is_streaming === true && String(reportedStreamId || "") === String(streamId)
      };
    } catch (error) {
      return { reported: false, active: false, error };
    }
  }

  finalizeStream(state, input) {
    if (state.terminalPublished) return false;
    state.terminalPublished = true;
    if (this.activeStreamId === state.streamId) this.activeStreamId = undefined;
    this.streamStates.delete(state.streamId);
    this.eventBus.publish({
      source: this.source,
      conversationId: state.sessionId ? `hermes:${state.sessionId}` : undefined,
      ...input
    });
    return true;
  }
}

function pendingFromResponse(data) {
  const pending = data?.pending || data?.approval || data?.approval_request
    || (data && typeof data === "object" && (data.approval_id || data.approvalId || data.id) ? data : undefined);
  if (!pending || typeof pending !== "object") return undefined;
  const approvalId = pending.approval_id ?? pending.approvalId ?? pending.id;
  if (!approvalId) return undefined;
  return {
    ...pending,
    approval_id: String(approvalId),
    session_id: pending.session_id ?? pending.sessionId
  };
}

function approvalFromPending(sessionId, pending, options = {}) {
  const resolvedSessionId = pending.session_id || pending.sessionId || sessionId;
  return {
    id: String(pending.approval_id),
    source: "hermes",
    conversationId: resolvedSessionId ? `hermes:${resolvedSessionId}` : undefined,
    title: pending.command ? String(pending.command) : "Hermes approval",
    body: pending.question ? String(pending.question) : String(pending.command ?? ""),
    status: "pending",
    requestedAt: new Date().toISOString(),
    metadata: {
      ...pending,
      sessionId: resolvedSessionId,
      externalSession: true,
      responseRoute: options.route || undefined,
      runId: options.runId,
      streamId: options.streamId
    }
  };
}

function sessionIdsFromHealth(health) {
  if (!health || typeof health !== "object") return [];
  const runSessionIds = (Array.isArray(health.runs) ? health.runs : [])
    .map((run) => run?.session_id
      ?? run?.sessionId
      ?? run?.conversation_id
      ?? run?.conversationId)
    .filter(Boolean)
    .map(String);
  const topLevelSessionId = health.active_session_id
    ?? health.activeSessionId
    ?? health.session_id
    ?? health.sessionId;
  return [...new Set([
    ...(topLevelSessionId ? [String(topLevelSessionId)] : []),
    ...runSessionIds
  ])];
}

function isLiveTask(task) {
  return ["running", "working", "thinking", "in_progress", "waiting_approval"]
    .includes(String(task?.status || "").toLowerCase());
}

function isExplicitIdleHealth(health) {
  if (!health || typeof health !== "object") return false;
  const status = String(health.status || "").toLowerCase();
  if (status && !["ok", "idle", "ready"].includes(status)) return false;

  const activeRuns = Number(health.active_runs ?? health.activeRuns);
  if (Number.isFinite(activeRuns)) return activeRuns === 0;
  return Array.isArray(health.runs) && health.runs.length === 0;
}

function reconcileStaleActiveTasks(tasks, now) {
  let changed = false;
  const reconciled = tasks.map((task) => {
    const status = String(task?.status || "").toLowerCase();
    // Never infer a decision for approvals. They require the real approval
    // snapshot and must remain visible until Hermes resolves or expires them.
    if (!["running", "working", "thinking", "in_progress"].includes(status)) return task;

    const updatedAt = Date.parse(task.updatedAt || task.createdAt || "");
    if (!Number.isFinite(updatedAt) || now - updatedAt < HERMES_STALE_ACTIVE_TASK_GRACE_MS) return task;

    changed = true;
    return {
      ...task,
      status: "completed",
      progress: task.progress === undefined ? 100 : task.progress,
      updatedAt: new Date(now).toISOString(),
      metadata: {
        ...task.metadata,
        lastActivity: "Hermes reports no active run",
        reconciledFrom: status,
        reconciledAt: new Date(now).toISOString()
      }
    };
  });
  return changed ? reconciled : tasks;
}

function mergeLiveTasks(tasks, liveTasks) {
  const merged = [...tasks];
  for (const liveTask of liveTasks) {
    const liveRunId = liveTask.metadata?.run_id
      ?? liveTask.metadata?.runId
      ?? liveTask.metadata?.id;
    const index = merged.findIndex((task) => {
      const taskRunId = task.metadata?.run_id
        ?? task.metadata?.runId
        ?? task.metadata?.bridgeRunId;
      return (liveRunId && taskRunId && String(liveRunId) === String(taskRunId))
        || (liveTask.conversationId && task.conversationId === liveTask.conversationId && isLiveTask(task));
    });
    if (index >= 0) merged[index] = liveTask;
    else merged.push(liveTask);
  }
  return merged;
}

function sessionIdsFromList(data) {
  const rows = [];
  const visit = (value, depth = 0) => {
    if (depth > 3 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      rows.push(...value);
      return;
    }
    if (typeof value !== "object") return;
    for (const key of ["sessions", "conversations", "items", "data", "results"]) {
      if (value[key] !== undefined) visit(value[key], depth + 1);
    }
  };
  visit(data);

  return rows
    .map((row) => {
      if (typeof row === "string" || typeof row === "number") {
        return { id: String(row), updatedAt: "" };
      }
      if (!row || typeof row !== "object") return undefined;
      const id = row.session_id ?? row.sessionId ?? row.conversation_id ?? row.conversationId ?? row.id;
      return id ? { id: String(id), updatedAt: row.updated_at ?? row.updatedAt ?? row.created_at ?? row.createdAt ?? "" } : undefined;
    })
    .filter(Boolean)
    .sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0))
    .map((row) => row.id)
    .filter((id, index, values) => values.indexOf(id) === index);
}

function stripHermesPrefix(value) {
  if (!value) return undefined;
  return String(value).replace(/^hermes:/, "");
}

function sessionIdFromResumeResult(result) {
  const value = result?.session_id
    ?? result?.sessionId
    ?? result?.session?.session_id
    ?? result?.session?.sessionId;
  return value ? String(value) : "";
}

function isBridgeApprovalId(value) {
  return /^hermes-approval:/.test(String(value || "").trim());
}

function normalizeHermesConversationId(value) {
  return stripHermesPrefix(String(value || "").trim()) || "";
}

function bridgeApprovalMatchesConversation(approval, normalizedConversationId) {
  return [
    approval?.conversationId,
    approval?.sessionId,
    approval?.metadata?.sessionId
  ].some((candidate) => normalizeHermesConversationId(candidate) === normalizedConversationId);
}

function normalizeReasoning(value) {
  const normalized = String(value || "").toLowerCase();
  return ["low", "med", "high", "xhigh"].includes(normalized) ? normalized : undefined;
}

function reasoningPayload(reasoning) {
  if (!reasoning) return {};
  return {
    reasoning,
    reasoning_level: reasoning,
    reasoning_effort: reasoning,
    effort: reasoning
  };
}

function hasReasoningPayload(payload) {
  return Boolean(payload?.reasoning || payload?.reasoning_level || payload?.reasoning_effort || payload?.effort);
}

function stripReasoningPayload(payload) {
  const stripped = { ...payload };
  delete stripped.reasoning;
  delete stripped.reasoning_level;
  delete stripped.reasoning_effort;
  delete stripped.effort;
  return stripped;
}

function shouldRetryWithoutReasoning(...errors) {
  return errors.some((error) => /(?:\b400\b|\b422\b|unknown|unexpected|extra|validation)/i.test(error?.message || ""));
}

function isUnavailableChatStart(error) {
  return /(?:\b404\b|\b405\b|\b501\b|not found|method not allowed|not implemented)/i.test(error?.message || "");
}

function mapChatEventType(eventName) {
  if (eventName === "approval") return "approval.requested";
  if (eventName === "done" || eventName === "stream_end") return "task.completed";
  if (eventName === "apperror") return "task.failed";
  if (eventName === "token") return "conversation.message.created";
  if (eventName === "tool" || eventName === "tool_complete") return "worker.updated";
  return "task.progress";
}

function wsTextFromPayload(payload) {
  const value = payload?.text
    ?? payload?.delta
    ?? payload?.content
    ?? payload?.message
    ?? payload?.detail
    ?? payload?.output;
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isWsTerminalEvent(eventType) {
  return [
    "session.prompt_complete",
    "session.turn_complete",
    "session.complete",
    "turn.complete",
    "prompt.complete",
    "message.complete",
    "message.end",
    "assistant.complete",
    "session.turn_completed",
    "turn.completed",
    "prompt.completed"
  ].includes(eventType);
}

function isWsActivityEvent(eventType) {
  return [
    "message.start",
    "message.delta",
    "message.token",
    "assistant.delta",
    "reasoning.delta",
    "thinking.delta",
    "tool.call",
    "tool.result",
    "tool.start",
    "tool.progress",
    "tool.complete",
    "status.update",
    "approval.request",
    "approval.requested",
    "approval.required",
    "approval.pending"
  ].includes(eventType);
}

function streamIdFromTaskId(taskId) {
  const match = /^hermes:stream:(.+)$/.exec(String(taskId || ""));
  return match?.[1];
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
