import { HermesApiClient } from "./HermesApiClient.mjs";
import { toHermesAgents, toHermesConversations, toHermesTasks, toMetricEvent } from "./HermesEventMapper.mjs";

export class HermesRuntimeAdapter {
  constructor(config, eventBus) {
    this.source = "hermes";
    this.config = config;
    this.client = new HermesApiClient(config);
    this.eventBus = eventBus;
    this.activeSessionId = undefined;
    this.activeStreamId = undefined;
  }

  async health() {
    const data = await this.client.health();
    return {
      source: this.source,
      ok: data?.status === "ok",
      status: data?.status === "ok" ? "connected" : "degraded",
      details: { ...data, capabilities: this.capabilities() }
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
      "tasks"
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
        return {
          ...check,
          ok: null,
          tested: false,
          status: "not-tested",
          error: null
        };
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

  async listAgents() {
    const result = await this.client.firstJson([`${this.config.apiPrefix}/profiles`]);
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
        `${this.config.apiPrefix}/kanban/tasks?status=all&sort=updated`
      ]);
      tasks = toHermesTasks(result.data);
    } catch (error) {
      const health = await this.client.health();
      result = { route: "/health:runs", data: health };
      tasks = toHermesTasks({
        runs: health?.runs || [],
        active_runs: health?.active_runs,
        last_run_finished_at: health?.last_run_finished_at
      });
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
    const sessionId = this.activeSessionId;
    if (!sessionId) return [];

    const data = await this.client.request(`${this.config.apiPrefix}/approval/pending?session_id=${encodeURIComponent(sessionId)}`);
    const pending = data?.pending;
    if (!pending) return [];

    return [
      {
        id: String(pending.approval_id),
        source: this.source,
        conversationId: `hermes:${sessionId}`,
        title: pending.command ? String(pending.command) : "Hermes approval",
        body: pending.question ? String(pending.question) : String(pending.command ?? ""),
        status: "pending",
        requestedAt: new Date().toISOString(),
        metadata: pending
      }
    ];
  }

  async listConversations() {
    const result = await this.client.firstJson([
      `${this.config.apiPrefix}/sessions/search?limit=50`,
      `${this.config.apiPrefix}/sessions`
    ]);
    return toHermesConversations(result.data);
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
    const streamId = this.activeStreamId;
    if (!streamId) return { ok: true, metadata: { noop: true } };
    await this.client.request(`${this.config.apiPrefix}/chat/cancel?stream_id=${encodeURIComponent(streamId)}`);
    if (this.activeStreamId === streamId) this.activeStreamId = undefined;
    this.eventBus.publish({
      source: this.source,
      type: "task.completed",
      taskId,
      conversationId: this.activeSessionId ? `hermes:${this.activeSessionId}` : undefined,
      payload: { status: "cancelled", streamId }
    });
    return { ok: true, streamId };
  }

  async sendMessage(input) {
    const content = input.content || input.prompt || input.message;
    if (!content) throw new Error("Hermes message is empty.");
    if (String(content).length > this.config.maxPromptChars) throw new Error("Hermes prompt exceeds configured limit.");

    const sessionId = await this.ensureSession(input.conversationId);
    const model = this.config.model;
    const reasoning = normalizeReasoning(input.reasoning);

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
    const sessionId = await this.ensureSession(input.conversationId);
    const approval = input.approvalId && !input.approvalId.startsWith("hermes:approval:")
      ? { id: input.approvalId }
      : await this.findPendingApproval(sessionId);

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
    const result = await this.client.request(`${this.config.apiPrefix}/approval/respond`, {
      method: "POST",
      body: {
        session_id: sessionId,
        approval_id: approval.id,
        choice
      }
    });

    this.eventBus.publish({
      source: this.source,
      type: "approval.resolved",
      conversationId: `hermes:${sessionId}`,
      payload: { approvalId: approval.id, choice, result }
    });

    return {
      id: approval.id,
      source: this.source,
      title: "Hermes approval",
      body: input.reason ?? "",
      status: input.decision === "approve" ? "approved" : "rejected",
      requestedAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(),
      metadata: { result, sessionId, choice }
    };
  }

  async runAction(action, payload = {}) {
    if (action === "status") return this.health();
    if (action === "capabilities" || action === "preflight") return this.preflight();
    if (action === "agents") return this.listAgents();
    if (action === "tasks" || action === "kanban") return this.listTasks();
    if (action === "sessions") return this.listConversations();
    if (action === "metrics") {
      const result = await this.client.firstJson([
        `${this.config.apiPrefix}/system/metrics`,
        `${this.config.apiPrefix}/system/health`,
        `${this.config.apiPrefix}/health/agent`,
        "/health"
      ], { auth: action !== "status" });
      this.eventBus.publish(toMetricEvent(this.source, result.data));
      return result.data;
    }
    if (action === "models") {
      const result = await this.client.firstJson([
        `${this.config.apiPrefix}/models`
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
        reason: payload.reason
      });
    }
    throw new Error(`Unknown Hermes action: ${action}`);
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
          const canRetryWithoutReasoning = index === 0
            && bodies.length > 1
            && shouldRetryWithoutReasoning(startError, chatError);
          if (!canRetryWithoutReasoning) break;
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

  async ensureSession(conversationId) {
    const explicitSessionId = stripHermesPrefix(conversationId);
    if (explicitSessionId) {
      this.activeSessionId = explicitSessionId;
      return explicitSessionId;
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

    this.activeSessionId = String(sessionId);
    this.eventBus.publish({
      source: this.source,
      type: "conversation.created",
      conversationId: `hermes:${sessionId}`,
      payload: { sessionId }
    });
    return this.activeSessionId;
  }

  async findPendingApproval(sessionId) {
    const data = await this.client.request(`${this.config.apiPrefix}/approval/pending?session_id=${encodeURIComponent(sessionId)}`);
    const pending = data?.pending;
    if (!pending) return undefined;

    this.eventBus.publish({
      source: this.source,
      type: "approval.requested",
      conversationId: `hermes:${sessionId}`,
      payload: pending
    });

    return {
      id: String(pending.approval_id),
      command: pending.command,
      question: pending.question
    };
  }

  followChatStream(streamId, sessionId) {
    this.client.streamSse(`${this.config.apiPrefix}/chat/stream?stream_id=${encodeURIComponent(streamId)}`, async (event) => {
      this.eventBus.publish({
        source: this.source,
        type: mapChatEventType(event.event),
        conversationId: `hermes:${sessionId}`,
        payload: {
          streamId,
          event: event.event,
          data: event.data
        },
        raw: event.raw
      });
      if (
        this.activeStreamId === streamId
        && ["done", "stream_end", "apperror"].includes(event.event)
      ) {
        this.activeStreamId = undefined;
      }
    }).catch((error) => {
      if (this.activeStreamId === streamId) this.activeStreamId = undefined;
      this.eventBus.publish({
        source: this.source,
        type: "runtime.error",
        conversationId: `hermes:${sessionId}`,
        payload: { streamId, error: error.message }
      });
    });
  }
}

function stripHermesPrefix(value) {
  if (!value) return undefined;
  return String(value).replace(/^hermes:/, "");
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

function mapChatEventType(eventName) {
  if (eventName === "approval") return "approval.requested";
  if (eventName === "done" || eventName === "stream_end") return "task.completed";
  if (eventName === "apperror") return "task.failed";
  if (eventName === "token") return "conversation.message.created";
  if (eventName === "tool" || eventName === "tool_complete") return "worker.updated";
  return "task.progress";
}
