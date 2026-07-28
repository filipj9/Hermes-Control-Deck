import { normalizeAgentStatus, normalizeTaskStatus } from "../../domain/events.mjs";

export function toHermesAgents(data) {
  const list = unwrapList(data, ["profiles", "agents", "models", "data", "items"]);
  return list.map((item, index) => {
    const id = stringValue(item.id ?? item.key ?? item.name ?? item.model, `hermes-agent-${index}`);
    return {
      id: `hermes:${id}`,
      source: "hermes",
      displayName: stringValue(item.name ?? item.label ?? item.model ?? id, "Hermes"),
      runtimeName: "Hermes",
      model: stringValue(item.model ?? item.id ?? item.name, ""),
      status: item.is_active ? "running" : normalizeAgentStatus(item.status ?? (item.is_default ? "idle" : undefined)),
      capabilities: arrayValue(item.capabilities ?? item.tools ?? item.tags ?? item.provider),
      metadata: item,
      updatedAt: new Date().toISOString()
    };
  });
}

export function toHermesTasks(data) {
  const list = unwrapList(data, ["tasks", "cards", "items", "data", "runs"]);
  return list.map((item, index) => {
    const id = stringValue(item.id ?? item.task_id ?? item.slug, `hermes-task-${index}`);
    const title = stringValue(item.title ?? item.name ?? item.summary ?? item.prompt, "Hermes task");
    return {
      id: `hermes:${id}`,
      source: "hermes",
      agentId: item.agentId ? `hermes:${item.agentId}` : undefined,
      conversationId: item.session_id ? `hermes:${item.session_id}` : undefined,
      title,
      status: normalizeTaskStatus(item.status ?? item.state ?? item.column),
      progress: numberValue(item.progress),
      createdAt: stringValue(item.created_at ?? item.createdAt, new Date().toISOString()),
      updatedAt: stringValue(item.updated_at ?? item.updatedAt ?? item.completed_at ?? item.started_at, new Date().toISOString()),
      metadata: item
    };
  });
}

export function toHermesConversations(data) {
  const list = unwrapList(data, ["sessions", "conversations", "items", "data"]);
  return list.map((item, index) => {
    const id = stringValue(item.id ?? item.session_id ?? item.key, `hermes-conversation-${index}`);
    return {
      id: `hermes:${id}`,
      source: "hermes",
      title: stringValue(item.title ?? item.name ?? item.preview, "Hermes conversation"),
      agentId: item.agent_id ? `hermes:${item.agent_id}` : undefined,
      taskIds: [],
      createdAt: stringValue(item.created_at ?? item.createdAt, new Date().toISOString()),
      updatedAt: stringValue(item.updated_at ?? item.updatedAt, new Date().toISOString()),
      metadata: item
    };
  });
}

export function toMetricEvent(source, data) {
  return {
    source,
    type: "system.metric.sampled",
    payload: data,
    raw: data
  };
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
