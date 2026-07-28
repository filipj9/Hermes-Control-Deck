import { CodexCliClient } from "./CodexCliClient.mjs";

const MAX_ITEMS = 50;

export class CodexRuntimeAdapter {
  constructor(config, eventBus) {
    this.source = "codex";
    this.config = config;
    this.eventBus = eventBus;
    this.cli = new CodexCliClient(config);
    this.tasks = [];
    this.conversations = [];
    this.approvals = [];
    this.sessionApprovalPolicyOverride = undefined;
  }

  async health() {
    const cli = await this.cli.describeRuntime();
    return {
      source: this.source,
      ok: cli.available,
      status: cli.available ? "connected" : "offline",
      details: {
        mode: "cli",
        surface: "cli",
        cli,
        capabilities: this.capabilities()
      }
    };
  }

  capabilities() {
    return [
      "prompt",
      "stream",
      "stop",
      "approve",
      "deny",
      "new-task",
      "continue",
      "list-tasks",
      "list-sessions"
    ];
  }

  async listAgents() {
    const health = await this.health();
    const working = this.tasks.some((task) => ["running", "waiting_approval"].includes(task.status));
    const status = !health.ok ? "offline" : working ? "working" : "idle";
    return [{
      id: "codex:cli",
      source: this.source,
      displayName: "Codex CLI",
      status,
      capabilities: this.capabilities(),
      metadata: {
        mode: "cli",
        surface: "cli",
        runtime: health.details.cli
      }
    }];
  }

  async listTasks() {
    return this.tasks.slice(0, MAX_ITEMS);
  }

  async listWorkers() {
    return [];
  }

  async listApprovals() {
    return this.approvals.filter((approval) => approval.status === "pending");
  }

  async listConversations() {
    return this.conversations.slice(0, MAX_ITEMS);
  }

  async startTask(input) {
    return this.startCliRun(input);
  }

  async sendMessage(input) {
    return this.startCliRun(input);
  }

  async cancelTask(taskId) {
    const task = this.tasks.find((item) => item.id === taskId)
      || this.tasks.find((item) => ["running", "waiting_approval"].includes(item.status));
    if (!task) return { ok: true, metadata: { noop: true } };

    const stopped = await this.cli.stop(task.id, this.config.stopTimeoutMs);
    if (!stopped) {
      this.finishCliTask(task.id, "failed", { error: "Codex process could not be stopped." });
      throw new Error("Codex process could not be stopped.");
    }

    this.finishCliTask(task.id, "cancelled", { stopped: true });
    return { ok: true, taskId: task.id, stopped: true };
  }

