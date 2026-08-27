import { normalizeTaskStatus } from "../../domain/events.mjs";
import { CodexDesktopBridge } from "./CodexDesktopBridge.mjs";
import { toCodexAgents, toCodexApprovals, toCodexConversations, toCodexTasks } from "./CodexEventMapper.mjs";
import { CodexSessionObserver } from "./CodexSessionObserver.mjs";

export class CodexRuntimeAdapter {
  constructor(config, eventBus) {
    this.source = "codex";
    this.config = config;
    this.client = undefined;
    this.cli = undefined;
    this.appServer = undefined;
    this.desktopBridge = config.mode !== "api" && config.desktopEnabled
      ? new CodexDesktopBridge(config, {
          onEvent: (event) => this.handleDesktopBridgeEvent(event)
        })
      : undefined;
    this.sessionObserver = config.mode !== "api" && config.desktopEnabled
      ? new CodexSessionObserver(config)
      : undefined;
    this.eventBus = eventBus;
    this.tasks = [];
    this.conversations = [];
    this.approvals = [];
    this.appServerApprovals = new Map();
    this.appThreadTasks = new Map();
    this.appTurnTasks = new Map();
    this.sessionApprovalPolicyOverride = undefined;
    this.activeSurface = normalizeCodexSurface(config.surface || config.mode || "cli");
    this.activeAppThreadId = undefined;
    this.selectedAppThreadId = undefined;
    this.activeAppTurnId = undefined;
    this.activeSessionId = undefined;
    this.activeStreamId = undefined;
    this.latestSessionObserverSnapshot = undefined;
    this.desktopBridgeReady = false;
    this.desktopBridgeLastState = undefined;
    this.desktopNewTaskDrafts = new Map();
    this.desktopIdleObservations = new Map();
    this.desktopBridgeOfflineReported = false;
    this.desktopMonitor = this.desktopBridge
      ? setInterval(() => this.pollDesktopBridge(), 1000)
      : undefined;
    this.desktopMonitor?.unref?.();
    this.sessionMonitor = this.sessionObserver
      ? setInterval(() => this.pollSessionObserver(), 1000)
      : undefined;
    this.sessionMonitor?.unref?.();
  }

  async health(surface = this.activeSurface) {
    if (this.client) {
      const data = await this.client.health();
      return {
        source: this.source,
        ok: true,
        status: "connected",
        details: {
          mode: this.config.mode,
          baseUrl: this.config.baseUrl,
          data
        }
      };
    }

    if (this.cli || this.appServer || this.desktopBridge) {
      const cliAvailable = this.cli?.isAvailable() || false;
      const appServerAvailable = this.appServer?.isAvailable() || false;
      const appServerConnected = this.appServer?.describe()?.connected || false;
      const nativeDesktopConnected = this.desktopBridge?.isConnected() || false;
      const observed = this.sessionObserver?.snapshot();
      const desktopAvailable = nativeDesktopConnected;
      const desktopConnected = nativeDesktopConnected;
      const activeSurface = normalizeCodexSurface(surface);
      const ok = activeSurface === "desktop" ? desktopAvailable : cliAvailable;
      return {
        source: this.source,
        ok,
        status: ok ? "connected" : "offline",
        details: {
          mode: this.cli && desktopAvailable ? "hybrid" : (this.cli ? "cli" : "desktop"),
          activeSurface,
          surfaces: {
            cli: this.cli ? this.cli.describe() : { available: false },
            desktop: {
              available: desktopAvailable,
              connected: desktopConnected,
              mechanism: nativeDesktopConnected
                ? "codex-desktop-cdp"
                : "native-cdp-disconnected",
              hiddenAppServerAvailable: appServerAvailable,
              hiddenAppServerConnected: appServerConnected,
              appServer: this.appServer?.describe() || { available: false },
              nativeBridge: this.desktopBridge?.describe() || { available: false },
              observer: this.sessionObserver?.describe() || { available: false },
              observed
            }
          },
          sessionApprovalPolicyOverride: this.sessionApprovalPolicyOverride
        }
      };
    }

    return {
      source: this.source,
      ok: true,
      status: "connected",
      details: {
        mode: this.config.mode,
        note: "Codex adapter is a local stub in milestone 1."
      }
    };
  }

  async listAgents() {
    if (this.client) {
      const result = await this.client.firstJson([
        `${this.config.apiPrefix}/profiles`,
        "/profiles"
      ]);
      const agents = toCodexAgents(result.data);
      this.eventBus.publish({
        source: this.source,
        type: "agent.discovered",
        payload: { route: result.route, count: agents.length }
      });
      return agents;
    }

    if (this.cli || this.appServer || this.desktopBridge) {
      const cliAvailable = this.cli?.isAvailable() || false;
      const observed = this.sessionObserver?.snapshot();
      const desktopAvailable = this.desktopBridge?.isConnected() || false;
      const activeSurface = normalizeCodexSurface(this.activeSurface);
      const activeAvailable = activeSurface === "desktop" ? desktopAvailable : cliAvailable;
      const desktopWorking = Boolean(
        this.desktopBridge?.lastSnapshot?.working
        || this.desktopBridge?.lastSnapshot?.waitingApproval
        || observed?.working
        || observed?.waitingApproval
      );
      const working = activeSurface === "desktop"
        ? desktopWorking
        : this.tasks.some((task) => ["running", "queued", "waiting_approval"].includes(task.status));
      return [
        {
          id: "codex:local",
          source: this.source,
          displayName: desktopAvailable ? "Codex Desktop + CLI" : "Codex CLI",
          runtimeName: "Local Codex",
          model: this.config.model || "configured default",
          status: activeAvailable ? (working ? "working" : "idle") : "missing",
          capabilities: ["open", "new-task", "continue", "stop", "approve", "reject", "desktop", "cli"],
          metadata: {
            activeSurface: this.activeSurface,
            surfaces: {
              cli: this.cli ? this.cli.describe() : { available: false },
              desktop: {
                available: desktopAvailable,
                appServer: this.appServer?.describe(),
                nativeBridge: this.desktopBridge?.describe(),
                observed
              }
            },
            sessionApprovalPolicyOverride: this.sessionApprovalPolicyOverride
          },
          updatedAt: new Date().toISOString()
        }
      ];
    }

    return [
      {
        id: "codex:local",
        source: this.source,
        displayName: "Codex",
        runtimeName: "Local Codex",
        model: "local",
        status: "idle",
        capabilities: ["new-task", "continue", "stop", "approve", "reject"],
        metadata: { mode: this.config.mode },
        updatedAt: new Date().toISOString()
      }
    ];
  }

  async listTasks() {
    if (this.client) {
      const result = await this.client.firstJson([
        `${this.config.apiPrefix}/kanban/tasks?status=all&sort=updated`,
        `${this.config.apiPrefix}/tasks`,
        "/tasks"
      ]);
      return toCodexTasks(result.data);
    }

    if (this.sessionObserver) this.syncSessionObserverState(this.sessionObserver.snapshot());
    return this.tasks;
  }

  async listWorkers() {
    return [];
  }

  async listApprovals() {
    if (this.client) {
      const sessionId = this.activeSessionId;
      if (!sessionId) return [];
      const data = await this.client.request(`${this.config.apiPrefix}/approval/pending?session_id=${encodeURIComponent(sessionId)}`);
      return toCodexApprovals(data, sessionId);
    }

    return this.approvals;
  }

  async listConversations() {
    if (this.client) {
      const result = await this.client.firstJson([
        `${this.config.apiPrefix}/sessions/search?limit=50`,
        `${this.config.apiPrefix}/sessions`,
        "/sessions"
      ]);
      return toCodexConversations(result.data);
    }

    if (this.desktopBridge?.isConnected()) {
      try {
        await this.refreshDesktopConversations();
      } catch (error) {
        this.publishDesktopBridgeError(error);
      }
    } else if (this.appServer) {
      try {
        await this.refreshAppServerThreads();
      } catch (error) {
        this.publishAppServerError(error);
      }
    }

    return this.conversations;
  }

  async startTask(input) {
    this.assertNativeDesktopRequest(input);
    if (this.shouldUseDesktopBridge(input)) {
      const message = input.prompt || input.title;
      if (!message) throw new Error("Codex task requires prompt or title.");
      return (await this.startDesktopRun({
        content: message,
        title: input.title || message,
        conversationId: input.conversationId,
        resumeLast: input.resumeLast,
        clientId: input.clientId,
        reasoning: input.reasoning,
        approvalPolicy: input.approvalPolicy
      })).task;
    }

    if (this.shouldUseAppServer(input)) {
      const message = input.prompt || input.title;
      if (!message) throw new Error("Codex task requires prompt or title.");
      return (await this.startAppServerRun({
        content: message,
        title: input.title || message,
        resumeLast: input.resumeLast,
        clientId: input.clientId,
        reasoning: input.reasoning,
        approvalPolicy: input.approvalPolicy
      })).task;
    }

    if (this.cli) {
      const message = input.prompt || input.title;
      if (!message) throw new Error("Codex task requires prompt or title.");
      return this.startCliRun({
        content: message,
        title: input.title || message,
        resumeLast: input.resumeLast,
        reasoning: input.reasoning,
        approvalPolicy: input.approvalPolicy
      }).task;
    }

    if (this.client) {
      const message = input.prompt || input.title;
      if (!message) throw new Error("Codex task requires prompt or title.");
      const response = await this.sendApiMessage({
        source: this.source,
        content: message,
        conversationId: input.conversationId,
        reasoning: input.reasoning,
        metadata: input.metadata
      });

      return {
        id: `codex:chat:${Date.now()}`,
        source: this.source,
        agentId: `codex:${this.config.profile}`,
        conversationId: response.conversationId,
        title: message.slice(0, 80),
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: response.metadata
      };
    }

    const now = new Date().toISOString();
    const task = {
      id: `codex:task:${Date.now()}`,
      source: this.source,
      agentId: "codex:local",
      title: input.title || input.prompt || "Codex task",
      status: "queued",
      progress: 0,
      createdAt: now,
      updatedAt: now,
      metadata: {
        prompt: input.prompt,
        stub: true
      }
    };
    this.tasks.unshift(task);
    this.eventBus.publish({
      source: this.source,
      type: "task.created",
      taskId: task.id,
      agentId: task.agentId,
      payload: task
    });
    return task;
  }

  async cancelTask(taskId) {
    const appTask = this.findAppServerTask(taskId);
    if (appTask) return this.cancelAppServerTask(appTask.id);

    if (this.cli) {
      const task = this.tasks.find((item) => item.id === taskId) || this.tasks.find((item) => item.status === "running");
      if (!task) return { ok: true, message: "No Codex task to stop." };
      const stopped = this.cli.stop(task.id);
      task.status = "cancelled";
      task.updatedAt = new Date().toISOString();
      this.eventBus.publish({
        source: this.source,
        type: "task.completed",
        taskId: task.id,
        conversationId: task.conversationId,
        payload: { status: "cancelled", stopped }
      });
      return task;
    }

    if (this.client) {
      if (!this.activeStreamId) return;
      await this.client.request(`${this.config.apiPrefix}/chat/cancel?stream_id=${encodeURIComponent(this.activeStreamId)}`);
      this.eventBus.publish({
        source: this.source,
        type: "task.completed",
        taskId,
        conversationId: this.activeSessionId ? `codex:${this.activeSessionId}` : undefined,
        payload: { status: "cancelled", streamId: this.activeStreamId }
      });
      return;
    }

    const task = this.tasks.find((item) => item.id === taskId);
    if (task) {
      task.status = "cancelled";
      task.updatedAt = new Date().toISOString();
    }
    this.eventBus.publish({
      source: this.source,
      type: "task.completed",
      taskId,
      payload: { status: "cancelled" }
    });
  }

  async sendMessage(input) {
    this.assertNativeDesktopRequest(input);
    if (this.shouldUseDesktopBridge(input)) {
      return (await this.startDesktopRun({
        content: input.content || input.prompt || input.message,
        title: input.content || input.prompt || input.message,
        conversationId: input.conversationId,
        resumeLast: input.resumeLast,
        clientId: input.clientId,
        reasoning: input.reasoning,
        approvalPolicy: input.approvalPolicy
      })).message;
    }

    if (this.shouldUseAppServer(input)) {
      return (await this.startAppServerRun({
        content: input.content || input.prompt || input.message,
        title: input.content || input.prompt || input.message,
        conversationId: input.conversationId,
        resumeLast: input.resumeLast,
        reasoning: input.reasoning,
        approvalPolicy: input.approvalPolicy
      })).message;
    }

    if (this.cli) {
      return this.startCliRun({
        content: input.content || input.prompt || input.message,
        title: input.content || input.prompt || input.message,
        resumeLast: input.resumeLast,
        reasoning: input.reasoning,
        approvalPolicy: input.approvalPolicy
      }).message;
    }

    if (this.client) {
      return this.sendApiMessage(input);
    }

    const task = await this.startTask({
      title: input.content.slice(0, 80) || "Codex prompt",
      prompt: input.content
    });
    const now = new Date().toISOString();
    const conversation = {
      id: input.conversationId ?? `codex:conversation:${Date.now()}`,
      source: this.source,
      title: input.content.slice(0, 80) || "Codex local conversation",
      taskIds: [task.id],
      createdAt: now,
      updatedAt: now,
      metadata: {
        stub: true,
        lastMessage: input.content
      }
    };
    this.conversations = [
      conversation,
      ...this.conversations.filter((item) => item.id !== conversation.id)
    ].slice(0, 50);
    return {
      id: `codex:message:${Date.now()}`,
      conversationId: conversation.id,
      source: this.source,
      role: "user",
      content: input.content,
      createdAt: now,
      metadata: { taskId: task.id }
    };
  }

