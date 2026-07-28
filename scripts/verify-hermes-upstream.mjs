import process from "node:process";

const args = new Set(process.argv.slice(2));
const baseUrl = valueFor("--base-url") || process.env.HERMES_BASE_URL || "";
const apiPrefix = normalizePrefix(process.env.HERMES_API_PREFIX || "/api");
const timeoutMs = numberFrom(process.env.HERMES_VERIFY_TIMEOUT_MS, 5000);
const allowWriteTest = args.has("--allow-write-test");
const confirmPrivateHost = args.has("--confirm-private-host");

if (!baseUrl) fail("Set HERMES_BASE_URL or pass --base-url <url>.");

let base;
try {
  base = new URL(baseUrl);
} catch {
  fail("Hermes base URL is invalid.");
}

if (!/^https?:$/.test(base.protocol)) fail("Hermes base URL must use http or https.");
if (allowWriteTest && isPrivateHost(base.hostname) && !confirmPrivateHost) {
  fail("Write tests against private hosts require --confirm-private-host.");
}

const cookieJar = { value: "" };
const report = {
  mode: allowWriteTest ? "explicit-write-test" : "read-only",
  baseUrl: redactUrl(base),
  checkedAt: new Date().toISOString(),
  results: []
};

await check("health", "GET", "/health", { auth: false });
await check("auth-status", "GET", `${apiPrefix}/auth/status`, { auth: false });
await check("profiles", "GET", `${apiPrefix}/profiles`);
await check("sessions", "GET", `${apiPrefix}/sessions/search?limit=1`);
await check("models", "GET", `${apiPrefix}/models`);
await check("system-health", "GET", `${apiPrefix}/system/health`);
await check("kanban-boards", "GET", `${apiPrefix}/kanban/boards`);
await check("kanban-tasks", "GET", `${apiPrefix}/kanban/tasks?status=all&sort=updated`);
await check("stream-status-contract", "GET", `${apiPrefix}/chat/stream/status?stream_id=hermes-control-preflight-${Date.now()}`);
await check("approval-pending-contract", "GET", `${apiPrefix}/approval/pending?session_id=hermes-control-preflight`);

if (!allowWriteTest) {
  report.writeTests = {
    status: "not-run",
    reason: "Pass --allow-write-test explicitly to create a session, start a short chat, and cancel it."
  };
} else {
  await runWriteTest();
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function runWriteTest() {
  const password = process.env.HERMES_PASSWORD || "";
  if (!password) {
    report.writeTests = { status: "blocked", reason: "HERMES_PASSWORD is required for an explicit write test." };
    return;
  }

  const login = await request("POST", `${apiPrefix}/auth/login`, {
    auth: false,
    body: { password }
  });
  report.writeTests = { status: login.ok ? "login-ok" : "login-failed", login: summarize(login) };
  if (!login.ok) return;

  const session = await request("POST", `${apiPrefix}/session/new`, {
    body: { profile: process.env.HERMES_PROFILE || "default" }
  });
  report.writeTests.session = summarize(session);
  const sessionId = session.data?.session?.session_id || session.data?.session_id;
  if (!session.ok || !sessionId) return;

  const start = await request("POST", `${apiPrefix}/chat/start`, {
    body: {
      session_id: sessionId,
      message: "Hermes Control preflight. Reply with one short line and do not call tools.",
      profile: process.env.HERMES_PROFILE || "default"
    }
  });
  report.writeTests.chatStart = summarize(start);
  const streamId = start.data?.stream_id || start.data?.active_stream_id;
  if (!streamId) return;

  report.writeTests.streamStatus = summarize(await request(
    "GET",
    `${apiPrefix}/chat/stream/status?stream_id=${encodeURIComponent(streamId)}`
  ));
  report.writeTests.cancel = summarize(await request(
    "GET",
    `${apiPrefix}/chat/cancel?stream_id=${encodeURIComponent(streamId)}`
  ));
}

async function check(name, method, route, options = {}) {
  const result = await request(method, route, options);
  report.results.push({ name, method, route, ...summarize(result) });
}

async function request(method, route, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    Accept: method === "GET" ? "application/json" : "application/json",
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(cookieJar.value ? { Cookie: cookieJar.value } : {})
  };

  try {
    const response = await fetch(new URL(route, base), {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookieJar.value = setCookie.split(",")[0].split(";")[0];
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = undefined; }
    return { ok: response.ok, status: response.status, data, text: text.slice(0, 240) };
  } catch (error) {
    return { ok: false, status: 0, error: error.name === "AbortError" ? "timeout" : error.message };
  } finally {
    clearTimeout(timer);
  }
}

function summarize(result) {
  return {
    ok: result.ok,
    status: result.status,
    error: result.error,
    bodyKind: result.data === undefined ? (result.text ? "text" : "empty") : typeof result.data,
    hasSessionId: Boolean(result.data?.session?.session_id || result.data?.session_id),
    hasStreamId: Boolean(result.data?.stream_id || result.data?.active_stream_id)
  };
}

function valueFor(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? "" : process.argv[index + 1] || "";
}

function normalizePrefix(value) {
  const trimmed = String(value).trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function numberFrom(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function redactUrl(url) {
  return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
}

function isPrivateHost(hostname) {
  if (hostname === "localhost" || hostname === "::1" || hostname === "127.0.0.1") return true;
  if (/^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return true;
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
  throw new Error(message);
}