  async decideApproval(input) {
    const pending = this.findPendingApproval(input.approvalId);
    if (!pending) {
      return {
        id: input.approvalId || `codex:approval:none:${Date.now()}`,
        source: this.source,
        title: "No pending Codex approval",
        body: "Codex CLI is not waiting for approval right now.",
        status: "idle",
        requestedAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(),
        metadata: { noop: true }
      };
    }

    const decision = normalizeApprovalDecision(input);
    const task = this.tasks.find((item) => item.id === pending.taskId);
    const wroteToProcess = this.cli.write(pending.taskId, decision.stdinResponse);
    const now = new Date().toISOString();

    pending.status = decision.approved ? "approved" : "rejected";
    pending.resolvedAt = now;
    pending.updatedAt = now;
    pending.metadata = { ...pending.metadata, decision: decision.value, wroteToProcess };

    if (decision.value === "acceptForSession") {
      this.sessionApprovalPolicyOverride = "never";
    }

    if (task) {
      task.status = decision.approved ? "running" : "blocked";
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
        wroteToProcess
      }
    });

    if (!wroteToProcess && task?.status === "running") {
      this.eventBus.publish({
        source: this.source,
        type: "runtime.error",
        taskId: task.id,
        payload: { error: "Codex approval process was no longer writable; resume is required." }
      });
    }

    return pending;
  }

  async runAction(action, payload = {}) {
    if (action === "status") return this.health();
    if (action === "agents") return this.listAgents();
    if (action === "tasks" || action === "kanban") return this.listTasks();
    if (action === "sessions") return this.listConversations();
    if (action === "events") return this.eventBus.list(50).filter((event) => event.source === this.source);
    if (action === "models") throw unsupported("models", "Codex CLI does not expose a stable model-list contract here.");
    if (action === "metrics") return (await this.health()).details;
    if (action === "new-task") return this.startCliRun({ ...payload, resumeLast: false });
    if (action === "continue") return this.startCliRun({ ...payload, resumeLast: true });
    if (action === "stop") return this.cancelTask(payload.taskId);
    if (action === "send") return this.sendMessage(payload);
    if (action === "approve" || action === "reject") {
      return this.decideApproval({
        ...payload,
        approvalId: payload.approvalId,
        decision: action === "approve" ? "approve" : "reject"
      });
    }
    if (action === "workspace" || action === "open") throw unsupported(action, "This action is not supported by the CLI-first release.");
    throw new Error(`Unknown Codex CLI action: ${action}`);
  }

  async *subscribeEvents() {
    yield {
      id: `codex-cli-subscribe:${Date.now()}`,
      source: this.source,
      type: "runtime.connected",
      timestamp: new Date().toISOString(),
      payload: { mode: "cli", surface: "cli" }
    };
  }

  startCliRun(input) {
    const content = input.content || input.prompt || input.message;
    if (!content) throw new Error("Codex message is empty.");
    if (String(content).length > this.config.maxPromptChars) throw new Error("Codex prompt exceeds configured limit.");
    if (!this.cli.isAvailable()) throw new Error("Codex CLI executable missing. Set CODEX_EXECUTABLE or add codex to PATH.");

    const active = this.tasks.find((task) => ["running", "waiting_approval"].includes(task.status));
    if (active && !this.config.allowConcurrentRuns) {
      throw new Error("Codex CLI already has an active run for this server.");
    }

    const reasoning = normalizeReasoning(input.reasoning);
    const approvalPolicy = input.approvalPolicy
      || this.sessionApprovalPolicyOverride
      || this.config.approvalPolicy;
    const now = new Date().toISOString();
    const taskId = `codex:cli:${Date.now()}`;
    const conversationId = `codex:conversation:${Date.now()}`;
    const task = {
      id: taskId,
      source: this.source,
      agentId: "codex:cli",
      conversationId,
      title: String(input.title || content).slice(0, 80),
      status: "running",
      progress: 5,
      createdAt: now,
      updatedAt: now,
      metadata: {
        mode: "cli",
        surface: "cli",
        prompt: content,
        reasoning,
        approvalPolicy,
        resumeLast: Boolean(input.resumeLast)
      }
    };
    const conversation = {
      id: conversationId,
      source: this.source,
      title: task.title,
      taskIds: [taskId],
      createdAt: now,
      updatedAt: now,
      metadata: { mode: "cli", surface: "cli", persistent: false }
    };

    this.tasks = [task, ...this.tasks].slice(0, MAX_ITEMS);
    this.conversations = [conversation, ...this.conversations].slice(0, MAX_ITEMS);
    this.eventBus.publish({ source: this.source, type: "task.created", taskId, agentId: task.agentId, conversationId, payload: task });
    this.eventBus.publish({ source: this.source, type: "conversation.message.created", taskId, conversationId, payload: { role: "user", content, reasoning } });

    const run = this.cli.start(withReasoningDirective(content, reasoning), {
      taskId,
      resumeLast: Boolean(input.resumeLast),
      approvalPolicy,
      timeoutMs: this.config.runTimeoutMs,
      onEvent: (event) => this.handleCliEvent(taskId, event),
      onStderr: (line) => this.handleCliStderr(taskId, line),
      onError: (error) => this.finishCliTask(taskId, "failed", { error: error.message }),
      onTimeout: (result) => this.finishCliTask(taskId, "timeout", result),
      onExit: (result) => this.handleCliExit(taskId, result)
    });

    task.metadata.pid = run.pid;
    task.metadata.command = run.args.map((arg) => redactArgument(arg)).join(" ");
    task.metadata.startedAt = run.startedAt;

    return {
      task,
      message: {
        id: `codex:message:${Date.now()}`,
        conversationId,
        source: this.source,
        role: "user",
        content,
        createdAt: now,
        metadata: { taskId, pid: run.pid, reasoning }
      }
    };
  }

  handleCliEvent(taskId, event) {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) return;
    task.updatedAt = new Date().toISOString();

    const approval = approvalFromCliEvent(task, event);
    if (approval) {
      this.recordApproval(task, approval);
      return;
    }

    const threadId = event.thread_id || event.threadId;
    if (event.type === "thread.started" && threadId) {
      task.metadata.threadId = String(threadId);
      this.eventBus.publish({ source: this.source, type: "conversation.created", taskId, conversationId: task.conversationId, payload: { threadId } });
      return;
    }
    if (event.type === "turn.started") {
      task.progress = Math.max(task.progress, 12);
      return this.publishProgress(task, event, "Codex CLI turn started.");
    }
    if (event.type === "item.completed") {
      task.progress = Math.max(task.progress, 35);
      const itemType = event.item?.type || "item";
      const text = extractText(event) || `${itemType} completed`;
      const tool = /tool|command|shell/i.test(itemType);
      this.eventBus.publish({
        source: this.source,
        type: tool ? "worker.updated" : "conversation.message.created",
        taskId,
        conversationId: task.conversationId,
        payload: tool ? { message: text, itemType } : { role: "assistant", content: text, itemType }
      });
      return;
    }
    if (event.type === "turn.completed") return this.finishCliTask(taskId, "completed", { cliEvent: summarizeEvent(event) });
    if (event.type === "turn.failed") return this.finishCliTask(taskId, "failed", { error: extractText(event), cliEvent: summarizeEvent(event) });
    if (event.type === "error") {
      this.eventBus.publish({ source: this.source, type: "runtime.error", taskId, conversationId: task.conversationId, payload: { error: extractText(event) || "Codex CLI error." } });
      return;
    }
    this.publishProgress(task, event, extractText(event) || event.type || "Codex CLI event");
  }

  handleCliStderr(taskId, line) {
    if (!line || /^(warning|warn):/i.test(line)) return;
    const task = this.tasks.find((item) => item.id === taskId);
    this.eventBus.publish({ source: this.source, type: "runtime.error", taskId, conversationId: task?.conversationId, payload: { error: redactText(line) } });
  }

  handleCliExit(taskId, result) {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task || !["running", "queued", "waiting_approval"].includes(task.status)) return;
    if (task.status === "waiting_approval") return;
    this.finishCliTask(taskId, result.code === 0 ? "completed" : "failed", result);
  }

  publishProgress(task, event, message) {
    this.eventBus.publish({ source: this.source, type: "task.progress", taskId: task.id, conversationId: task.conversationId, payload: { message, eventType: event.type } });
  }

  finishCliTask(taskId, status, payload = {}) {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task || ["completed", "failed", "cancelled", "timeout"].includes(task.status)) return;
    task.status = status === "timeout" ? "failed" : status;
    task.progress = status === "completed" ? 100 : task.progress;
    task.updatedAt = new Date().toISOString();
    this.cancelPendingApprovals(taskId, status);
    this.eventBus.publish({ source: this.source, type: status === "completed" ? "task.completed" : "task.failed", taskId, conversationId: task.conversationId, payload: { ...payload, status, task } });
  }

  recordApproval(task, approval) {
    const now = new Date().toISOString();
    const next = { ...approval, updatedAt: now };
    this.approvals = [next, ...this.approvals.filter((item) => item.id !== next.id)].slice(0, MAX_ITEMS);
    task.status = "waiting_approval";
    task.progress = Math.max(task.progress, 55);
    task.metadata.pendingApprovalId = next.id;
    task.updatedAt = now;
    this.eventBus.publish({ source: this.source, type: "approval.requested", taskId: task.id, conversationId: task.conversationId, payload: { approval_id: next.id, approvalId: next.id, command: next.title, question: next.body } });
    this.eventBus.publish({ source: this.source, type: "task.progress", taskId: task.id, conversationId: task.conversationId, payload: { message: "Codex CLI waiting for approval.", status: "waiting_approval", approvalId: next.id } });
  }

  findPendingApproval(approvalId) {
    const requested = String(approvalId || "").replace(/^codex:approval:/, "");
    return this.approvals.find((approval) => approval.status === "pending" && (!requested || approval.id === approvalId || approval.id === `codex:approval:${requested}` || approval.metadata?.rawId === requested));
  }

  cancelPendingApprovals(taskId, reason) {
    const now = new Date().toISOString();
    for (const approval of this.approvals) {
      if (approval.taskId !== taskId || approval.status !== "pending") continue;
      approval.status = reason === "completed" ? "expired" : "cancelled";
      approval.resolvedAt = now;
      this.eventBus.publish({ source: this.source, type: "approval.resolved", taskId, conversationId: approval.conversationId, payload: { approvalId: approval.id, status: approval.status, reason } });
    }
  }
}