  async getConversation(conversationId) {
    if (this.client) {
      const conversations = await this.listConversations();
      return conversations.find((item) => item.id === conversationId);
    }

    return this.conversations.find((item) => item.id === conversationId) || {
      id: conversationId,
      source: this.source,
      title: "Codex local conversation",
      taskIds: this.tasks.map((task) => task.id),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { stub: true }
    };
  }

  async decideApproval(input) {
    const requestedSurface = normalizeCodexSurface(input.surface || this.activeSurface);
    this.assertNativeDesktopRequest(input);
    const observedApproval = requestedSurface === "desktop"
      ? this.findPendingObservedDesktopApproval(input.approvalId)
      : undefined;
    if (observedApproval) {
      return this.decideObservedDesktopApproval(input, observedApproval);
    }
    if (requestedSurface === "desktop") {
      return this.decideDesktopApproval(input);
    }

    if (this.client) {
      const sessionId = await this.ensureApiSession(input.conversationId);
      const approval = input.approvalId ? { id: stripCodexPrefix(input.approvalId) } : await this.findApiPendingApproval(sessionId);
      if (!approval?.id) throw new Error("No pending Codex approval for current session.");
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
        conversationId: `codex:${sessionId}`,
        payload: { approvalId: approval.id, choice, result }
      });
      return {
        id: approval.id,
        source: this.source,
        title: "Codex approval",
        body: input.reason ?? "",
        status: input.decision === "approve" ? "approved" : "rejected",
        requestedAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(),
        metadata: { result, sessionId, choice }
      };
    }

    if (this.cli) {
      return this.decideCliApproval(input);
    }

    const approval = {
      id: input.approvalId,
      source: this.source,
      title: "Codex approval",
      body: input.reason ?? "",
      status: input.decision === "approve" ? "approved" : "rejected",
      requestedAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(),
      metadata: { stub: true }
    };
    this.eventBus.publish({
      source: this.source,
      type: "approval.resolved",
      payload: approval
    });
    return approval;
  }

  async runAction(action, payload = {}) {
    const requestedSurface = normalizeCodexSurface(payload.surface || this.activeSurface);

    // Status probes are client-local. They must not change routing for other
    // phones or browser tabs connected to the same server.
    if (action === "status") {
      if (payload.persistSurface) this.activeSurface = requestedSurface;
      return this.health(requestedSurface);
    }
    if (payload.persistSurface) this.activeSurface = requestedSurface;

    if (requestedSurface === "desktop") {
      this.assertNativeDesktopRequest(payload);
      return this.runDesktopBridgeAction(action, payload);
    }

    if (this.cli) {
      if (action === "agents" || action === "models") return this.listAgents();
      if (action === "tasks" || action === "kanban") return this.listTasks();
      if (action === "sessions") return this.listCliConversations();
      if (action === "events") return this.eventBus.list(50).filter((event) => event.source === this.source);
      if (action === "workspace") {
        const result = this.cli.openApp();
        this.eventBus.publish({
          source: this.source,
          type: "runtime.connected",
          payload: { action: "open-app", result }
        });
        return result;
      }
      if (action === "new-task" || action === "continue") {
        return this.startTask({
          title: payload.title || payload.prompt || (action === "continue" ? "Continue Codex task" : "Manual Codex task"),
          prompt: payload.prompt || payload.title || (action === "continue" ? "Continue the most recent Codex task." : undefined),
          resumeLast: action === "continue",
          reasoning: payload.reasoning,
          approvalPolicy: payload.approvalPolicy
        });
      }
      if (action === "stop") return this.cancelTask(payload.taskId);
      if (action === "send") return this.sendMessage(payload);
      if (action === "approve" || action === "reject") {
        return this.decideApproval({
          source: this.source,
          approvalId: payload.approvalId,
          decision: action === "approve" ? "approve" : "reject",
          approvalDecision: payload.approvalDecision,
          approvalScope: payload.approvalScope,
          reason: payload.reason
        });
      }
    }

    if (this.client) {
      if (action === "agents" || action === "models") return this.listAgents();
      if (action === "tasks" || action === "kanban") return this.listTasks();
      if (action === "sessions") return this.listConversations();
      if (action === "events") return this.eventBus.list(50).filter((event) => event.source === this.source);
      if (action === "new-task" || action === "continue") {
        return this.startTask({
          title: payload.title || payload.prompt || "Manual Codex task",
          prompt: payload.prompt || payload.title
        });
      }
      if (action === "stop") {
        if (!this.activeStreamId) return { ok: true, message: "No active Codex stream." };
        await this.cancelTask(payload.taskId || `codex:stream:${this.activeStreamId}`);
        return { ok: true, streamId: this.activeStreamId };
      }
      if (action === "send") return this.sendApiMessage(payload);
      if (action === "approve" || action === "reject") {
        return this.decideApproval({
          source: this.source,
          approvalId: payload.approvalId,
          decision: action === "approve" ? "approve" : "reject",
          approvalDecision: payload.approvalDecision,
          approvalScope: payload.approvalScope,
          reason: payload.reason
        });
      }
    }

    if (action === "new-task") return this.startTask({
      title: payload.title || payload.prompt || "Manual Codex task",
      prompt: payload.prompt
    });
    if (action === "continue") {
      const task = this.tasks[0] || await this.startTask({ title: "Continue Codex task" });
      task.status = normalizeTaskStatus("running");
      task.progress = Math.min(100, (task.progress ?? 0) + 25);
      task.updatedAt = new Date().toISOString();
      this.eventBus.publish({
        source: this.source,
        type: "task.progress",
        taskId: task.id,
        payload: task
      });
      return task;
    }
    if (action === "stop") {
      const task = this.tasks[0];
      if (!task) return { ok: true, message: "No Codex task to stop." };
      await this.cancelTask(task.id);
      return task;
    }
    if (action === "approve" || action === "reject") {
      return this.decideApproval({
        source: this.source,
        approvalId: payload.approvalId || `codex:approval:${Date.now()}`,
        decision: action === "approve" ? "approve" : "reject",
        reason: payload.reason
      });
    }
    if (action === "sessions") return this.listConversations();
    if (action === "events") return this.eventBus.list(50).filter((event) => event.source === this.source);
    if (action === "workspace") {
      return {
        ok: true,
        source: this.source,
        workspace: process.cwd(),
        mode: this.config.mode
      };
    }
    throw new Error(`Unknown Codex action: ${action}`);
  }

  async *subscribeEvents() {
    yield {
      id: `codex-subscribe:${Date.now()}`,
      source: this.source,
      type: "runtime.connected",
      timestamp: new Date().toISOString(),
      payload: { mode: this.config.mode }
    };
  }

  shouldUseDesktopBridge(input = {}) {
    return Boolean(
      this.desktopBridge?.isConnected()
      && normalizeCodexSurface(input.surface || this.activeSurface) === "desktop"
    );
  }

  assertNativeDesktopRequest(input = {}) {
    if (normalizeCodexSurface(input.surface || this.activeSurface) !== "desktop") return;
    if (this.desktopBridge?.isConnected()) return;
    throw new Error(
      "Codex Desktop is not controllable because the native CDP bridge is disconnected. "
      + "Expose a user-managed loopback CDP endpoint, then retry."
    );
  }

  async runDesktopBridgeAction(action, payload = {}) {
    if (action === "agents" || action === "models") return this.listAgents();
    if (action === "tasks" || action === "kanban") return this.listTasks();
    if (action === "sessions") {
      await this.desktopBridge.health();
      return this.refreshDesktopConversations(this.desktopBridge.lastSnapshot);
    }
    if (action === "select-session") {
      const threadKey = stripDesktopConversationId(payload.conversationId);
      if (!threadKey) throw new Error("Codex Desktop session id is required.");
      await this.ensureDesktopBridgeReady();
      await this.desktopBridge.activateThread(threadKey);
      this.selectedAppThreadId = threadKey;
      this.activeAppThreadId = threadKey;
      return this.refreshDesktopConversations();
    }
    if (action === "events") return this.eventBus.list(50).filter((event) => event.source === this.source);
    await this.ensureDesktopBridgeReady();
    if (action === "workspace") return this.desktopBridge.health();
    if (action === "new-task") {
      await this.desktopBridge.createNewTask();
      this.selectedAppThreadId = undefined;
      this.desktopNewTaskDrafts.set(desktopDraftKey(payload.clientId), {
        createdAt: Date.now()
      });
      if (!payload.prompt && !payload.title) return this.refreshDesktopConversations();
      return this.startTask({
        title: payload.title || payload.prompt,
        prompt: payload.prompt || payload.title,
        clientId: payload.clientId,
        reasoning: payload.reasoning,
        surface: "desktop"
      });
    }
    if (action === "continue" || action === "send") {
      const content = payload.content || payload.prompt || payload.message || payload.title;
      if (!content && action === "continue") return this.desktopBridge.continueTask();
      if (!content) throw new Error("Codex Desktop prompt is empty.");
      return this.sendMessage({
        ...payload,
        content,
        conversationId: payload.conversationId,
        clientId: payload.clientId,
        surface: "desktop"
      });
    }
    if (action === "stop") {
      const requestedThreadKey = stripDesktopConversationId(payload.conversationId);
      if (requestedThreadKey) await this.desktopBridge.activateThread(requestedThreadKey);
      const before = await this.desktopBridge.snapshot();
      if (!before.working) {
        return { ok: true, metadata: { noop: true, reason: "no-active-desktop-task" } };
      }
      const result = await this.desktopBridge.stop();
      this.markDesktopTaskStopped(payload.conversationId);
      return result;
    }
    if (action === "approve" || action === "reject") {
      return this.decideApproval({
        ...payload,
        source: this.source,
        decision: action === "approve" ? "approve" : "reject",
        surface: "desktop"
      });
    }
    if (action === "reasoning-up" || action === "reasoning-down") {
      const direction = action === "reasoning-up" ? "increase" : "decrease";
      return this.desktopBridge.adjustReasoning(direction);
    }
    throw new Error(`Unknown Codex Desktop action: ${action}`);
  }

  async startDesktopRun(input) {
    const content = input.content || input.prompt || input.message;
    if (!content) throw new Error("Codex Desktop prompt is empty.");
    await this.ensureDesktopBridgeReady();
    const requestedThreadKey = stripDesktopConversationId(input.conversationId);
    const draftKey = desktopDraftKey(input.clientId);
    const draft = this.desktopNewTaskDrafts.get(draftKey);
    const pendingNewTask = Boolean(draft && Date.now() - draft.createdAt < 120000);
    const forceNewTask = input.resumeLast === false || pendingNewTask;
    if (input.resumeLast === false && !pendingNewTask) {
      await this.desktopBridge.createNewTask();
    }
    const before = await this.desktopBridge.snapshot();
    const targetThreadKey = forceNewTask
      ? undefined
      : requestedThreadKey || before.activeThreadKey;
    let after;
    try {
      after = await this.desktopBridge.sendPrompt(content, {
        threadKey: targetThreadKey
      });
    } finally {
      this.desktopNewTaskDrafts.delete(draftKey);
    }
    const threadKey = after.activeThreadKey || targetThreadKey;
    const now = new Date().toISOString();
    const observedTask = this.tasks.find((item) =>
      item.metadata?.nativeDesktop
      && item.metadata?.observed
      && item.metadata?.threadId === threadKey
      && ["running", "queued", "waiting_approval"].includes(item.status)
    );
    const task = observedTask || {
      id: `codex:desktop:${Date.now()}`,
      source: this.source,
      agentId: "codex:desktop",
      createdAt: now
    };
    Object.assign(task, {
      conversationId: threadKey ? `codex:desktop:${threadKey}` : undefined,
      title: (input.title || content).slice(0, 80),
      status: "running",
      progress: 10,
      updatedAt: now,
      metadata: {
        mode: "desktop",
        surface: "desktop",
        threadId: threadKey,
        prompt: content,
        reasoning: normalizeReasoning(input.reasoning),
        nativeDesktop: true,
        submittedAtMs: Date.now(),
        observedWorking: Boolean(after.working || after.waitingApproval)
      }
    });
    this.tasks = [
      task,
      ...this.tasks.filter((item) =>
        item.id !== task.id
        && !(item.metadata?.observed && item.metadata?.threadId === threadKey)
      )
    ].slice(0, 50);
    this.activeAppThreadId = threadKey;
    this.eventBus.publish({
      source: this.source,
      type: "task.created",
      taskId: task.id,
      agentId: task.agentId,
      conversationId: task.conversationId,
      payload: task
    });
    this.eventBus.publish({
      source: this.source,
      type: "conversation.message.created",
      taskId: task.id,
      conversationId: task.conversationId,
      payload: {
        role: "user",
        content,
        surface: "desktop",
        threadId: threadKey,
        nativeDesktop: true
      }
    });
    await this.refreshDesktopConversations(after);
    return {
      task,
      message: {
        id: `codex:desktop:message:${Date.now()}`,
        conversationId: task.conversationId,
        source: this.source,
        role: "user",
        content,
        createdAt: now,
        metadata: {
          taskId: task.id,
          surface: "desktop",
          threadId: threadKey,
          nativeDesktop: true
        }
      }
    };
  }

  async refreshDesktopConversations(snapshot) {
    const current = snapshot || await this.desktopBridge.snapshot();
    const now = new Date().toISOString();
    this.activeAppThreadId = current.activeThreadKey;
    if (!this.selectedAppThreadId && current.activeThreadKey) this.selectedAppThreadId = current.activeThreadKey;
    this.conversations = current.conversations.map((item) => ({
      id: `codex:desktop:${item.threadKey}`,
      source: this.source,
      title: item.title || "Codex Desktop task",
      taskIds: this.tasks
        .filter((task) => task.metadata?.threadId === item.threadKey)
        .map((task) => task.id),
      createdAt: now,
      updatedAt: now,
      metadata: {
        mode: "desktop",
        surface: "desktop",
        threadId: item.threadKey,
        selected: item.selected,
        status: item.status,
        nativeDesktop: true
      }
    })).slice(0, 50);
    this.syncDesktopTaskState(current);
    return this.conversations;
  }

  async ensureDesktopBridgeReady() {
    if (!this.desktopBridge?.isConnected()) {
      throw new Error("Codex Desktop bridge is not connected.");
    }
    return this.desktopBridge.health();
  }

  async decideDesktopApproval(input) {
    const approved = input.decision === "approve";
    const requestedThreadKey = stripDesktopConversationId(input.conversationId);
    if (requestedThreadKey) await this.desktopBridge.activateThread(requestedThreadKey);
    const before = await this.desktopBridge.snapshot();
    if (!before.waitingApproval) {
      throw new Error("Codex Desktop has no pending approval.");
    }
    const expectedApprovalId = `codex:desktop:approval:${before.activeThreadKey || "active"}`;
    if (input.approvalId && input.approvalId !== expectedApprovalId) {
      throw new Error("Codex Desktop approval does not match the active task.");
    }
    let snapshot = approved
      ? await this.desktopBridge.approve()
      : await this.desktopBridge.reject();
    const deadline = Date.now() + 8000;
    while (snapshot.waitingApproval && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      snapshot = await this.desktopBridge.snapshot();
    }
    if (snapshot.waitingApproval) {
      throw new Error(`Codex Desktop did not confirm ${approved ? "approval" : "rejection"}.`);
    }
    const now = new Date().toISOString();
    const approval = {
      id: input.approvalId || `codex:desktop:approval:${Date.now()}`,
      source: this.source,
      conversationId: snapshot.activeThreadKey
        ? `codex:desktop:${snapshot.activeThreadKey}`
        : undefined,
      title: `Codex Desktop ${approved ? "approval" : "rejection"}`,
      body: input.reason || "",
      status: approved ? "approved" : "rejected",
      requestedAt: now,
      resolvedAt: now,
      metadata: {
        surface: "desktop",
        nativeDesktop: true,
        threadId: snapshot.activeThreadKey
      }
    };
    for (const item of this.approvals) {
      if (item.status !== "pending" || item.metadata?.threadId !== before.activeThreadKey) continue;
      item.status = approved ? "approved" : "rejected";
      item.resolvedAt = now;
      item.updatedAt = now;
    }
    this.approvals = this.approvals.slice(0, 50);
    this.eventBus.publish({
      source: this.source,
      type: "approval.resolved",
      conversationId: approval.conversationId,
      payload: approval
    });
    return approval;
  }

  syncDesktopTaskState(snapshot) {
    // A native bridge snapshot without a thread key is not an idle snapshot.
    // The session observer may still have the authoritative live state, so
    // never expire approvals or complete a task from an uncorrelated sample.
    if (!snapshot?.activeThreadKey) return;

    const activeApprovalId = snapshot.waitingApproval && snapshot.activeThreadKey
      ? `codex:desktop:approval:${snapshot.activeThreadKey}`
      : undefined;
    for (const approval of this.approvals) {
      if (
        approval.status === "pending"
        && approval.metadata?.nativeDesktop
        && approval.id !== activeApprovalId
      ) {
        const resolvedAt = new Date().toISOString();
        approval.status = "expired";
        approval.resolvedAt = resolvedAt;
        approval.updatedAt = resolvedAt;
        this.eventBus.publish({
          source: this.source,
          type: "approval.resolved",
          taskId: approval.taskId,
          conversationId: approval.conversationId,
          payload: {
            approvalId: approval.id,
            status: "expired",
            surface: "desktop",
            nativeDesktop: true,
            reason: "native snapshot no longer reports a pending approval"
          }
        });
      }
    }
    let active = this.tasks.find((task) =>
      task.metadata?.nativeDesktop
      && (!snapshot.activeThreadKey || task.metadata?.threadId === snapshot.activeThreadKey)
      && ["running", "queued", "waiting_approval"].includes(task.status)
    );
    if (!active && (snapshot.working || snapshot.waitingApproval) && snapshot.activeThreadKey) {
      const now = new Date().toISOString();
      active = {
        id: `codex:desktop:observed:${snapshot.activeThreadKey}`,
        source: this.source,
        agentId: "codex:desktop",
        conversationId: `codex:desktop:${snapshot.activeThreadKey}`,
        title: snapshot.activeThreadTitle || "Codex Desktop task",
        status: snapshot.waitingApproval ? "waiting_approval" : "running",
        progress: snapshot.waitingApproval ? 55 : 30,
        createdAt: now,
        updatedAt: now,
        metadata: {
          mode: "desktop",
          surface: "desktop",
          threadId: snapshot.activeThreadKey,
          nativeDesktop: true,
          observed: true
        }
      };
      this.tasks = [active, ...this.tasks.filter((item) => item.id !== active.id)].slice(0, 50);
      this.eventBus.publish({
        source: this.source,
        type: "task.created",
        taskId: active.id,
        agentId: active.agentId,
        conversationId: active.conversationId,
        payload: active
      });
    }
    if (!active) return;
    if (snapshot.working || snapshot.waitingApproval) {
      active.metadata = {
        ...active.metadata,
        observedWorking: true,
        observedDetail: snapshot.waitingApproval
          ? "approval required - choose ALLOW or DENY"
          : active.metadata?.observedDetail,
        lastActivity: snapshot.waitingApproval
          ? "approval required - choose ALLOW or DENY"
          : active.metadata?.lastActivity,
        lastEventType: snapshot.waitingApproval
          ? "approval.requested"
          : active.metadata?.lastEventType,
        approvalDetection: snapshot.waitingApproval
          ? snapshot.approvalDetection
          : undefined
      };
    }
    if (snapshot.waitingApproval) {
      const approvalId = `codex:desktop:approval:${snapshot.activeThreadKey || "active"}`;
      const existing = this.approvals.find((item) =>
        item.status === "pending"
        && item.metadata?.threadId === snapshot.activeThreadKey
      );
      if (!existing) {
        const approval = {
          id: approvalId,
          source: this.source,
          taskId: active.id,
          conversationId: active.conversationId,
          title: "Codex Desktop approval",
          body: "The visible Codex Desktop task is waiting for approval.",
          status: "pending",
          requestedAt: new Date().toISOString(),
          metadata: {
            surface: "desktop",
            nativeDesktop: true,
            threadId: snapshot.activeThreadKey
          }
        };
        this.approvals = [approval, ...this.approvals.filter((item) => item.id !== approval.id)].slice(0, 50);
        this.eventBus.publish({
          source: this.source,
          type: "approval.requested",
          taskId: active.id,
          conversationId: active.conversationId,
          payload: approval
        });
      }
    }
    const submittedAtMs = Number(active.metadata?.submittedAtMs || 0);
    const stillStarting = Boolean(
      !snapshot.working
      && !snapshot.waitingApproval
      && !active.metadata?.observedWorking
      && submittedAtMs
      && Date.now() - submittedAtMs < 8000
    );
    const idleCount = snapshot.working || snapshot.waitingApproval
      ? 0
      : (this.desktopIdleObservations.get(active.id) || 0) + 1;
    this.desktopIdleObservations.set(active.id, idleCount);
    const observer = this.latestSessionObserverSnapshot;
    const observerManagedTurn = Boolean(
      (this.sessionObserver || observer)
      && (active.metadata?.sessionObserver || active.metadata?.observedTurnId)
    );
    const activeTurnId = String(active.metadata?.observedTurnId || active.metadata?.turnId || "");
    const observerTurnId = String(observer?.turnId || "");
    const observerConfirmsTerminal = Boolean(
      observer?.threadId === snapshot.activeThreadKey
      && observer.hasTurnState === true
      && observer.working === false
      && observer.waitingApproval !== true
      && (!activeTurnId || !observerTurnId || activeTurnId === observerTurnId)
    );
    const confirmedIdle = observerManagedTurn
      ? observerConfirmsTerminal
      : idleCount >= 2;
    const nextStatus = snapshot.waitingApproval
      ? "waiting_approval"
      : snapshot.working || stillStarting
        ? "running"
        : confirmedIdle
          ? "completed"
          : active.status;
    if (active.status === nextStatus) return;
    active.status = normalizeTaskStatus(nextStatus);
    active.progress = nextStatus === "completed" ? 100 : Math.max(active.progress || 0, 30);
    active.updatedAt = new Date().toISOString();
    this.eventBus.publish({
      source: this.source,
      type: nextStatus === "completed" ? "task.completed" : "task.progress",
      taskId: active.id,
      conversationId: active.conversationId,
      payload: {
        status: nextStatus,
        surface: "desktop",
        nativeDesktop: true,
        threadId: snapshot.activeThreadKey
      }
    });
  }

  markDesktopTaskStopped(conversationId) {
    const threadKey = stripDesktopConversationId(conversationId) || this.activeAppThreadId;
    const tasks = this.tasks.filter((item) =>
      item.metadata?.nativeDesktop
      && (!threadKey || item.metadata?.threadId === threadKey)
      && ["running", "queued", "waiting_approval"].includes(item.status)
    );
    for (const task of tasks) {
      task.status = "cancelled";
      task.progress = 100;
      task.updatedAt = new Date().toISOString();
      this.eventBus.publish({
        source: this.source,
        type: "task.completed",
        taskId: task.id,
        conversationId: task.conversationId,
        payload: { status: "cancelled", surface: "desktop", nativeDesktop: true }
      });
    }
    return tasks.length;
  }

  handleDesktopBridgeEvent(event) {
    this.eventBus.publish({
      source: this.source,
      type: event.type === "task.stopped" ? "task.completed" : "task.progress",
      conversationId: this.activeAppThreadId ? `codex:desktop:${this.activeAppThreadId}` : undefined,
      payload: {
        surface: "desktop",
        nativeDesktop: true,
        ...event.payload
      }
    });
  }

  publishDesktopBridgeError(error) {
    this.eventBus.publish({
      source: this.source,
      type: "runtime.error",
      payload: {
        surface: "desktop",
        nativeDesktop: true,
        error: error.message
      }
    });
  }

  async pollDesktopBridge() {
    if (!this.desktopBridge || this.desktopBridgePolling) return;
    this.desktopBridgePolling = true;
    try {
      if (!this.desktopBridge.isConnected() && Date.now() - Number(this.desktopBridgeLastProbeAt || 0) < 5000) {
        return;
      }
      this.desktopBridgeLastProbeAt = Date.now();
      if (!this.desktopBridgeReady) {
        await this.desktopBridge.enableMicroRuntime();
        this.desktopBridgeReady = true;
        this.eventBus.publish({
          source: this.source,
          type: "runtime.connected",
          payload: {
            surface: "desktop",
            nativeDesktop: true,
            mechanism: "codex-desktop-cdp"
          }
        });
      }
      const rawSnapshot = await this.desktopBridge.snapshot();
      const snapshot = this.reconcileNativeApprovalSnapshot(
        rawSnapshot,
        this.latestSessionObserverSnapshot
      );
      if (snapshot !== rawSnapshot) this.desktopBridge.lastSnapshot = snapshot;
      this.desktopBridgeOfflineReported = false;
      // Do not publish native idle/completed state when the bridge cannot
      // identify which desktop thread the snapshot belongs to. The observer
      // will own status until a correlated native snapshot is available.
      if (!snapshot?.activeThreadKey) return;
      const stateKey = [
        snapshot.activeThreadKey || "",
        snapshot.working ? "working" : "idle",
        snapshot.waitingApproval ? "approval" : ""
      ].join(":");
      this.activeAppThreadId = snapshot.activeThreadKey;
      this.syncDesktopTaskState(snapshot);
      if (stateKey !== this.desktopBridgeLastState) {
        this.desktopBridgeLastState = stateKey;
        this.eventBus.publish({
          source: this.source,
          type: "task.progress",
          conversationId: snapshot.activeThreadKey
            ? `codex:desktop:${snapshot.activeThreadKey}`
            : undefined,
          payload: {
            surface: "desktop",
            nativeDesktop: true,
            status: snapshot.waitingApproval
              ? "waiting_approval"
              : snapshot.working
                ? "running"
                : "idle",
            title: snapshot.activeThreadTitle,
            threadId: snapshot.activeThreadKey
          }
        });
      }
    } catch (error) {
      this.desktopBridgeReady = false;
      this.desktopBridgeLastState = undefined;
      this.desktopBridgeOfflineReported = true;
    } finally {
      this.desktopBridgePolling = false;
    }
  }

  pollSessionObserver() {
    if (!this.sessionObserver || this.sessionObserverPolling) return;
    this.sessionObserverPolling = true;
    try {
      const snapshot = this.sessionObserver.snapshot();
      this.latestSessionObserverSnapshot = snapshot;
      this.syncSessionObserverState(snapshot);
    } catch (error) {
      if (!this.sessionObserverErrorReported) {
        this.sessionObserverErrorReported = true;
        this.eventBus.publish({
          source: this.source,
          type: "runtime.error",
          payload: { surface: "desktop", observer: true, error: error.message }
        });
      }
    } finally {
      this.sessionObserverPolling = false;
    }
  }

  observerConfirmsNoApproval(observer, nativeSnapshot) {
    if (!observer?.threadId || observer.hasTurnState !== true || observer.waitingApproval === true) return false;
    const pendingApprovals = Array.isArray(observer.pendingApprovals)
      ? observer.pendingApprovals
      : [];
    if (pendingApprovals.length > 0) return false;
    const observerText = `${observer.detail || ""} ${observer.approvalDetection || ""}`;
    if (/approval|approve|allow|deny|reject|waiting_approval/i.test(observerText)) return false;

    const approvalHintAt = Number(nativeSnapshot?.approvalHintAt || 0);
    if (!approvalHintAt) return true;
    const observerUpdatedAt = Date.parse(observer.updatedAt || "");
    return observerUpdatedAt > 0 && observerUpdatedAt >= approvalHintAt;
  }

  reconcileNativeApprovalSnapshot(nativeSnapshot, observer) {
    if (
      !nativeSnapshot?.waitingApproval
      || !observer?.threadId
      || nativeSnapshot.activeThreadKey !== observer.threadId
      || !this.observerConfirmsNoApproval(observer, nativeSnapshot)
    ) {
      return nativeSnapshot;
    }
    return {
      ...nativeSnapshot,
      waitingApproval: false,
      approvalDetection: undefined,
      approvalHintAt: undefined,
      reconciledFrom: "session-observer"
    };
  }

  syncSessionObserverState(snapshot) {
    if (!snapshot?.threadId) return;
    this.sessionObserverErrorReported = false;
    const conversationId = `codex:desktop:${snapshot.threadId}`;
    const now = snapshot.updatedAt || new Date().toISOString();
    this.syncObservedDesktopApproval(snapshot, conversationId, now);
    const nativeSnapshot = this.desktopBridge?.lastSnapshot;
    const reconciledNativeSnapshot = this.reconcileNativeApprovalSnapshot(nativeSnapshot, snapshot);
    const nativeApprovalWasReconciled = reconciledNativeSnapshot !== nativeSnapshot;
    if (nativeApprovalWasReconciled) {
      this.desktopBridge.lastSnapshot = reconciledNativeSnapshot;
      for (const approval of this.approvals) {
        if (
          approval.status !== "pending"
          || !approval.metadata?.nativeDesktop
          || approval.metadata?.threadId !== snapshot.threadId
        ) continue;
        const resolvedAt = new Date().toISOString();
        approval.status = "expired";
        approval.resolvedAt = resolvedAt;
        approval.updatedAt = resolvedAt;
        this.eventBus.publish({
          source: this.source,
          type: "approval.resolved",
          taskId: approval.taskId,
          conversationId: approval.conversationId,
          payload: {
            approvalId: approval.id,
            status: "expired",
            surface: "desktop",
            nativeDesktop: true,
            reason: "session observer confirms no pending approval"
          }
        });
      }
    }
    if (
      this.desktopBridge?.isConnected?.()
      && reconciledNativeSnapshot?.activeThreadKey === snapshot.threadId
      && !nativeApprovalWasReconciled
    ) {
      // The native bridge is the authority when it has a correlated thread.
      // The observer still updates approval detection above, but must not
      // publish a second status stream for the same task.
      return;
    }
    const pendingDesktopApproval = this.approvals.some((approval) =>
      approval.status === "pending"
      && (approval.metadata?.nativeDesktop || approval.metadata?.observerApproval)
      && approval.metadata?.threadId === snapshot.threadId
    );
    const waitingApproval = Boolean(snapshot.waitingApproval || pendingDesktopApproval);
    const status = waitingApproval
      ? "waiting_approval"
      : snapshot.working
        ? "running"
        : "completed";
    const stateKey = [
      snapshot.threadId,
      snapshot.turnId || "",
      status,
      snapshot.detail || "",
      snapshot.tokens ?? ""
    ].join(":");

    if (!this.selectedAppThreadId) this.activeAppThreadId = snapshot.threadId;
    let task = this.tasks.find((item) =>
      item.metadata?.threadId === snapshot.threadId
      && (
        !item.metadata?.turnId
        || !snapshot.turnId
        || item.metadata.turnId === snapshot.turnId
      )
    );
    if (!task && snapshot.working) {
      task = {
        id: `codex:desktop:observed:${snapshot.threadId}`,
        source: this.source,
        agentId: "codex:desktop",
        conversationId,
        title: snapshot.title || "Codex Desktop task",
        status,
        progress: waitingApproval ? 55 : 30,
        createdAt: now,
        updatedAt: now,
        metadata: {
          mode: "desktop",
          surface: "desktop",
          threadId: snapshot.threadId,
          observed: true,
          sessionObserver: true
        }
      };
      this.tasks = [task, ...this.tasks].slice(0, 50);
      this.eventBus.publish({
        source: this.source,
        type: "task.created",
        taskId: task.id,
        agentId: task.agentId,
        conversationId,
        payload: task
      });
    }

    const observedApproval = this.findPendingObservedDesktopApproval();
    if (
      task
      && observedApproval
      && observedApproval.metadata?.threadId === snapshot.threadId
      && !observedApproval.taskId
    ) {
      observedApproval.taskId = task.id;
    }

    const snapshotAt = Date.parse(snapshot.updatedAt || "") || 0;
    const taskStartedAt = Date.parse(task?.createdAt || "") || 0;
    const observerCanUpdateTask = task?.metadata?.observed
      || snapshotAt >= taskStartedAt
      || task?.metadata?.turnId === snapshot.turnId;
    if (task && snapshot.hasTurnState && observerCanUpdateTask) {
      task.status = normalizeTaskStatus(status);
      task.progress = status === "completed" ? 100 : Math.max(task.progress || 0, waitingApproval ? 55 : 30);
      task.updatedAt = now;
      task.title = snapshot.title || task.title;
      task.metadata = {
        ...task.metadata,
        observedDetail: waitingApproval
          ? "approval required - choose ALLOW or DENY"
          : snapshot.detail,
        observedTokens: snapshot.tokens,
        observedTurnId: snapshot.turnId,
        lastActivity: waitingApproval
          ? "approval required - choose ALLOW or DENY"
          : snapshot.detail,
        lastEventType: waitingApproval
          ? "approval.requested"
          : "task.progress"
      };
    }

    const existingConversation = this.conversations.find((item) => item.id === conversationId);
    const observerIsSelected = !this.selectedAppThreadId || this.selectedAppThreadId === snapshot.threadId;
    if (existingConversation) {
      existingConversation.title = snapshot.title || existingConversation.title;
      existingConversation.updatedAt = now;
      existingConversation.metadata = {
        ...existingConversation.metadata,
        selected: observerIsSelected,
        observedStatus: status
      };
    } else {
      this.conversations.unshift({
        id: conversationId,
        source: this.source,
        title: snapshot.title || "Codex Desktop task",
        taskIds: task ? [task.id] : [],
        createdAt: now,
        updatedAt: now,
        metadata: {
          mode: "desktop",
          surface: "desktop",
          threadId: snapshot.threadId,
          selected: observerIsSelected,
          observedStatus: status,
          sessionObserver: true
        }
      });
      this.conversations = this.conversations.slice(0, 50);
    }

    if (!snapshot.hasTurnState || stateKey === this.sessionObserverLastState) return;
    this.sessionObserverLastState = stateKey;
    this.eventBus.publish({
      source: this.source,
      type: status === "completed" ? "task.completed" : "task.progress",
      taskId: task?.id,
      conversationId,
      payload: {
        surface: "desktop",
        observer: true,
        status,
        message: waitingApproval
          ? "approval required - choose ALLOW or DENY"
          : snapshot.detail || `Codex Desktop ${status}.`,
        threadId: snapshot.threadId,
        turnId: snapshot.turnId,
        tokens: snapshot.tokens
      }
    });
  }

  syncObservedDesktopApproval(snapshot, conversationId, now) {
    const detected = Array.isArray(snapshot.pendingApprovals) && snapshot.pendingApprovals.length
      ? snapshot.pendingApprovals
      : snapshot.waitingApproval
        ? [{
            threadId: snapshot.threadId,
            turnId: snapshot.turnId,
            title: snapshot.title,
            callId: snapshot.approvalCallId,
            approvalDetection: snapshot.approvalDetection,
            updatedAt: now
          }]
        : [];
    const desired = new Map(detected.map((item) => {
      const rawId = item.callId || item.turnId || "active";
      return [`codex:desktop:observer-approval:${item.threadId}:${rawId}`, item];
    }));

    for (const approval of this.approvals) {
      if (approval.status !== "pending" || !approval.metadata?.observerApproval || desired.has(approval.id)) continue;
      approval.status = "expired";
      approval.resolvedAt = now;
      approval.updatedAt = now;
      this.eventBus.publish({
        source: this.source,
        type: "approval.resolved",
        taskId: approval.taskId,
        conversationId: approval.conversationId,
        payload: { approvalId: approval.id, status: "expired", surface: "desktop", observer: true }
      });
    }

    for (const [approvalId, item] of desired) {
      const itemConversationId = `codex:${item.threadId}`;
      let task = this.tasks.find((candidate) =>
        candidate.metadata?.threadId === item.threadId
        && (!item.turnId || !candidate.metadata?.turnId || candidate.metadata?.turnId === item.turnId)
      );
      if (!task) {
        task = {
          id: `codex:desktop:observed:${item.threadId}:${item.turnId || "active"}`,
          source: this.source,
          agentId: "codex:desktop",
          conversationId: itemConversationId,
          title: item.title || "Codex Desktop task",
          status: "waiting_approval",
          progress: 55,
          createdAt: item.updatedAt || now,
          updatedAt: now,
          metadata: {
            mode: "desktop",
            surface: "desktop",
            threadId: item.threadId,
            turnId: item.turnId,
            observed: true,
            sessionObserver: true,
            observedDetail: "approval required - choose ALLOW or DENY",
            lastActivity: "approval required - choose ALLOW or DENY",
            lastEventType: "approval.requested"
          }
        };
        this.tasks = [task, ...this.tasks].slice(0, 50);
        this.eventBus.publish({
          source: this.source,
          type: "task.created",
          taskId: task.id,
          agentId: task.agentId,
          conversationId: itemConversationId,
          payload: task
        });
      } else {
        task.status = "waiting_approval";
        task.progress = Math.max(task.progress || 0, 55);
        task.updatedAt = now;
        task.metadata = {
          ...task.metadata,
          observedDetail: "approval required - choose ALLOW or DENY",
          lastActivity: "approval required - choose ALLOW or DENY",
          lastEventType: "approval.requested"
        };
      }

      const equivalent = this.approvals.find((approval) =>
        approval.status === "pending"
        && approval.metadata?.threadId === item.threadId
      );
      if (equivalent) {
        equivalent.metadata = {
          ...equivalent.metadata,
          observerDetected: true,
          approvalDetection: item.approvalDetection,
          callId: item.callId || equivalent.metadata?.callId,
          turnId: item.turnId || equivalent.metadata?.turnId
        };
        continue;
      }
      const approval = {
        id: approvalId,
        source: this.source,
        taskId: task.id,
        conversationId: itemConversationId,
        title: "Codex Desktop approval",
        body: "The current Codex Desktop task is waiting for approval.",
        status: "pending",
        requestedAt: item.updatedAt || now,
        updatedAt: now,
        metadata: {
          mode: "desktop",
          surface: "desktop",
          observerApproval: true,
          approvalDetection: item.approvalDetection,
          callId: item.callId,
          threadId: item.threadId,
          turnId: item.turnId
        }
      };
      this.approvals = [approval, ...this.approvals.filter((existing) => existing.id !== approval.id)].slice(0, 50);
      this.eventBus.publish({
        source: this.source,
        type: "approval.requested",
        taskId: approval.taskId,
        conversationId: itemConversationId,
        payload: {
          approval_id: approval.id,
          approvalId: approval.id,
          question: approval.body,
          surface: "desktop",
          observer: true,
          detection: item.approvalDetection
        }
      });
      this.eventBus.publish({
        source: this.source,
        type: "task.progress",
        taskId: task.id,
        conversationId: itemConversationId,
        payload: {
          surface: "desktop",
          observer: true,
          status: "waiting_approval",
          message: "approval required - choose ALLOW or DENY",
          approvalId
        }
      });
    }
  }

  findPendingObservedDesktopApproval(approvalId) {
    return this.approvals.find((approval) =>
      approval.status === "pending"
      && approval.metadata?.observerApproval
      && (!approvalId || approval.id === approvalId)
    );
  }

  async decideObservedDesktopApproval(input, pending) {
    if (!this.desktopBridge?.isConnected()) {
      throw new Error("The current Codex Desktop approval is visible, but the native Desktop bridge is not connected.");
    }

    const requestedThreadKey = pending.metadata?.threadId;
    if (requestedThreadKey) await this.desktopBridge.activateThread(requestedThreadKey);
    const approved = input.decision === "approve";
    const before = await this.desktopBridge.snapshot();
    if (!before.waitingApproval) {
      throw new Error("Codex Desktop has no pending approval in the visible task.");
    }
    let resolvedSnapshot = approved
      ? await this.desktopBridge.approve()
      : await this.desktopBridge.reject();
    const deadline = Date.now() + 8000;
    while (resolvedSnapshot.waitingApproval && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      resolvedSnapshot = await this.desktopBridge.snapshot();
    }
    if (resolvedSnapshot.waitingApproval) {
      throw new Error(`Codex Desktop did not confirm ${approved ? "approval" : "rejection"}.`);
    }

    const decidedAt = new Date().toISOString();
    pending.status = approved ? "approved" : "rejected";
    pending.resolvedAt = decidedAt;
    pending.updatedAt = decidedAt;
    pending.metadata = { ...pending.metadata, decision: pending.status, decidedAt };
    for (const approval of this.approvals) {
      if (
        approval !== pending
        && approval.status === "pending"
        && approval.metadata?.threadId === pending.metadata?.threadId
      ) {
        approval.status = pending.status;
        approval.resolvedAt = decidedAt;
        approval.updatedAt = decidedAt;
      }
    }
    const task = pending.taskId ? this.tasks.find((item) => item.id === pending.taskId) : undefined;
    if (task) {
      task.status = normalizeTaskStatus(approved ? "running" : "blocked");
      task.updatedAt = decidedAt;
    }
    this.eventBus.publish({
      source: this.source,
      type: "approval.resolved",
      taskId: pending.taskId,
      conversationId: pending.conversationId,
      payload: { approvalId: pending.id, status: pending.status, surface: "desktop", observer: true }
    });
    return pending;
  }

  shouldUseAppServer(input = {}) {
    return Boolean(this.appServer && normalizeCodexSurface(input.surface || this.activeSurface) === "desktop");
  }

  async runAppServerAction(action, payload = {}) {
    if (action === "agents" || action === "models") return this.listAgents();
    if (action === "tasks" || action === "kanban") return this.listTasks();
    if (action === "sessions") return this.refreshAppServerThreads();
    if (action === "select-session") {
      const threadId = stripDesktopConversationId(payload.conversationId);
      if (!threadId) throw new Error("Codex session id is required.");
      this.selectedAppThreadId = threadId;
      this.activeAppThreadId = threadId;
      for (const conversation of this.conversations) {
        if (conversation.metadata?.surface === "desktop") {
          conversation.metadata.selected = conversation.metadata?.threadId === threadId;
        }
      }
      return { ok: true, threadId, surface: "desktop" };
    }
    if (action === "events") return this.eventBus.list(50).filter((event) => event.source === this.source);
    if (action === "workspace") {
      const result = this.cli?.openApp() || { ok: true, message: "Desktop app-server mode is available." };
      this.eventBus.publish({
        source: this.source,
        type: "runtime.connected",
        payload: { action: "open-app", surface: "desktop", result }
      });
      return result;
    }
    if (action === "new-task" || action === "continue") {
      if (action === "new-task") this.selectedAppThreadId = undefined;
      return this.startTask({
        title: payload.title || payload.prompt || (action === "continue" ? "Continue Codex desktop task" : "Manual Codex desktop task"),
        prompt: payload.prompt || payload.title || (action === "continue" ? "Continue the current Codex task." : undefined),
        conversationId: payload.conversationId,
        resumeLast: action === "continue" || payload.resumeLast,
        reasoning: payload.reasoning,
        approvalPolicy: payload.approvalPolicy,
        surface: "desktop"
      });
    }
    if (action === "stop") return this.cancelAppServerTask(payload.taskId);
    if (action === "send") return this.sendMessage({ ...payload, surface: "desktop" });
    if (action === "approve" || action === "reject") {
      return this.decideApproval({
        source: this.source,
        surface: "desktop",
        approvalId: payload.approvalId,
        decision: action === "approve" ? "approve" : "reject",
        approvalDecision: payload.approvalDecision,
        approvalScope: payload.approvalScope,
        reason: payload.reason
      });
    }
    if (action === "reasoning-up" || action === "reasoning-down") {
      return {
        ok: true,
        from: normalizeReasoning(payload.current),
        to: normalizeReasoning(payload.target),
        mechanism: "next-turn"
      };
    }
    throw new Error(`Unknown Codex desktop action: ${action}`);
  }

  async startAppServerRun(input) {
    const content = input.content || input.prompt || input.message;
    if (!content) throw new Error("Codex message is empty.");

    const reasoning = normalizeReasoning(input.reasoning);
    const approvalPolicy = input.approvalPolicy || this.sessionApprovalPolicyOverride || this.config.approvalPolicy;
    const now = new Date().toISOString();
    const thread = await this.ensureAppServerThread({
      conversationId: input.conversationId,
      resumeLast: input.resumeLast,
      approvalPolicy
    });
    const threadId = thread.id;

    const task = {
      id: `codex:desktop:${Date.now()}`,
      source: this.source,
      agentId: "codex:desktop",
      conversationId: `codex:${threadId}`,
      title: (input.title || content).slice(0, 80),
      status: "running",
      progress: 10,
      createdAt: now,
      updatedAt: now,
      metadata: {
        mode: "desktop",
        surface: "desktop",
        threadId,
        prompt: content,
        reasoning,
        approvalPolicy
      }
    };

    const conversation = this.upsertAppServerConversation(thread, {
      title: task.title,
      taskId: task.id,
      updatedAt: now
    });

    this.tasks.unshift(task);
    this.tasks = this.tasks.slice(0, 50);
    this.appThreadTasks.set(threadId, task.id);
    this.activeAppThreadId = threadId;

    this.eventBus.publish({
      source: this.source,
      type: "task.created",
      taskId: task.id,
      agentId: task.agentId,
      conversationId: conversation.id,
      payload: task
    });

    this.eventBus.publish({
      source: this.source,
      type: "conversation.message.created",
      taskId: task.id,
      conversationId: conversation.id,
      payload: { role: "user", content, reasoning, surface: "desktop" }
    });

    const turn = await this.appServer.request("turn/start", {
      threadId,
      input: [{ type: "text", text: content }],
      approvalPolicy,
      approvalsReviewer: "user",
      cwd: this.config.workdir,
      effort: appServerReasoningEffort(reasoning),
      ...(this.config.model ? { model: this.config.model } : {})
    }, { timeoutMs: this.config.appServerRequestTimeoutMs || 15000 });

    const turnId = appServerTurnId(turn);
    if (turnId) {
      task.metadata.turnId = turnId;
      this.activeAppTurnId = turnId;
      this.appTurnTasks.set(turnId, task.id);
    }
    task.metadata.turn = turn;
    task.progress = Math.max(task.progress, 18);
    task.updatedAt = new Date().toISOString();

    this.eventBus.publish({
      source: this.source,
      type: "task.progress",
      taskId: task.id,
      conversationId: conversation.id,
      payload: { message: "Codex Desktop turn started.", surface: "desktop", threadId, turnId }
    });

    return {
      task,
      message: {
        id: `codex:desktop:message:${Date.now()}`,
        conversationId: conversation.id,
        source: this.source,
        role: "user",
        content,
        createdAt: now,
        metadata: { taskId: task.id, surface: "desktop", threadId, turnId, reasoning }
      }
    };
  }

  async ensureAppServerThread(input = {}) {
    await this.appServer.connect();

    const requestedThreadId = stripDesktopConversationId(input.conversationId);
    const resumeThreadId = requestedThreadId || this.selectedAppThreadId || this.activeAppThreadId;
    if (input.resumeLast && resumeThreadId) {
      const resumed = await this.appServer.request("thread/resume", {
        threadId: resumeThreadId,
        approvalPolicy: input.approvalPolicy,
        approvalsReviewer: "user",
        cwd: this.config.workdir,
        sandbox: this.config.sandbox,
        ...(this.config.model ? { model: this.config.model } : {})
      });
      return appServerThreadFromResponse(resumed, resumeThreadId);
    }

    if (input.resumeLast) {
      const latest = await this.latestAppServerThread();
      if (latest?.id) {
        const resumed = await this.appServer.request("thread/resume", {
          threadId: latest.id,
          approvalPolicy: input.approvalPolicy,
          approvalsReviewer: "user",
          cwd: this.config.workdir,
          sandbox: this.config.sandbox,
          ...(this.config.model ? { model: this.config.model } : {})
        });
        return appServerThreadFromResponse(resumed, latest.id);
      }
    }

    const started = await this.appServer.request("thread/start", {
      approvalPolicy: input.approvalPolicy,
      approvalsReviewer: "user",
      cwd: this.config.workdir,
      sandbox: this.config.sandbox,
      threadSource: "hermes-control",
      serviceName: "Hermes Control",
      ...(this.config.model ? { model: this.config.model } : {})
    });
    return appServerThreadFromResponse(started);
  }

  async latestAppServerThread() {
    const result = await this.appServer.request("thread/list", {
      limit: 50,
      sortKey: "updated_at",
      sortDirection: "desc"
    }, { timeoutMs: this.config.appServerRequestTimeoutMs || 15000 });
    const thread = sortAppServerThreads(result?.data)[0];
    return thread ? appServerThreadFromResponse({ thread }) : undefined;
  }

  async refreshAppServerThreads() {
    await this.appServer.connect();
    const result = await this.appServer.request("thread/list", {
      limit: 50,
      sortKey: "updated_at",
      sortDirection: "desc"
    }, { timeoutMs: this.config.appServerRequestTimeoutMs || 15000 });

    const threads = sortAppServerThreads(result?.data);
    for (const thread of threads) {
      this.upsertAppServerConversation(thread);
    }
    if (threads[0] && !this.selectedAppThreadId) {
      const latestId = appServerThreadId(threads[0]);
      if (latestId) this.activeAppThreadId = latestId;
    }
    this.conversations.sort((a, b) => timestampMs(b.updatedAt) - timestampMs(a.updatedAt));
    this.conversations = this.conversations.slice(0, 50);
    return this.conversations;
  }

  listCliConversations() {
    return this.conversations
      .filter((item) => item.metadata?.surface !== "desktop")
      .sort((a, b) => timestampMs(b.updatedAt) - timestampMs(a.updatedAt))
      .slice(0, 50);
  }

  upsertAppServerConversation(thread, options = {}) {
    const threadId = appServerThreadId(thread);
    const now = options.updatedAt || new Date().toISOString();
    const conversation = {
      id: `codex:${threadId}`,
      source: this.source,
      title: options.title || appServerThreadTitle(thread) || "Codex Desktop thread",
      taskIds: options.taskId ? [options.taskId] : [],
      createdAt: appServerDate(thread?.createdAt || thread?.created_at) || now,
      updatedAt: appServerDate(thread?.updatedAt || thread?.updated_at || thread?.recencyAt || thread?.recency_at) || now,
      metadata: {
        mode: "desktop",
        surface: "desktop",
        threadId,
        thread
      }
    };

    const existing = this.conversations.find((item) => item.id === conversation.id);
    if (existing) {
      existing.title = conversation.title || existing.title;
      existing.updatedAt = conversation.updatedAt || existing.updatedAt;
      existing.metadata = { ...existing.metadata, ...conversation.metadata };
      if (options.taskId && !existing.taskIds.includes(options.taskId)) existing.taskIds.unshift(options.taskId);
      return existing;
    }

    this.conversations = [conversation, ...this.conversations].slice(0, 50);
    return conversation;
  }

  async cancelAppServerTask(taskId) {
    const task = this.findAppServerTask(taskId);
    if (!task) {
      if (taskId) throw new Error(`Codex Desktop task ${taskId} is not active.`);
      this.activeAppTurnId = undefined;
      return { ok: true, message: "No active Codex Desktop turn." };
    }

    const threadId = task.metadata?.threadId || this.activeAppThreadId;
    const turnId = task.metadata?.turnId || this.activeAppTurnId;
    if (!threadId || !turnId) return { ok: true, message: "No active Codex Desktop turn." };

    let result;
    try {
      result = await this.appServer.request("turn/interrupt", { threadId, turnId }, { timeoutMs: 6000 });
    } catch (error) {
      if (!/(?:thread|turn).*(?:not found|missing)|already (?:completed|finished)|not active/i.test(error.message)) {
        throw error;
      }
      this.activeAppTurnId = undefined;
      task.status = normalizeTaskStatus("completed");
      task.updatedAt = new Date().toISOString();
      return { ok: true, message: "No active Codex Desktop turn." };
    }
    if (task) {
      task.status = normalizeTaskStatus("cancelled");
      task.updatedAt = new Date().toISOString();
    }
    this.eventBus.publish({
      source: this.source,
      type: "task.completed",
      taskId: task?.id,
      conversationId: threadId ? `codex:${threadId}` : undefined,
      payload: { status: "cancelled", surface: "desktop", result }
    });
    return { ok: true, result };
  }

  findAppServerTask(taskId) {
    if (taskId) {
      const task = this.tasks.find((item) => item.id === taskId);
      if (task?.metadata?.surface === "desktop") return task;
      return undefined;
    }
    return this.tasks.find((item) => item.metadata?.surface === "desktop" && ["running", "queued", "waiting_approval"].includes(item.status));
  }

  handleAppServerNotification(message) {
    const method = message.method;
    const params = message.params || {};

    if (/^(?:mcpServer\/startupStatus|settings|account\/rateLimits|remoteControl\/status)\/(?:updated|changed)$/i.test(method || "")) {
      return;
    }

    if (/tokenUsage\/updated$/i.test(method || "")) {
      this.eventBus.publish({
        source: this.source,
        type: "system.metric.sampled",
        taskId: this.taskIdForAppServer(params),
        conversationId: params.threadId ? `codex:${params.threadId}` : undefined,
        payload: { surface: "desktop", data: { usage: params.tokenUsage || params.usage || params } }
      });
      return;
    }

    if (method === "runtime.connected") {
      this.eventBus.publish({
        source: this.source,
        type: "runtime.connected",
        payload: { surface: "desktop", details: params }
      });
      return;
    }

    if (method === "thread/started") {
      const thread = params.thread;
      if (thread) {
        const conversation = this.upsertAppServerConversation(thread);
        this.activeAppThreadId = appServerThreadId(thread);
        this.eventBus.publish({
          source: this.source,
          type: "conversation.created",
          conversationId: conversation.id,
          payload: { surface: "desktop", thread }
        });
      }
      return;
    }

    if (method === "thread/status/changed") {
      this.handleAppServerThreadStatus(params);
      return;
    }

    if (method === "turn/started") {
      this.handleAppServerTurnStarted(params);
      return;
    }

    if (method === "turn/completed") {
      this.handleAppServerTurnCompleted(params);
      return;
    }

    if (method === "item/agentMessage/delta") {
      this.publishAppServerDelta(params, "assistant");
      return;
    }

    if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/summaryPartAdded") {
      this.publishAppServerProgress(params, params.delta || "reasoning", "reasoning");
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      this.publishAppServerItem(method, params);
      return;
    }

    if (method === "turn/diff/updated" || method === "turn/plan/updated") {
      this.publishAppServerProgress(params, method === "turn/plan/updated" ? "Plan updated." : "Diff updated.", method);
      return;
    }

    if (method === "serverRequest/resolved") {
      this.publishAppServerProgress(params, "Approval resolved.", method);
      return;
    }

    if (method === "error" || method === "warning" || method === "guardianWarning" || method === "configWarning") {
      this.eventBus.publish({
        source: this.source,
        type: method === "error" ? "runtime.error" : "task.progress",
        taskId: this.taskIdForAppServer(params),
        conversationId: params.threadId ? `codex:${params.threadId}` : undefined,
        payload: { surface: "desktop", message: params.summary || params.message || method, appServer: message }
      });
      return;
    }

    if (method?.startsWith("command/exec") || method?.startsWith("process/") || method?.includes("commandExecution")) {
      this.publishAppServerProgress(params, params.delta || params.text || method, method);
      return;
    }

    this.eventBus.publish({
      source: this.source,
      type: "task.progress",
      taskId: this.taskIdForAppServer(params),
      conversationId: params.threadId ? `codex:${params.threadId}` : undefined,
      payload: { surface: "desktop", message: compactEventMethod(method), appServer: message }
    });
  }

  handleAppServerThreadStatus(params) {
    const taskId = this.taskIdForAppServer(params);
    const task = taskId ? this.tasks.find((item) => item.id === taskId) : undefined;
    const status = appServerStatus(params.status);

    if (task) {
      task.status = normalizeTaskStatus(status);
      task.updatedAt = new Date().toISOString();
      if (status === "waiting_approval") task.progress = Math.max(task.progress || 0, 55);
    }

    this.eventBus.publish({
      source: this.source,
      type: "task.progress",
      taskId,
      conversationId: params.threadId ? `codex:${params.threadId}` : undefined,
      payload: {
        surface: "desktop",
        status,
        message: status === "waiting_approval" ? "Codex Desktop waiting for approval." : `Codex Desktop ${status}.`,
        raw: params
      }
    });
  }

  handleAppServerTurnStarted(params) {
    const threadId = params.threadId;
    const turnId = appServerTurnId(params);
    if (threadId) this.activeAppThreadId = threadId;
    if (turnId) this.activeAppTurnId = turnId;

    const taskId = this.taskIdForAppServer(params);
    const task = taskId ? this.tasks.find((item) => item.id === taskId) : undefined;
    if (task) {
      if (turnId) {
        task.metadata.turnId = turnId;
        this.appTurnTasks.set(turnId, task.id);
      }
      task.progress = Math.max(task.progress || 0, 18);
      task.status = normalizeTaskStatus("running");
      task.updatedAt = new Date().toISOString();
    }

    this.eventBus.publish({
      source: this.source,
      type: "task.progress",
      taskId,
      conversationId: threadId ? `codex:${threadId}` : undefined,
      payload: { surface: "desktop", message: "Codex Desktop running.", threadId, turnId, raw: params }
    });
  }

  handleAppServerTurnCompleted(params) {
    const taskId = this.taskIdForAppServer(params);
    const task = taskId ? this.tasks.find((item) => item.id === taskId) : undefined;
    const failed = Boolean(params.turn?.error || params.error);
    if (task) {
      this.cancelPendingAppServerApprovalsForTask(task.id, failed ? "failed" : "completed");
      task.status = normalizeTaskStatus(failed ? "failed" : "completed");
      task.progress = failed ? task.progress || 0 : 100;
      task.updatedAt = new Date().toISOString();
    }
    const completedTurnId = appServerTurnId(params);
    if (!completedTurnId || completedTurnId === this.activeAppTurnId) {
      this.activeAppTurnId = undefined;
    }
    this.eventBus.publish({
      source: this.source,
      type: failed ? "task.failed" : "task.completed",
      taskId,
      conversationId: params.threadId ? `codex:${params.threadId}` : task?.conversationId,
      payload: { surface: "desktop", status: failed ? "failed" : "completed", raw: params, task }
    });
  }

  publishAppServerDelta(params, role) {
    const taskId = this.taskIdForAppServer(params);
    const task = taskId ? this.tasks.find((item) => item.id === taskId) : undefined;
    if (task) {
      task.progress = Math.max(task.progress || 0, 30);
      task.updatedAt = new Date().toISOString();
    }
    this.eventBus.publish({
      source: this.source,
      type: "conversation.message.created",
      taskId,
      conversationId: params.threadId ? `codex:${params.threadId}` : task?.conversationId,
      payload: {
        role,
        content: params.delta || "",
        delta: true,
        surface: "desktop",
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId
      }
    });
  }

  publishAppServerProgress(params, message, kind) {
    const taskId = this.taskIdForAppServer(params);
    const task = taskId ? this.tasks.find((item) => item.id === taskId) : undefined;
    if (task) {
      task.progress = Math.max(task.progress || 0, 28);
      task.updatedAt = new Date().toISOString();
    }
    this.eventBus.publish({
      source: this.source,
      type: kind === "reasoning" ? "task.progress" : "worker.updated",
      taskId,
      conversationId: params.threadId ? `codex:${params.threadId}` : task?.conversationId,
      payload: { surface: "desktop", message: String(message || kind || "Codex Desktop event").slice(0, 700), kind, raw: params }
    });
  }

  publishAppServerItem(method, params) {
    const item = params.item || {};
    const itemType = item.type || params.type || method;
    const text = extractAppServerItemText(item) || compactEventMethod(itemType);
    this.publishAppServerProgress(params, text, itemType);
  }

  async handleAppServerRequest(message) {
    const approval = this.approvalFromAppServerRequest(message);
    if (!approval) {
      throw new Error(`Unsupported Codex app-server request: ${message.method}`);
    }

    return new Promise((resolve) => {
      approval.metadata.resolve = resolve;
      this.recordAppServerApproval(approval);
    });
  }

  approvalFromAppServerRequest(message) {
    const method = message.method || "";
    if (!method.includes("requestApproval")) return undefined;
    const params = message.params || {};
    const taskId = this.taskIdForAppServer(params);
    const command = commandFromApprovalParams(params);
    const kind = appServerApprovalKind(method);
    const rawId = String(params.approvalId || params.itemId || message.id);
    const id = `codex:app:${rawId}`;

    return {
      id,
      source: this.source,
      taskId,
      conversationId: params.threadId ? `codex:${params.threadId}` : undefined,
      title: approvalTitleFor(kind, params, command),
      body: approvalBodyFor(kind, params, command),
      status: "pending",
      requestedAt: new Date().toISOString(),
      metadata: {
        mode: "desktop",
        surface: "desktop",
        kind,
        method,
        requestId: message.id,
        rawId,
        command,
        threadId: stringValue(params.threadId),
        turnId: stringValue(params.turnId),
        itemId: stringValue(params.itemId),
        approvalId: stringValue(params.approvalId),
        params
      }
    };
  }

  recordAppServerApproval(approval) {
    const now = new Date().toISOString();
    const existing = this.approvals.find((item) => item.id === approval.id);
    const next = existing
      ? { ...existing, ...approval, status: "pending", requestedAt: existing.requestedAt || approval.requestedAt, updatedAt: now }
      : { ...approval, updatedAt: now };

    this.appServerApprovals.set(next.id, next);
    this.approvals = [
      next,
      ...this.approvals.filter((item) => item.id !== next.id)
    ].slice(0, 50);

    const task = next.taskId ? this.tasks.find((item) => item.id === next.taskId) : undefined;
    if (task) {
      task.status = normalizeTaskStatus("waiting_approval");
      task.progress = Math.max(task.progress || 0, 55);
      task.updatedAt = now;
      task.metadata.pendingApprovalId = next.id;
    }

    this.eventBus.publish({
      source: this.source,
      type: "approval.requested",
      taskId: next.taskId,
      conversationId: next.conversationId,
      payload: {
        approval_id: next.id,
        approvalId: next.id,
        command: next.metadata.command || next.title,
        question: next.body,
        taskId: next.taskId,
        kind: next.metadata.kind,
        surface: "desktop",
        raw: next.metadata.params
      }
    });

    this.eventBus.publish({
      source: this.source,
      type: "task.progress",
      taskId: next.taskId,
      conversationId: next.conversationId,
      payload: {
        message: "Codex Desktop waiting for approval.",
        status: "waiting_approval",
        surface: "desktop",
        approvalId: next.id
      }
    });
  }

  async decideAppServerApproval(input) {
    const pending = this.findPendingAppServerApproval(input.approvalId);
    if (!pending) {
      throw new Error("No pending Codex Desktop approval.");
    }

    const decision = normalizeAppServerApprovalDecision(input, pending);
    const now = new Date().toISOString();
    pending.status = decision.status;
    pending.resolvedAt = now;
    pending.updatedAt = now;
    pending.metadata = {
      ...pending.metadata,
      decision: decision.value,
      approvalScope: input.approvalScope,
      decidedAt: now
    };

    if (decision.value === "acceptForSession") {
      this.sessionApprovalPolicyOverride = "never";
    }

    const resolver = pending.metadata.resolve;
    delete pending.metadata.resolve;
    if (resolver) resolver(decision.response);

    const task = pending.taskId ? this.tasks.find((item) => item.id === pending.taskId) : undefined;
    if (task) {
      task.status = normalizeTaskStatus(decision.approved ? "running" : "blocked");
      task.updatedAt = now;
      delete task.metadata.pendingApprovalId;
    }

    this.eventBus.publish({
      source: this.source,
      type: "approval.resolved",
      taskId: pending.taskId,
      conversationId: pending.conversationId,
      payload: {
        approvalId: pending.id,
        decision: decision.value,
        status: pending.status,
        surface: "desktop"
      }
    });

    return pending;
  }

  findPendingAppServerApproval(approvalId) {
    if (!approvalId) {
      return this.approvals.find((approval) => approval.status === "pending" && approval.metadata?.surface === "desktop");
    }
    const stripped = String(approvalId).replace(/^codex:app:/, "");
    return this.approvals.find((approval) => {
      if (approval.status !== "pending" || approval.metadata?.surface !== "desktop") return false;
      const rawId = String(approval.metadata?.rawId || "").replace(/^codex:app:/, "");
      return approval.id === approvalId || approval.id === `codex:app:${stripped}` || rawId === stripped;
    });
  }

  cancelPendingAppServerApprovalsForTask(taskId, reason) {
    const now = new Date().toISOString();
    for (const approval of this.approvals) {
      if (approval.taskId !== taskId || approval.status !== "pending" || approval.metadata?.surface !== "desktop") continue;
      approval.status = reason === "completed" ? "expired" : "cancelled";
      approval.resolvedAt = now;
      approval.updatedAt = now;
      approval.metadata = { ...approval.metadata, closedByTaskStatus: reason };
      this.eventBus.publish({
        source: this.source,
        type: "approval.resolved",
        taskId,
        conversationId: approval.conversationId,
        payload: { approvalId: approval.id, status: approval.status, reason, surface: "desktop" }
      });
    }
  }

  taskIdForAppServer(params = {}) {
    if (params.turnId && this.appTurnTasks.has(params.turnId)) return this.appTurnTasks.get(params.turnId);
    if (params.threadId && this.appThreadTasks.has(params.threadId)) return this.appThreadTasks.get(params.threadId);
    return undefined;
  }

  handleAppServerStderr(line) {
    if (!line || line.includes("\"level\":\"WARN\"") || line.startsWith("WARNING:")) return;
    this.eventBus.publish({
      source: this.source,
      type: "runtime.error",
      payload: { surface: "desktop", error: line }
    });
  }

  publishAppServerError(error) {
    this.eventBus.publish({
      source: this.source,
      type: "runtime.error",
      payload: { surface: "desktop", error: error.message }
    });
  }

  handleAppServerExit(result) {
    const now = new Date().toISOString();
    for (const task of this.tasks) {
      if (task.metadata?.surface !== "desktop" || !["running", "queued", "waiting_approval"].includes(task.status)) continue;
      task.status = "failed";
      task.updatedAt = now;
      this.cancelPendingAppServerApprovalsForTask(task.id, "failed");
      this.eventBus.publish({
        source: this.source,
        type: "task.failed",
        taskId: task.id,
        conversationId: task.conversationId,
        payload: { surface: "desktop", error: "Codex app-server stopped.", result }
      });
    }
    this.activeAppTurnId = undefined;
    this.appTurnTasks.clear();
    this.appThreadTasks.clear();
    this.eventBus.publish({
      source: this.source,
      type: "runtime.error",
      payload: { surface: "desktop", error: "Codex app-server stopped.", result }
    });
  }

  startCliRun(input) {
    const content = input.content || input.prompt || input.message;
    if (!content) throw new Error("Codex message is empty.");
    const reasoning = normalizeReasoning(input.reasoning);
    const approvalPolicy = input.approvalPolicy || this.sessionApprovalPolicyOverride || this.config.approvalPolicy;
    const cliPrompt = withReasoningDirective(content, reasoning);

    const now = new Date().toISOString();
    const task = {
      id: `codex:cli:${Date.now()}`,
      source: this.source,
      agentId: "codex:cli",
      conversationId: undefined,
      title: (input.title || content).slice(0, 80),
      status: "running",
      progress: 5,
      createdAt: now,
      updatedAt: now,
      metadata: {
        mode: "cli",
        surface: "cli",
        resumeLast: Boolean(input.resumeLast),
        prompt: content,
        reasoning,
        approvalPolicy
      }
    };

    const conversation = {
      id: `codex:conversation:${Date.now()}`,
      source: this.source,
      title: task.title,
      taskIds: [task.id],
      createdAt: now,
      updatedAt: now,
      metadata: { mode: "cli", surface: "cli" }
    };

    task.conversationId = conversation.id;
    this.tasks.unshift(task);
    this.conversations.unshift(conversation);
    this.tasks = this.tasks.slice(0, 50);
    this.conversations = this.conversations.slice(0, 50);

    this.eventBus.publish({
      source: this.source,
      type: "task.created",
      taskId: task.id,
      agentId: task.agentId,
      conversationId: conversation.id,
      payload: task
    });

    this.eventBus.publish({
      source: this.source,
      type: "conversation.message.created",
      taskId: task.id,
      conversationId: conversation.id,
      payload: { role: "user", content, reasoning }
    });

    const run = this.cli.start(cliPrompt, {
      taskId: task.id,
      resumeLast: input.resumeLast,
      approvalPolicy,
      onEvent: (event) => this.handleCliEvent(task.id, event),
      onStderr: (line) => this.handleCliStderr(task.id, line),
      onError: (error) => this.finishCliTask(task.id, "failed", { error: error.message }),
      onExit: (result) => this.handleCliExit(task.id, result)
    });

    task.metadata.pid = run.pid;
    task.metadata.startedAt = run.startedAt;
    task.metadata.command = run.args.join(" ");

    return {
      task,
      message: {
        id: `codex:message:${Date.now()}`,
        conversationId: conversation.id,
        source: this.source,
        role: "user",
        content,
        createdAt: now,
        metadata: { taskId: task.id, pid: run.pid, reasoning }
      }
    };
  }

  handleCliEvent(taskId, event) {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) return;

    task.updatedAt = new Date().toISOString();
    const approval = this.approvalFromCliEvent(task, event);
    if (approval) {
      this.recordCliApproval(task, approval);
      return;
    }

    const threadId = event.thread_id || event.threadId;
    if (event.type === "thread.started" && threadId) {
      const conversationId = `codex:${threadId}`;
      task.conversationId = conversationId;
      const conversation = this.conversations.find((item) => item.taskIds.includes(task.id));
      if (conversation) {
        conversation.id = conversationId;
        conversation.metadata.threadId = threadId;
        conversation.metadata.surface = "cli";
        conversation.updatedAt = task.updatedAt;
      }
      this.eventBus.publish({
        source: this.source,
        type: "conversation.created",
        taskId,
        conversationId,
        payload: { threadId }
      });
      return;
    }

    if (event.type === "turn.started") {
      task.progress = Math.max(task.progress || 0, 12);
      this.publishCliProgress(task, event, "Codex started.");
      return;
    }

    if (event.type === "item.completed") {
      task.progress = Math.max(task.progress || 0, 35);
      const itemType = event.item?.type || "item";
      const text = extractCliText(event) || `${itemType} completed`;
      const isToolEvent = itemType.includes("tool") || itemType.includes("command");
      const eventType = isToolEvent ? "worker.updated" : "conversation.message.created";
      this.eventBus.publish({
        source: this.source,
        type: eventType,
        taskId,
        conversationId: task.conversationId,
        payload: isToolEvent
          ? { message: text, cliEvent: event }
          : { role: "assistant", content: text, cliEvent: event }
      });
      return;
    }

    if (event.type === "turn.completed") {
      this.finishCliTask(taskId, "completed", { cliEvent: event });
      return;
    }

    if (event.type === "turn.failed") {
      this.finishCliTask(taskId, "failed", { error: extractCliText(event), cliEvent: event });
      return;
    }

    if (event.type === "error") {
      this.eventBus.publish({
        source: this.source,
        type: "runtime.error",
        taskId,
        conversationId: task.conversationId,
        payload: { error: extractCliText(event), cliEvent: event }
      });
      return;
    }

    this.publishCliProgress(task, event, extractCliText(event) || event.type || "Codex event");
  }

  handleCliStderr(taskId, line) {
    if (!line || line.includes("WARN")) return;
    const task = this.tasks.find((item) => item.id === taskId);
    this.eventBus.publish({
      source: this.source,
      type: "runtime.error",
      taskId,
      conversationId: task?.conversationId,
      payload: { error: line }
    });
  }

  handleCliExit(taskId, result) {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task || !["running", "queued", "waiting_approval"].includes(task.status)) return;
    if (task.status === "waiting_approval" || this.findPendingCliApproval(undefined, task.id)) {
      return;
    }
    this.finishCliTask(taskId, result.code === 0 ? "completed" : "failed", result);
  }

  publishCliProgress(task, event, message) {
    this.eventBus.publish({
      source: this.source,
      type: "task.progress",
      taskId: task.id,
      conversationId: task.conversationId,
      payload: { message, cliEvent: event }
    });
  }

  finishCliTask(taskId, status, payload = {}) {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) return;
    if (status !== "waiting_approval") {
      this.cancelPendingApprovalsForTask(taskId, status);
    }
    task.status = normalizeTaskStatus(status);
    task.progress = status === "completed" ? 100 : task.progress || 0;
    task.updatedAt = new Date().toISOString();
    this.eventBus.publish({
      source: this.source,
      type: status === "completed" ? "task.completed" : "task.failed",
      taskId,
      conversationId: task.conversationId,
      payload: { ...payload, task }
    });
  }

  approvalFromCliEvent(task, event) {
    const kind = approvalKindForCliEvent(event);
    if (!kind) return undefined;

    const params = cliEventParams(event);
    const rawId = approvalRawId(event, params, task);
    const id = rawId.startsWith("codex:approval:") ? rawId : `codex:approval:${rawId}`;
    const command = commandFromApprovalParams(params);
    const title = approvalTitleFor(kind, params, command);
    const body = approvalBodyFor(kind, params, command);

    return {
      id,
      source: this.source,
      taskId: task.id,
      conversationId: task.conversationId,
      title,
      body,
      status: "pending",
      requestedAt: new Date().toISOString(),
      metadata: {
        kind,
        rawId,
        command,
        cwd: stringValue(params.cwd),
        reason: stringValue(params.reason),
        threadId: stringValue(params.threadId || params.thread_id || params.conversationId),
        turnId: stringValue(params.turnId || params.turn_id),
        itemId: stringValue(params.itemId || params.item_id),
        callId: stringValue(params.callId || params.call_id),
        params,
        cliEvent: event
      }
    };
  }

  recordCliApproval(task, approval) {
    const now = new Date().toISOString();
    const existing = this.approvals.find((item) => item.id === approval.id);
    const next = existing
      ? { ...existing, ...approval, status: "pending", requestedAt: existing.requestedAt || approval.requestedAt, updatedAt: now }
      : { ...approval, updatedAt: now };

    this.approvals = [
      next,
      ...this.approvals.filter((item) => item.id !== next.id)
    ].slice(0, 50);

    task.status = normalizeTaskStatus("waiting_approval");
    task.progress = Math.max(task.progress || 0, 55);
    task.updatedAt = now;
    task.metadata.pendingApprovalId = next.id;

    this.eventBus.publish({
      source: this.source,
      type: "approval.requested",
      taskId: task.id,
      conversationId: task.conversationId,
      payload: {
        approval_id: next.id,
        approvalId: next.id,
        command: next.metadata.command || next.title,
        question: next.body,
        taskId: task.id,
        kind: next.metadata.kind,
        raw: next.metadata.params
      }
    });

    this.eventBus.publish({
      source: this.source,
      type: "task.progress",
      taskId: task.id,
      conversationId: task.conversationId,
      payload: {
        message: "Codex waiting for approval.",
        status: "waiting_approval",
        approvalId: next.id
      }
    });
  }

  async decideCliApproval(input) {
    const pending = this.findPendingCliApproval(input.approvalId);
    if (!pending) {
      const idle = {
        id: input.approvalId || `codex:approval:none:${Date.now()}`,
        source: this.source,
        title: "No pending Codex approval",
        body: "Codex is not waiting for approval right now.",
        status: "idle",
        requestedAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(),
        metadata: { noop: true }
      };
      this.eventBus.publish({
        source: this.source,
        type: "task.progress",
        payload: { message: "No pending Codex approval." }
      });
      return idle;
    }

    const decision = normalizeCliApprovalDecision(input);
    const now = new Date().toISOString();
    pending.status = decision.status;
    pending.resolvedAt = now;
    pending.updatedAt = now;
    pending.metadata = {
      ...pending.metadata,
      decision: decision.value,
      legacyDecision: decision.legacyValue,
      approvalScope: input.approvalScope,
      decidedAt: now
    };

    if (decision.value === "acceptForSession") {
      this.sessionApprovalPolicyOverride = "never";
    }

    const task = this.tasks.find((item) => item.id === pending.taskId);
    const wroteToProcess = this.cli.write(pending.taskId, decision.stdinResponse);
    let resumeTaskId;

    if (decision.value === "cancel") {
      await this.cancelTask(pending.taskId);
    } else if (!wroteToProcess && task?.status === "waiting_approval") {
      this.cli.stop(pending.taskId);
      task.status = normalizeTaskStatus(decision.approved ? "running" : "blocked");
      task.updatedAt = now;
      const resume = this.startCliRun({
        content: approvalResumePrompt(pending, decision),
        title: `Approval ${decision.approved ? "accepted" : "denied"}: ${pending.title}`,
        resumeLast: true,
        reasoning: task.metadata?.reasoning,
        approvalPolicy: decision.approved ? "never" : this.config.approvalPolicy
      });
      resumeTaskId = resume.task.id;
    } else if (task) {
      task.status = normalizeTaskStatus(decision.approved ? "running" : "blocked");
      task.updatedAt = now;
      delete task.metadata.pendingApprovalId;
    }

    this.eventBus.publish({
      source: this.source,
      type: "approval.resolved",
      taskId: pending.taskId,
      conversationId: pending.conversationId,
      payload: {
        approvalId: pending.id,
        decision: decision.value,
        status: pending.status,
        wroteToProcess,
        resumeTaskId
      }
    });

    return {
      ...pending,
      metadata: {
        ...pending.metadata,
        wroteToProcess,
        resumeTaskId
      }
    };
  }

  findPendingCliApproval(approvalId, taskId) {
    const stripped = approvalId ? String(approvalId).replace(/^codex:approval:/, "") : undefined;
    return this.approvals.find((approval) => {
      if (approval.status !== "pending") return false;
      if (taskId && approval.taskId !== taskId) return false;
      if (!stripped) return true;
      const rawId = String(approval.metadata?.rawId || "").replace(/^codex:approval:/, "");
      return approval.id === approvalId || approval.id === `codex:approval:${stripped}` || rawId === stripped;
    });
  }

  cancelPendingApprovalsForTask(taskId, reason) {
    const now = new Date().toISOString();
    for (const approval of this.approvals) {
      if (approval.taskId !== taskId || approval.status !== "pending") continue;
      approval.status = reason === "completed" ? "expired" : "cancelled";
      approval.resolvedAt = now;
      approval.updatedAt = now;
      approval.metadata = { ...approval.metadata, closedByTaskStatus: reason };
      this.eventBus.publish({
        source: this.source,
        type: "approval.resolved",
        taskId,
        conversationId: approval.conversationId,
        payload: { approvalId: approval.id, status: approval.status, reason }
      });
    }
  }

  async sendApiMessage(input) {
    const content = input.content || input.prompt || input.message;
    if (!content) throw new Error("Codex message is empty.");

    const sessionId = await this.ensureApiSession(input.conversationId);
    const model = this.config.model;
    const reasoning = normalizeReasoning(input.reasoning);
    const payload = {
      session_id: sessionId,
      message: content,
      profile: this.config.profile,
      ...reasoningPayload(reasoning),
      ...(model ? { model, explicit_model_pick: true } : {})
    };
    const endpoint = model ? `${this.config.apiPrefix}/chat/start` : `${this.config.apiPrefix}/chat`;
    const result = await this.client.request(endpoint, {
      method: "POST",
      body: payload
    });

    const streamId = result?.stream_id || result?.active_stream_id;
    this.activeStreamId = streamId;

    this.eventBus.publish({
      source: this.source,
      type: "conversation.message.created",
      conversationId: `codex:${sessionId}`,
      payload: { role: "user", content, sessionId, streamId, reasoning }
    });

    if (streamId) {
      this.followApiChatStream(streamId, sessionId);
    } else if (result) {
      this.eventBus.publish({
        source: this.source,
        type: "conversation.message.created",
        conversationId: `codex:${sessionId}`,
        payload: { role: "assistant", result }
      });
    }

    return {
      id: `codex-message:${Date.now()}`,
      conversationId: `codex:${sessionId}`,
      source: this.source,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
      metadata: { result, sessionId, streamId, reasoning }
    };
  }

  async ensureApiSession(conversationId) {
    const explicitSessionId = stripCodexPrefix(conversationId);
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
      throw new Error("Codex did not return session_id from /api/session/new.");
    }

    this.activeSessionId = String(sessionId);
    this.eventBus.publish({
      source: this.source,
      type: "conversation.created",
      conversationId: `codex:${sessionId}`,
      payload: { sessionId }
    });
    return this.activeSessionId;
  }

  async findApiPendingApproval(sessionId) {
    const data = await this.client.request(`${this.config.apiPrefix}/approval/pending?session_id=${encodeURIComponent(sessionId)}`);
    const pending = data?.pending;
    if (!pending) return undefined;
    return {
      id: String(pending.approval_id),
      command: pending.command,
      question: pending.question
    };
  }

  followApiChatStream(streamId, sessionId) {
    this.client.streamSse(`${this.config.apiPrefix}/chat/stream?stream_id=${encodeURIComponent(streamId)}`, async (event) => {
      this.eventBus.publish({
        source: this.source,
        type: mapChatEventType(event.event),
        conversationId: `codex:${sessionId}`,
        payload: {
          streamId,
          event: event.event,
          data: event.data
        },
        raw: event.raw
      });
    }).catch((error) => {
      this.eventBus.publish({
        source: this.source,
        type: "runtime.error",
        conversationId: `codex:${sessionId}`,
        payload: { streamId, error: error.message }
      });
    });
  }
}

