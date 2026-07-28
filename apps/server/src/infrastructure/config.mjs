import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function loadConfig(projectRoot) {
  const envPath = path.join(projectRoot, ".env");
  const localEnv = parseEnvFile(envPath);
  const env = { ...localEnv, ...process.env };

  const config = {
    projectRoot,
    server: {
      host: env.CONTROL_SERVER_HOST || "127.0.0.1",
      port: numberFrom(env.CONTROL_SERVER_PORT, 4240),
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
      maxPromptChars: numberFrom(env.HERMES_MAX_PROMPT_CHARS, 100000)
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
