import { normalizeAgentStatus, normalizeTaskStatus } from "../../domain/events.mjs";

export function toCodexAgents(data) {
  const list = unwrapList(data, ["profiles", "agents", "items", "data"]);
  return list.map((item, index) => {
    const id = stringValue(item.id ?? item.name ?? item.profile, `codex-agent-${index}`);
    return {
      id: `codex:${id}`,
      source: "codex",
      displayName: stringValue(item.name ?? item.displayName ?? id, "Codex"),
      runtimeName: "Codex",
      model: stringValue(item.model ?? item.provider, ""),
      status: item.is_active ? "running" : normalizeAgentStatus(item.status ?? (item.is_default ? "idle" : undefined)),
      capabilities: arrayValue(item.capabilities ?? item.tools ?? item.tags),
      metadata: item,
      updatedAt: new Date().toISOString()
    };
  });
}

export function toCodexTasks(data) {
  const list = unwrapList(data, ["tasks", "items", "data"]);
  return list.map((item, index) => {
    const id = stringValue(item.id ?? item.task_id ?? item.session_id, `codex-task-${index}`);
    return {
      id: `codex:${id}`,
      source: "codex",
      agentId: item.agent_id ? `codex:${item.agent_id}` : "codex:local",
      conversationId: item.session_id ? `codex:${item.session_id}` : undefined,
      title: stringValue(item.title ?? item.name ?? item.summary ?? item.body, "Codex task"),
      status: normalizeTaskStatus(item.status ?? item.state),
      progress: numberValue(item.progress),
      createdAt: stringValue(item.created_at ?? item.createdAt, new Date().toISOString()),
      updatedAt: stringValue(item.updated_at ?? item.updatedAt ?? item.completed_at, new Date().toISOString()),
      metadata: item
    };
  });
}

export function toCodexConversations(data) {
  const list = unwrapList(data, ["sessions", "conversations", "items", "data"]);
  return list.map((item, index) => {
    const id = stringValue(item.id ?? item.session_id ?? item.key, `codex-conversation-${index}`);
    return {
      id: `codex:${id}`,
      source: "codex",
      title: stringValue(item.title ?? item.name ?? item.preview, "Codex conversation"),
      agentId: item.agent_id ? `codex:${item.agent_id}` : "codex:local",
      taskIds: [],
      createdAt: stringValue(item.created_at ?? item.createdAt, new Date().toISOString()),
      updatedAt: stringValue(item.updated_at ?? item.updatedAt, new Date().toISOString()),
      metadata: item
    };
  });
}

export function toCodexApprovals(data, sessionId) {
  const pending = data?.pending ?? data;
  if (!pending || typeof pending !== "object" || !pending.approval_id) return [];

  return [
    {
      id: String(pending.approval_id),
      source: "codex",
      conversationId: sessionId ? `codex:${sessionId}` : undefined,
      title: pending.command ? String(pending.command) : "Codex approval",
      body: pending.question ? String(pending.question) : String(pending.command ?? ""),
      status: "pending",
      requestedAt: new Date().toISOString(),
      metadata: pending
    }
  ];
}

function unwrapList(data, keys) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];

  for (const key of keys) {
    if (Array.isArray(data[key])) return data[key];
  }

  for (const value of Object.values(data)) {
    if (Array.isArray(value)) return value;
  }

  return [];
}

function stringValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function arrayValue(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