function normalizeCodexSurface(value) {
  const normalized = String(value || "").toLowerCase();
  if (["desktop", "app", "app-server", "appserver"].includes(normalized)) return "desktop";
  if (normalized === "cli") return "cli";
  return "cli";
}

function appServerReasoningEffort(reasoning) {
  const map = {
    low: "low",
    med: "medium",
    high: "high",
    xhigh: "xhigh"
  };
  return map[reasoning] || undefined;
}

function appServerThreadFromResponse(response, fallbackId) {
  const thread = response?.thread || response;
  const id = appServerThreadId(thread) || fallbackId;
  return {
    ...(thread && typeof thread === "object" ? thread : {}),
    id
  };
}

function appServerThreadId(thread) {
  return stringValue(thread?.id || thread?.threadId || thread?.thread_id);
}

function appServerThreadTitle(thread) {
  return stringValue(thread?.title || thread?.name || thread?.metadata?.title || thread?.summary);
}

function appServerDate(value) {
  if (!value) return undefined;
  if (typeof value === "number") return new Date(value > 100000000000 ? value : value * 1000).toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function sortAppServerThreads(value) {
  if (!Array.isArray(value)) return [];
  return [...value].sort((a, b) => appServerThreadTimestamp(b) - appServerThreadTimestamp(a));
}

function appServerThreadTimestamp(thread) {
  return timestampMs(
    appServerDate(thread?.updatedAt || thread?.updated_at || thread?.recencyAt || thread?.recency_at || thread?.createdAt || thread?.created_at)
  );
}

function timestampMs(value) {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function appServerTurnId(value) {
  const turn = value?.turn || value;
  return stringValue(turn?.id || turn?.turnId || turn?.turn_id);
}

function appServerStatus(status) {
  const type = String(status?.type || status || "").toLowerCase();
  const activeFlags = Array.isArray(status?.activeFlags) ? status.activeFlags.map((item) => String(item).toLowerCase()) : [];
  if (activeFlags.includes("waitingonapproval")) return "waiting_approval";
  if (activeFlags.includes("waitingonuserinput")) return "waiting_approval";
  if (type === "active") return "running";
  if (type === "idle") return "completed";
  if (type === "systemerror") return "failed";
  return type || "running";
}

function appServerApprovalKind(method) {
  if (method.includes("commandExecution")) return "command";
  if (method.includes("fileChange")) return "file-change";
  if (method.includes("permissions")) return "permissions";
  return "generic";
}

function normalizeAppServerApprovalDecision(input, approval) {
  const requested = String(input.approvalDecision || input.decision || "").toLowerCase();
  const approve = input.decision === "approve";
  const session = input.approvalScope === "session" || requested === "acceptforsession" || requested === "approved_for_session";
  const cancel = requested === "cancel" || requested === "abort";
  const method = approval.metadata?.method || "";

  if (method.includes("permissions")) {
    if (approve) {
      return {
        approved: true,
        value: session ? "acceptForSession" : "accept",
        status: "approved",
        response: {
          permissions: approval.metadata?.params?.permissions || {},
          scope: session ? "session" : "turn"
        }
      };
    }
    return {
      approved: false,
      value: "decline",
      status: cancel ? "cancelled" : "rejected",
      response: {
        permissions: { fileSystem: null, network: null },
        scope: "turn"
      }
    };
  }

  if (approve) {
    return {
      approved: true,
      value: session ? "acceptForSession" : "accept",
      status: "approved",
      response: { decision: session ? "acceptForSession" : "accept" }
    };
  }

  return {
    approved: false,
    value: cancel ? "cancel" : "decline",
    status: cancel ? "cancelled" : "rejected",
    response: { decision: cancel ? "cancel" : "decline" }
  };
}

function extractAppServerItemText(item) {
  if (!item || typeof item !== "object") return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.message === "string") return item.message;
  if (typeof item.output === "string") return item.output;
  if (typeof item.command === "string") return item.command;
  if (Array.isArray(item.content)) {
    return item.content
      .map((part) => part?.text || part?.content || "")
      .filter(Boolean)
      .join(" ")
      .slice(0, 700);
  }
  if (item.type) return String(item.type);
  return "";
}

function compactEventMethod(method) {
  return String(method || "Codex Desktop event")
    .replace(/^item\//, "")
    .replace(/^turn\//, "")
    .replace(/^thread\//, "")
    .replace(/[/-]/g, " ")
    .slice(0, 120);
}

function approvalKindForCliEvent(event) {
  if (!event || typeof event !== "object") return "";
  const method = String(event.method || event.type || event.name || "");
  const itemType = String(event.item?.type || event.payload?.type || "");
  const signal = `${method} ${itemType}`.toLowerCase();
  if (!signal.includes("approval")) return "";
  if (/(completed|resolved|decision|reviewcompleted|autoapprovalreview)/i.test(signal)) return "";

  if (signal.includes("commandexecution") || signal.includes("execcommand") || signal.includes("exec_command")) return "command";
  if (signal.includes("filechange") || signal.includes("applypatch") || signal.includes("apply_patch") || signal.includes("patch")) return "file-change";
  if (signal.includes("permission")) return "permissions";
  if (signal.includes("request") || signal.includes("pending") || signal.includes("approval")) return "generic";
  return "";
}

function cliEventParams(event) {
  const params = event?.params || event?.payload?.params || event?.payload || event?.item?.params || event?.item || {};
  return params && typeof params === "object" ? params : {};
}

function approvalRawId(event, params, task) {
  const explicit = params.approvalId
    || params.approval_id
    || event.id
    || event.requestId
    || params.requestId
    || params.callId
    || params.call_id
    || params.itemId
    || params.item_id;
  if (explicit) return String(explicit);
  return `${task.id}:${Date.now()}`;
}

function commandFromApprovalParams(params) {
  if (Array.isArray(params.command)) return params.command.map(String).join(" ");
  if (typeof params.command === "string") return params.command;
  if (Array.isArray(params.argv)) return params.argv.map(String).join(" ");
  if (Array.isArray(params.parsedCmd)) return params.parsedCmd.map((item) => item?.cmd || item?.name || "").filter(Boolean).join(" ");
  if (Array.isArray(params.commandActions)) {
    return params.commandActions
      .map((item) => item?.cmd || item?.command || item?.name || item?.action || "")
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function approvalTitleFor(kind, params, command) {
  if (command) return command.slice(0, 140);
  if (kind === "command") return "Codex command approval";
  if (kind === "file-change") {
    const files = Object.keys(params.fileChanges || {});
    return files.length ? `Codex file change: ${files.slice(0, 2).join(", ")}` : "Codex file change approval";
  }
  if (kind === "permissions") return "Codex permissions approval";
  return "Codex approval";
}

function approvalBodyFor(kind, params, command) {
  const lines = [];
  if (params.reason) lines.push(String(params.reason));
  if (command) lines.push(`Command: ${command}`);
  if (params.cwd) lines.push(`Cwd: ${stringValue(params.cwd)}`);
  if (params.grantRoot) lines.push(`Grant root: ${stringValue(params.grantRoot)}`);
  if (params.permissions) lines.push(`Permissions: ${summarizeForApproval(params.permissions, 160)}`);

  const fileChanges = Object.keys(params.fileChanges || {});
  if (fileChanges.length) lines.push(`Files: ${fileChanges.slice(0, 6).join(", ")}${fileChanges.length > 6 ? "..." : ""}`);

  if (!lines.length && kind === "file-change") lines.push("Codex wants to apply a file change.");
  if (!lines.length && kind === "permissions") lines.push("Codex wants additional permissions.");
  if (!lines.length) lines.push("Codex is waiting for your decision.");

  return lines.join("\n").slice(0, 700);
}

function normalizeCliApprovalDecision(input) {
  const requested = String(input.approvalDecision || input.decision || "").toLowerCase();
  const approve = input.decision === "approve";
  const session = input.approvalScope === "session" || requested === "acceptforsession" || requested === "approved_for_session";
  const cancel = requested === "cancel" || requested === "abort";

  if (approve) {
    return {
      approved: true,
      value: session ? "acceptForSession" : "accept",
      legacyValue: session ? "approved_for_session" : "approved",
      status: "approved",
      stdinResponse: "y\n"
    };
  }

  if (cancel) {
    return {
      approved: false,
      value: "cancel",
      legacyValue: "abort",
      status: "cancelled",
      stdinResponse: "\u0003"
    };
  }

  return {
    approved: false,
    value: "decline",
    legacyValue: "denied",
    status: "rejected",
    stdinResponse: "n\n"
  };
}

function approvalResumePrompt(approval, decision) {
  const command = approval.metadata?.command || approval.title || "the requested action";
  const context = approval.body ? `\n\nApproval context:\n${approval.body}` : "";

  if (decision.value === "decline") {
    return [
      "Hermes Control decision: the previous Codex approval request was denied.",
      `Do not run this action: ${command}.`,
      "Continue safely without it, or explain exactly what is blocked."
    ].join("\n");
  }

  return [
    `Hermes Control decision: ${decision.value === "acceptForSession" ? "approved for this control session" : "approved once"}.`,
    `Proceed only with the previously requested action if it is still necessary: ${command}.`,
    "Do not broaden the action beyond that approval. If a different risky action is needed, stop and ask again.",
    context
  ].join("\n");
}

function stripCodexPrefix(value) {
  if (!value) return undefined;
  return String(value).replace(/^codex:/, "");
}

function stripDesktopConversationId(value) {
  if (!value) return undefined;
  return String(value)
    .replace(/^codex:desktop:/, "")
    .replace(/^codex:/, "");
}

function desktopDraftKey(clientId) {
  const normalized = String(clientId || "").trim();
  return normalized || "legacy-client";
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

function withReasoningDirective(content, reasoning) {
  if (!reasoning) return content;
  const guidance = {
    low: "Use low reasoning effort. Prefer a fast, direct answer unless safety or correctness requires more detail.",
    med: "Use medium reasoning effort. Balance speed with correctness and keep the visible answer concise.",
    high: "Use high reasoning effort. Think carefully through implementation details before acting.",
    xhigh: "Use extra-high reasoning effort. Be exhaustive about correctness, verification, and edge cases before acting."
  };
  return `[Hermes Control reasoning: ${reasoning.toUpperCase()}] ${guidance[reasoning]}\n\n${content}`;
}

function mapChatEventType(eventName) {
  if (eventName === "approval") return "approval.requested";
  if (eventName === "done" || eventName === "stream_end") return "task.completed";
  if (eventName === "apperror") return "task.failed";
  if (eventName === "token") return "conversation.message.created";
  if (eventName === "tool" || eventName === "tool_complete") return "worker.updated";
  return "task.progress";
}

function extractCliText(event) {
  if (!event) return "";
  if (typeof event.message === "string") return event.message;
  if (typeof event.text === "string") return event.text;
  if (typeof event.delta === "string") return event.delta;
  if (typeof event.output === "string") return event.output;
  if (typeof event.error?.message === "string") return event.error.message;
  if (typeof event.item?.message === "string") return event.item.message;
  if (typeof event.item?.text === "string") return event.item.text;
  if (typeof event.item?.summary === "string") return event.item.summary;

  const content = event.item?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => part?.text || part?.content || part?.message || "")
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  return "";
}

function stringValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summarizeForApproval(value, limit) {
  const text = stringValue(value).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}