function normalizeReasoning(value) {
  const normalized = String(value || "").toLowerCase();
  return ["low", "med", "high", "xhigh"].includes(normalized) ? normalized : undefined;
}

function withReasoningDirective(content, reasoning) {
  if (!reasoning) return content;
  const directive = {
    low: "Keep reasoning concise and focus on the direct solution.",
    med: "Use a balanced amount of reasoning and verification.",
    high: "Use careful, detailed reasoning and verify the result.",
    xhigh: "Use exhaustive reasoning, verification, and edge-case checks."
  }[reasoning];
  return `${directive}\n\nUser task:\n${content}`;
}

function approvalFromCliEvent(task, event) {
  const type = String(event?.type || event?.event || event?.kind || "").toLowerCase();
  const approval = event?.approval || event?.request || event?.params || event?.item;
  if (!/(approval|permission|command|shell|exec)/.test(type) || !approval) return undefined;
  const rawId = String(approval.id || approval.approval_id || approval.call_id || `${task.id}:${Date.now()}`);
  return {
    id: rawId.startsWith("codex:approval:") ? rawId : `codex:approval:${rawId}`,
    source: "codex",
    taskId: task.id,
    conversationId: task.conversationId,
    title: String(approval.command || approval.title || "Codex CLI approval").slice(0, 180),
    body: String(approval.question || approval.reason || approval.command || "Codex CLI requests approval.").slice(0, 1000),
    status: "pending",
    requestedAt: new Date().toISOString(),
    metadata: { rawId, params: approval, kind: type }
  };
}

function normalizeApprovalDecision(input) {
  const approved = input.decision === "approve" || ["once", "session", "always", "acceptForSession"].includes(input.approvalDecision);
  const session = input.approvalScope === "session" || input.approvalDecision === "acceptForSession";
  if (!approved) return { value: "deny", approved: false, stdinResponse: "deny\n" };
  if (session) return { value: "acceptForSession", approved: true, stdinResponse: "always\n" };
  return { value: "accept", approved: true, stdinResponse: "once\n" };
}

function extractText(event) {
  return event?.text || event?.message || event?.error?.message || event?.item?.text || event?.item?.content || event?.reason;
}

function summarizeEvent(event) {
  return { type: event?.type, id: event?.id, threadId: event?.thread_id || event?.threadId, text: extractText(event) };
}

function redactArgument(value) {
  return String(value).length > 300 ? `${String(value).slice(0, 297)}...` : String(value);
}

function redactText(value) {
  return String(value).replace(/(?:password|token|secret|cookie)=?\s*[^\s]+/gi, "$1=[redacted]").slice(0, 1000);
}

function unsupported(action, message) {
  const error = new Error(message);
  error.code = "UNSUPPORTED_CAPABILITY";
  error.action = action;
  return error;
}
