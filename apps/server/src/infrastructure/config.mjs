import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function loadConfig(projectRoot) {
  const envPath = path.join(projectRoot, ".env");
  const localEnv = parseEnvFile(envPath);
  const env = { ...localEnv, ...process.env };
  const serverPort = numberFrom(env.CONTROL_SERVER_PORT, 4240);
  const relayEnabled = env.HERMES_TUI_RELAY_ENABLED === "true";
  const relayPath = normalizeRoute(env.HERMES_TUI_RELAY_PATH || "/api/tui-relay");
  const directWsUrl = trimSlash(env.HERMES_WS_URL || "");
  const relayToken = env.HERMES_TUI_RELAY_TOKEN || "";
  const relayClientUrl = trimSlash(
    env.HERMES_TUI_RELAY_CLIENT_WS_URL || `ws://127.0.0.1:${serverPort}${relayPath}`
  );

  const config = {
    projectRoot,
    server: {
      host: env.CONTROL_SERVER_HOST || "127.0.0.1",
      port: serverPort,
      adapterDeadlineMs: numberFrom(env.CONTROL_ADAPTER_DEADLINE_MS, 2500),
      adapterReadDeadlineMs: numberFrom(env.CONTROL_ADAPTER_READ_DEADLINE_MS, 7000),
      cacheTtlMs: numberFrom(env.CONTROL_CACHE_TTL_MS, 1200),
      authToken: env.CONTROL_AUTH_TOKEN || "",
      allowedOrigins: parseList(env.CONTROL_ALLOWED_ORIGINS),
      maxBodyBytes: numberFrom(env.CONTROL_MAX_BODY_BYTES, 256 * 1024),
      maxPromptChars: numberFrom(env.CONTROL_MAX_PROMPT_CHARS, 100000),
      rateLimitWindowMs: numberFrom(env.CONTROL_RATE_LIMIT_WINDOW_MS, 60000),
      rateLimitMax: numberFrom(env.CONTROL_RATE_LIMIT_MAX, 120)
    },
    web: {
      host: env.CONTROL_WEB_HOST || "127.0.0.1",
      port: numberFrom(env.CONTROL_WEB_PORT, 4241)
    },
    hermes: {
      enabled: env.HERMES_ENABLED !== "false",
      baseUrl: trimSlash(env.HERMES_BASE_URL || ""),
      authMode: env.HERMES_AUTH_MODE || "password",
      password: env.HERMES_PASSWORD || "",
      apiPrefix: normalizePrefix(env.HERMES_API_PREFIX || "/api"),
      profile: env.HERMES_PROFILE || "default",
      model: env.HERMES_MODEL || "",
      timeoutMs: numberFrom(env.HERMES_TIMEOUT_MS, 3500),
      streamTimeoutMs: numberFrom(env.HERMES_STREAM_TIMEOUT_MS, 0),
      streamReconnectAttempts: numberFrom(env.HERMES_STREAM_RECONNECT_ATTEMPTS, 3),
      streamReconnectBackoffMs: numberFrom(env.HERMES_STREAM_RECONNECT_BACKOFF_MS, 250),
      maxPromptChars: numberFrom(env.HERMES_MAX_PROMPT_CHARS, 100000),
      externalApprovalMonitorEnabled: env.HERMES_EXTERNAL_APPROVAL_MONITOR_ENABLED === "true",
      externalApprovalPollMs: numberFrom(env.HERMES_EXTERNAL_APPROVAL_POLL_MS, 2500),
      externalSessionLimit: numberFrom(env.HERMES_EXTERNAL_SESSION_LIMIT, 50),
      externalSessionRefreshMs: numberFrom(env.HERMES_EXTERNAL_SESSION_REFRESH_MS, 2000),
      ws: {
        enabled: env.HERMES_WS_ENABLED === "true" || Boolean(directWsUrl) || relayEnabled,
        url: relayEnabled ? relayClientUrl : directWsUrl,
        ticket: relayEnabled ? "" : env.HERMES_WS_TICKET || "",
        token: relayEnabled ? relayToken : env.HERMES_WS_TOKEN || "",
        authBaseUrl: relayEnabled ? "" : trimSlash(env.HERMES_WS_AUTH_BASE_URL || ""),
        authProvider: relayEnabled ? "basic" : env.HERMES_WS_AUTH_PROVIDER || "basic",
        authUsername: relayEnabled ? "" : env.HERMES_WS_USERNAME || "",
        authPassword: relayEnabled ? "" : env.HERMES_WS_PASSWORD || "",
        sessionId: env.HERMES_WS_SESSION_ID || "",
        requestTimeoutMs: numberFrom(env.HERMES_WS_REQUEST_TIMEOUT_MS, 15000),
        reconnect: env.HERMES_WS_RECONNECT !== "false",
        reconnectBackoffMs: numberFrom(env.HERMES_WS_RECONNECT_BACKOFF_MS, 1000),
        reconnectMaxBackoffMs: numberFrom(env.HERMES_WS_RECONNECT_MAX_BACKOFF_MS, 15000)
      },
      relay: {
        enabled: relayEnabled,
        path: relayPath,
        token: relayToken,
        maxMessageBytes: numberFrom(env.HERMES_TUI_RELAY_MAX_MESSAGE_BYTES, 1024 * 1024),
        requestTimeoutMs: numberFrom(env.HERMES_TUI_RELAY_REQUEST_TIMEOUT_MS, 15000),
        maxTrackedSessions: numberFrom(env.HERMES_TUI_RELAY_MAX_TRACKED_SESSIONS, 50),
        upstream: {
          url: trimSlash(env.HERMES_TUI_RELAY_UPSTREAM_WS_URL || directWsUrl),
          ticket: env.HERMES_TUI_RELAY_UPSTREAM_TICKET || env.HERMES_WS_TICKET || "",
          token: env.HERMES_TUI_RELAY_UPSTREAM_TOKEN || env.HERMES_WS_TOKEN || "",
          authBaseUrl: trimSlash(env.HERMES_TUI_RELAY_UPSTREAM_AUTH_BASE_URL || env.HERMES_WS_AUTH_BASE_URL || ""),
          authProvider: env.HERMES_TUI_RELAY_UPSTREAM_AUTH_PROVIDER || env.HERMES_WS_AUTH_PROVIDER || "basic",
          authUsername: env.HERMES_TUI_RELAY_UPSTREAM_USERNAME || env.HERMES_WS_USERNAME || "",
          authPassword: env.HERMES_TUI_RELAY_UPSTREAM_PASSWORD || env.HERMES_WS_PASSWORD || "",
          sessionId: env.HERMES_TUI_RELAY_UPSTREAM_SESSION_ID || env.HERMES_WS_SESSION_ID || "",
          requestTimeoutMs: numberFrom(env.HERMES_TUI_RELAY_UPSTREAM_REQUEST_TIMEOUT_MS, 15000),
          reconnect: env.HERMES_TUI_RELAY_UPSTREAM_RECONNECT !== "false",
          reconnectBackoffMs: numberFrom(env.HERMES_TUI_RELAY_UPSTREAM_RECONNECT_BACKOFF_MS, 1000),
          reconnectMaxBackoffMs: numberFrom(env.HERMES_TUI_RELAY_UPSTREAM_RECONNECT_MAX_BACKOFF_MS, 5000)
        }
      },
      bridge: {
        enabled: env.HERMES_BRIDGE_ENABLED === "true",
        token: env.HERMES_BRIDGE_TOKEN || "",
        maxBodyBytes: numberFrom(env.HERMES_BRIDGE_MAX_BODY_BYTES, 16 * 1024),
        maxEventIds: numberFrom(env.HERMES_BRIDGE_MAX_EVENT_IDS, 2000),
        maxTrackedRuns: numberFrom(env.HERMES_BRIDGE_MAX_TRACKED_RUNS, 1000),
        maxTerminalApprovals: numberFrom(env.HERMES_BRIDGE_MAX_TERMINAL_APPROVALS, 50),
        stateFile: env.HERMES_BRIDGE_STATE_FILE || path.join(
          projectRoot,
          ".runtime",
          "hermes-bridge-receiver.json"
        )
      }
    },
    codex: {
      enabled: env.CODEX_ENABLED !== "false",
      mode: "cli",
      surface: "cli",
      profile: env.CODEX_PROFILE || "default",
      model: env.CODEX_MODEL || "",
      executable: env.CODEX_EXECUTABLE || "",
      workdir: env.CODEX_WORKDIR || projectRoot,
      sandbox: env.CODEX_SANDBOX || "workspace-write",
      approvalPolicy: env.CODEX_APPROVAL_POLICY || "on-request",
      runTimeoutMs: numberFrom(env.CODEX_RUN_TIMEOUT_MS, 30 * 60 * 1000),
      stopTimeoutMs: numberFrom(env.CODEX_STOP_TIMEOUT_MS, 5000),
      allowConcurrentRuns: env.CODEX_ALLOW_CONCURRENT_RUNS === "true",
      maxPromptChars: numberFrom(env.CODEX_MAX_PROMPT_CHARS, 100000),
      minVersion: env.CODEX_MIN_VERSION || ""
    }
  };
  validateConfig(config);
  return config;
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const values = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const splitAt = trimmed.indexOf("=");
    if (splitAt === -1) continue;
    const key = trimmed.slice(0, splitAt).trim();
    const raw = trimmed.slice(splitAt + 1).trim();
    values[key] = raw.replace(/^["']|["']$/g, "");
  }

  return values;
}

function numberFrom(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function normalizePrefix(value) {
  if (!value) return "";
  const trimmed = String(value).trim();
  if (trimmed === "/") return "";
  return trimmed.startsWith("/") ? trimmed.replace(/\/+$/, "") : `/${trimmed.replace(/\/+$/, "")}`;
}

function normalizeRoute(value) {
  const route = String(value || "").trim();
  if (!route || route === "/") return "/api/tui-relay";
  return route.startsWith("/") ? route.replace(/\/+$/, "") : `/${route.replace(/\/+$/, "")}`;
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function validateConfig(config) {
  if (config.hermes.enabled && !config.hermes.baseUrl) {
    throw new Error("HERMES_BASE_URL is required when HERMES_ENABLED is true.");
  }
  if (config.hermes.bridge.enabled && config.hermes.bridge.token.length < 32) {
    throw new Error("HERMES_BRIDGE_TOKEN must contain at least 32 characters when the bridge is enabled.");
  }
  if (config.hermes.relay.enabled) {
    if (config.hermes.relay.token.length < 32) {
      throw new Error("HERMES_TUI_RELAY_TOKEN must contain at least 32 characters when the relay is enabled.");
    }
    if (!config.hermes.relay.upstream.url) {
      throw new Error("HERMES_TUI_RELAY_UPSTREAM_WS_URL is required when the relay is enabled.");
    }
  }
  if (config.hermes.ws.enabled && !config.hermes.ws.url) {
    throw new Error("HERMES_WS_URL is required when Hermes WebSocket support is enabled.");
  }
  if (config.codex.enabled && !config.codex.workdir) {
    throw new Error("CODEX_WORKDIR is required when CODEX_ENABLED is true.");
  }
  if (config.server.maxBodyBytes < 1024 || config.server.maxPromptChars < 1) {
    throw new Error("Control request limits are invalid.");
  }
  if (config.codex.runTimeoutMs < 1000 || config.codex.stopTimeoutMs < 100) {
    throw new Error("Codex process timeouts are invalid.");
  }
}

export function createAuthToken() {
  return crypto.randomBytes(32).toString("hex");
}
