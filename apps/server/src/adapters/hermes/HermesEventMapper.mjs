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
  if (list.length) return list.map((item, index) => mapHermesTask(item, index, data));

  // Hermes WebUI can report a live WSL/CLI run through /health while its
  // Kanban endpoint still contains only historical tasks. Keep that run
  // visible in the shared task model instead of treating the empty Kanban
  // response as idle.
  if (hasActiveRun(data)) {
    const activeRun = data?.active_run ?? data?.activeRun ?? {};
    return [mapHermesTask({
      ...activeRun,
      id: activeRun.id
        ?? activeRun.run_id
        ?? activeRun.runId
        ?? data?.active_run_id
        ?? data?.activeRunId
        ?? "active-run",
      status: activeRun.status ?? activeRun.phase ?? activeRun.stage ?? "running",
      title: activeRun.title
        ?? activeRun.name
        ?? activeRun.summary
        ?? activeRun.prompt
        ?? activeRun.description
        ?? "Hermes active run",
      session_id: activeRun.session_id
        ?? activeRun.sessionId
        ?? activeRun.conversation_id
        ?? activeRun.conversationId
        ?? data?.active_session_id
        ?? data?.activeSessionId
        ?? data?.session_id
        ?? data?.sessionId,
      started_at: activeRun.started_at ?? data?.started_at ?? data?.last_run_started_at,
      updated_at: activeRun.updated_at ?? data?.last_request_at,
      _syntheticHealthTask: true
    }, 0, data)];
  }

  return [];
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

function mapHermesTask(item, index, context) {
  const id = stringValue(
    item?.id
      ?? item?.run_id
      ?? item?.runId
      ?? item?.task_id
      ?? item?.taskId
      ?? item?.slug,
    `hermes-task-${index}`
  );
  const sessionId = item?.session_id
    ?? item?.sessionId
    ?? item?.conversation_id
    ?? item?.conversationId
    ?? (Array.isArray(context?.runs) && context.runs.length === 1
      ? context?.active_session_id ?? context?.activeSessionId ?? context?.session_id ?? context?.sessionId
      : undefined);
  const agentId = item?.agentId
    ?? item?.agent_id
    ?? item?.profile;
  const statusInput = item?.status
    ?? item?.state
    ?? item?.column
    ?? item?.phase
    ?? item?.stage
    ?? ((item?.active || item?.is_active) ? "running" : undefined);
  const normalizedStatusInput = String(statusInput || "").toLowerCase() === "waiting"
    ? "waiting_approval"
    : statusInput;
  const status = normalizeTaskStatus(normalizedStatusInput);
  const title = stringValue(
    item?.title
      ?? item?.name
      ?? item?.summary
      ?? item?.prompt
      ?? item?.description,
    status === "running" ? "Hermes active run" : "Hermes task"
  );
  const now = new Date().toISOString();
  const createdAt = timestampValue(item?.created_at ?? item?.createdAt ?? item?.started_at, now);
  const updatedAt = timestampValue(
    item?.updated_at
      ?? item?.updatedAt
      ?? item?.completed_at
      ?? item?.completedAt
      ?? item?.last_activity_at
      ?? item?.started_at,
    createdAt
  );

  return {
    id: `hermes:${id}`,
    source: "hermes",
    agentId: agentId ? `hermes:${agentId}` : undefined,
    conversationId: sessionId ? `hermes:${sessionId}` : undefined,
    title,
    status,
    progress: numberValue(item?.progress ?? item?.progress_percent ?? item?.completion),
    createdAt,
    updatedAt,
    metadata: item
  };
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

function timestampValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const milliseconds = Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function hasActiveRun(data) {
  if (!data || typeof data !== "object") return false;
  const activeRuns = Number(data.active_runs ?? data.activeRuns);
  if (Number.isFinite(activeRuns) && activeRuns > 0) return true;
  return Boolean(data.active_run || data.activeRun || data.is_streaming === true);
}
