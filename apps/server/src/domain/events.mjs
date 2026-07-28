export function createEvent(input) {
  return {
    id: input.id ?? `${input.source}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
    source: input.source,
    type: input.type,
    timestamp: input.timestamp ?? new Date().toISOString(),
    agentId: input.agentId,
    taskId: input.taskId,
    workerId: input.workerId,
    conversationId: input.conversationId,
    payload: input.payload ?? {},
    raw: input.raw
  };
}

export function normalizeTaskStatus(status) {
  const value = String(status ?? "unknown").toLowerCase();
  if (["done", "complete", "completed", "success"].includes(value)) return "completed";
  if (["doing", "active", "running", "in_progress", "progress"].includes(value)) return "running";
  if (["todo", "queued", "pending", "new"].includes(value)) return "queued";
  if (["approval", "waiting_approval", "waiting_for_approval"].includes(value)) return "waiting_approval";
  if (["blocked", "stuck"].includes(value)) return "blocked";
  if (["fail", "failed", "error"].includes(value)) return "failed";
  if (["cancelled", "canceled", "stop", "stopped"].includes(value)) return "cancelled";
  return "unknown";
}

export function normalizeAgentStatus(status) {
  const value = String(status ?? "unknown").toLowerCase();
  if (["idle", "ready", "available"].includes(value)) return "idle";
  if (["running", "busy", "working", "active"].includes(value)) return "running";
  if (["approval", "waiting_approval", "waiting"].includes(value)) return "waiting_approval";
  if (["offline", "down", "disabled"].includes(value)) return "offline";
  if (["error", "failed"].includes(value)) return "error";
  return "unknown";
}
