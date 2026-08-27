import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { EventBus } from "./infrastructure/EventBus.mjs";
import { PushNotificationService } from "./infrastructure/PushNotificationService.mjs";
import { loadConfig } from "./infrastructure/config.mjs";
import { RuntimeRegistry } from "./application/RuntimeRegistry.mjs";
import { HermesRuntimeAdapter } from "./adapters/hermes/HermesRuntimeAdapter.mjs";
import { HermesBridgeReceiver } from "./adapters/hermes/HermesBridgeReceiver.mjs";
import { HermesTuiRelay } from "./adapters/hermes/HermesTuiRelay.mjs";
import { createCodexAdapter } from "./adapters/codex/createCodexAdapter.mjs";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const projectRoot = path.resolve(currentDir, "../../..");
const webRoot = path.join(projectRoot, "apps", "web");

const config = loadConfig(projectRoot);
const eventBus = new EventBus();
const pushNotifications = new PushNotificationService(config.push, {
  logger: (message) => console.warn(message)
});
await pushNotifications.start();
if (config.push.enabled) {
  eventBus.subscribe((event) => pushNotifications.handleEvent(event), {
    types: ["task.completed", "task.failed"]
  });
}
const hermesBridge = new HermesBridgeReceiver(config.hermes.bridge, eventBus, {
  logger: (message) => console.warn(message)
});
const hermesTuiRelay = new HermesTuiRelay(config.hermes.relay, {
  logger: (level, message) => (level === "warning" ? console.warn(message) : console.log(message))
});
const registry = new RuntimeRegistry();
const adapterCache = new Map();
const rateBuckets = new Map();
const acceptedMessageRequests = new Map();
const acceptedMessageRequestTtlMs = 5 * 60 * 1000;

if (!config.server.authToken || config.server.authToken.length < 32) {
  throw new Error("CONTROL_AUTH_TOKEN must be set to a random value of at least 32 characters.");
}

if (config.hermes.enabled) {
  registry.register(new HermesRuntimeAdapter(config.hermes, eventBus, {
    bridgeReceiver: hermesBridge,
    monitorExternalApprovals: config.hermes.externalApprovalMonitorEnabled
  }));
}

if (config.codex.enabled) {
  registry.register(await createCodexAdapter(config.codex, eventBus));
}

for (const adapter of registry.all()) {
  eventBus.publish({
    source: adapter.source,
    type: "runtime.connected",
    payload: {
      mode: adapter.source === "codex"
        ? (config.codex.experimentalDesktop.enabled ? "experimental-desktop" : config.codex.mode)
        : "remote",
      ...(adapter.source === "codex" ? {
        surface: config.codex.experimentalDesktop.enabled ? "desktop" : "cli"
      } : {})
    }
  });
}

const server = http.createServer(async (request, response) => {
  try {
    setCommonHeaders(response, request);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const requestUrl = new URL(request.url, `http://${request.headers.host}`);

    const protectedRequest = requestUrl.pathname === "/events"
      || requestUrl.pathname === "/healthz"
      || requestUrl.pathname.startsWith("/api/");
    const bridgeTransportRequest = isHermesBridgeTransportRoute(request.method, requestUrl.pathname);
    if (protectedRequest && requestUrl.pathname !== "/api/auth/session" && !bridgeTransportRequest) {
      if (!isAuthorized(request)) {
        writeJson(response, 401, { ok: false, error: "Authentication required" });
        return;
      }
      if (!allowRate(request)) {
        writeJson(response, 429, { ok: false, error: "Rate limit exceeded" });
        return;
      }
    }

    if (request.method === "GET" && requestUrl.pathname === "/events") {
      eventBus.attach(response);
      return;
    }

    if (requestUrl.pathname.startsWith("/api/") || requestUrl.pathname === "/healthz") {
      await handleApi(request, response, requestUrl);
      return;
    }

    await serveStatic(requestUrl.pathname, response);
  } catch (error) {
    writeJson(response, error.statusCode || 500, {
      ok: false,
      error: error.message,
      ...(error.code ? { code: error.code } : {})
    });
  }
});

hermesTuiRelay.attach(server);

server.listen(config.server.port, config.server.host, () => {
  const localUrl = `http://${config.server.host}:${config.server.port}`;
  console.log(`Hermes Control ready on ${localUrl}`);
  console.log(`API: ${localUrl}/api/runtimes`);
  console.log(`Events: ${localUrl}/events`);
  if (config.hermes.relay.enabled) {
    console.log(`Hermes TUI relay: ${config.hermes.relay.path}`);
  }
});

async function handleApi(request, response, requestUrl) {
  const { method } = request;
  const pathname = requestUrl.pathname;

  if (method === "POST" && pathname === "/api/auth/session") {
    const body = await readJson(request);
    if (!constantTimeEquals(body.token, config.server.authToken)) {
      writeJson(response, 401, { ok: false, error: "Invalid control token" });
      return;
    }
    response.setHeader("Set-Cookie", `hermes_control_session=${encodeURIComponent(config.server.authToken)}; HttpOnly; SameSite=Strict; Path=/`);
    writeJson(response, 200, { ok: true });
    return;
  }

  if (method === "GET" && pathname === "/healthz") {
    writeJson(response, 200, {
      ok: true,
      name: "Hermes Control",
      port: config.server.port,
      hermes: {
        enabled: config.hermes.enabled,
        configured: Boolean(config.hermes.baseUrl),
        hasPassword: Boolean(config.hermes.password),
        websocket: {
          enabled: config.hermes.ws.enabled,
          configured: Boolean(config.hermes.ws.url)
        },
        gatewayBridge: hermesBridge.health(),
        tuiRelay: hermesTuiRelay.health()
      },
      codex: {
        enabled: config.codex.enabled,
        mode: config.codex.experimentalDesktop.enabled ? "experimental-desktop" : "cli",
        surface: config.codex.experimentalDesktop.enabled ? "desktop" : "cli",
        experimental: config.codex.experimentalDesktop.enabled
      },
      push: pushNotifications.status()
    });
    return;
  }

  if (method === "GET" && pathname === "/api/push/status") {
    writeJson(response, 200, pushNotifications.status());
    return;
  }

  if (method === "POST" && pathname === "/api/push/subscriptions") {
    requireSameOriginPushRequest(request);
    requireJsonContentType(request);
    const body = await readJson(request, { maxBytes: 16 * 1024 });
    writeJson(response, 201, { ok: true, ...pushNotifications.subscribe(body.subscription) });
    return;
  }

  if (method === "POST" && pathname === "/api/push/unsubscribe") {
    requireSameOriginPushRequest(request);
    requireJsonContentType(request);
    const body = await readJson(request, { maxBytes: 16 * 1024 });
    writeJson(response, 200, { ok: true, ...pushNotifications.unsubscribe(body.endpoint) });
    return;
  }

  if (method === "GET" && pathname === "/api/runtimes") {
    const runtimes = await callEach("health", {
      forceRefresh: shouldForceRefresh(requestUrl),
      cacheTtlMs: 2000
    });
    writeJson(response, 200, runtimes);
    return;
  }

  if (method === "GET" && pathname === "/api/agents") {
    writeJson(response, 200, await callEach("listAgents", {
      deadlineMs: config.server.adapterReadDeadlineMs,
      cacheTtlMs: 30000,
      forceRefresh: shouldForceRefresh(requestUrl)
    }));
    return;
  }

  if (method === "GET" && pathname === "/api/tasks") {
    const [data, health] = await Promise.all([
      callEach("listTasks", {
        deadlineMs: config.server.adapterReadDeadlineMs,
        cacheTtlMs: 5000,
        forceRefresh: shouldForceRefresh(requestUrl)
      }),
      callEach("health", {
        deadlineMs: config.server.adapterDeadlineMs,
        cacheTtlMs: 2000,
        forceRefresh: shouldForceRefresh(requestUrl)
      })
    ]);
    const hermesHealth = health.items?.find((item) => item.source === "hermes" && item.ok);
    if (hermesHealth?.details) hermesBridge.reconcileWithRuntimeHealth(hermesHealth.details);
    const byId = new Map((data.items || []).map((task) => [task.id, task]));
    for (const task of hermesBridge.listTasks()) byId.set(task.id, task);
    writeJson(response, 200, {
      ...data,
      items: [...byId.values()].sort(byUpdatedAtDesc).slice(0, 50)
    });
    return;
  }

  if (method === "GET" && pathname === "/api/workers") {
    writeJson(response, 200, await callEach("listWorkers", {
      deadlineMs: config.server.adapterReadDeadlineMs,
      cacheTtlMs: 10000,
      forceRefresh: shouldForceRefresh(requestUrl)
    }));
    return;
  }

  if (method === "GET" && pathname === "/api/approvals") {
    writeJson(response, 200, await callEach("listApprovals", {
      deadlineMs: config.server.adapterReadDeadlineMs,
      cacheTtlMs: 1500,
      forceRefresh: shouldForceRefresh(requestUrl)
    }));
    return;
  }

  if (method === "GET" && pathname === "/api/conversations") {
    const data = await callEach("listConversations", {
      deadlineMs: config.server.adapterReadDeadlineMs,
      cacheTtlMs: 10000,
      forceRefresh: shouldForceRefresh(requestUrl)
    });
    writeJson(response, 200, limitItems(data, 50, byUpdatedAtDesc));
    return;
  }

  if (method === "GET" && pathname === "/api/events") {
    const limit = clampNumber(requestUrl.searchParams.get("limit"), 1, 80, 80);
    const minutes = clampNumber(requestUrl.searchParams.get("minutes"), 1, 60, 15);
    writeJson(response, 200, {
      items: eventBus.list(limit, { maxAgeMs: minutes * 60 * 1000 }),
      errors: [],
      limit,
      minutes
    });
    return;
  }

  if (method === "GET" && pathname === "/api/hermes/events/health") {
    writeJson(response, 200, hermesBridge.health());
    return;
  }

  if (method === "POST" && pathname === "/api/hermes/events") {
    hermesBridge.authorize(request.headers);
    requireJsonContentType(request);
    const body = await readJson(request, { maxBytes: config.hermes.bridge.maxBodyBytes });
    const result = hermesBridge.accept(body);
    invalidateAdapterCache();
    writeJson(response, result.duplicate ? 200 : 202, { ok: true, ...result });
    return;
  }

  if (method === "GET" && pathname === "/api/hermes/approval-decisions/claim") {
    hermesBridge.authorize(request.headers);
    const gatewayId = requestUrl.searchParams.get("gateway_id");
    const limit = clampNumber(requestUrl.searchParams.get("limit"), 1, 10, 1);
    const waitMs = clampNumber(requestUrl.searchParams.get("wait_ms"), 0, 25_000, 0);
    const leaseMs = clampNumber(requestUrl.searchParams.get("lease_ms"), 5_000, 120_000, 30_000);
    const deadline = Date.now() + waitMs;
    let items = [];
    do {
      items = hermesBridge.claimDecisions({ gatewayId, limit, leaseMs });
      if (items.length || Date.now() >= deadline) break;
      await delay(Math.min(250, Math.max(1, deadline - Date.now())));
    } while (!request.destroyed);
    writeJson(response, 200, { ok: true, items });
    return;
  }

  const hermesDecisionAckMatch = pathname.match(/^\/api\/hermes\/approval-decisions\/([^/]+)\/ack$/);
  if (method === "POST" && hermesDecisionAckMatch) {
    hermesBridge.authorize(request.headers);
    const body = await readJson(request, { maxBytes: config.hermes.bridge.maxBodyBytes });
    const decision = hermesBridge.ackDecision({
      decisionId: decodeURIComponent(hermesDecisionAckMatch[1]),
      gatewayId: body.gateway_id ?? body.gatewayId,
      status: body.status,
      error: body.error
    });
    writeJson(response, 200, { ok: true, decision });
    return;
  }

  if (method === "POST" && pathname === "/api/actions") {
    const body = await readJson(request);
    const source = body.source;
    const action = body.action;
    const payload = body.payload || {};
    const adapter = registry.get(source);
    let result;
    try {
      result = await adapter.runAction(action, payload);
    } catch (error) {
      eventBus.publish({
        source,
        type: "runtime.error",
        payload: { action, error: error.message }
      });
      throw error;
    }

    eventBus.publish({
      source,
      type: "ui.action.completed",
      payload: {
        action,
        summary: summarizeActionResult(result)
      }
    });

    invalidateAdapterCache();
    writeJson(response, 200, { ok: true, result });
    return;
  }

  if (method === "POST" && pathname === "/api/tasks") {
    const body = await readJson(request);
    const adapter = registry.get(body.source);
    const task = await adapter.startTask(body);
    invalidateAdapterCache();
    writeJson(response, 201, { ok: true, task });
    return;
  }

  if (method === "POST" && pathname === "/api/messages") {
    const body = await readJson(request);
    const adapter = registry.get(body.source);
    if (body.asyncAck === true) {
      const requestId = String(body.requestId || "").trim().slice(0, 160);
      const content = String(body.content || body.prompt || body.message || "").trim();
      if (!requestId) throw httpError(400, "Async message request requires requestId.");
      if (!content) throw httpError(400, "Message content is empty.");

      pruneAcceptedMessageRequests();
      const requestKey = `${body.source}:${requestId}`;
      const existing = acceptedMessageRequests.get(requestKey);
      if (existing) {
        writeJson(response, 202, existing.response);
        return;
      }

      const acceptedAt = new Date().toISOString();
      const accepted = {
        ok: true,
        accepted: true,
        requestId,
        message: {
          id: `accepted:${body.source}:${requestId}`,
          conversationId: body.conversationId,
          source: body.source,
          role: "user",
          content,
          createdAt: acceptedAt,
          metadata: { accepted: true, requestId }
        }
      };
      acceptedMessageRequests.set(requestKey, { acceptedAt: Date.now(), response: accepted });
      Promise.resolve()
        .then(() => adapter.sendMessage(body))
        .then((message) => {
          acceptedMessageRequests.set(requestKey, {
            acceptedAt: Date.now(),
            response: { ...accepted, delivered: true, message }
          });
          invalidateAdapterCache();
        })
        .catch((error) => {
          acceptedMessageRequests.set(requestKey, {
            acceptedAt: Date.now(),
            response: { ...accepted, delivered: false, deliveryFailed: true }
          });
          eventBus.publish({
            source: body.source,
            type: "runtime.error",
            payload: { action: "send", requestId, error: error.message }
          });
        });
      writeJson(response, 202, accepted);
      return;
    }
    let message;
    try {
      message = await adapter.sendMessage(body);
    } catch (error) {
      eventBus.publish({
        source: body.source,
        type: "runtime.error",
        payload: { action: "send", error: error.message }
      });
      throw error;
    }
    invalidateAdapterCache();
    writeJson(response, 201, { ok: true, message });
    return;
  }

  const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
  if (method === "POST" && approvalMatch) {
    const body = await readJson(request);
    const adapter = registry.get(body.source);
    const approval = await adapter.decideApproval({
      source: body.source,
      approvalId: decodeURIComponent(approvalMatch[1]),
      decision: body.decision,
      approvalDecision: body.approvalDecision,
      approvalScope: body.approvalScope,
      reason: body.reason,
      surface: body.surface,
      conversationId: body.conversationId
    });
    invalidateAdapterCache();
    writeJson(response, 200, { ok: true, approval });
    return;
  }

  writeJson(response, 404, {
    ok: false,
    error: `Route not found: ${method} ${pathname}`
  });
}

function pruneAcceptedMessageRequests() {
  const cutoff = Date.now() - acceptedMessageRequestTtlMs;
  for (const [key, value] of acceptedMessageRequests) {
    if (value.acceptedAt < cutoff) acceptedMessageRequests.delete(key);
  }
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function summarizeActionResult(result) {
  if (Array.isArray(result)) return { count: result.length };
  if (!result || typeof result !== "object") return { value: result ?? null };
  if (Array.isArray(result.items)) return { count: result.items.length };
  if (Array.isArray(result.tasks)) return { count: result.tasks.length };
  if (Array.isArray(result.sessions)) return { count: result.sessions.length };
  if (typeof result.ok === "boolean") return { ok: result.ok };
  if (typeof result.status === "string") return { status: result.status };
  return { ok: true };
}

async function callEach(methodName, options = {}) {
  const cacheKey = methodName;
  const now = Date.now();
  const cacheTtlMs = options.cacheTtlMs ?? config.server.cacheTtlMs;
  const cached = adapterCache.get(cacheKey);

  if (!options.forceRefresh && cached && cached.expiresAt > now) {
    return {
      ...cached.data,
      cached: true,
      phase: "warm",
      cacheAgeMs: now - cached.savedAt
    };
  }

  const startedAt = Date.now();
  const deadlineMs = options.deadlineMs ?? config.server.adapterDeadlineMs;
  const results = await Promise.all(registry.all().map(async (adapter) => {
    try {
      const value = await withDeadline(
        adapter[methodName](),
        deadlineMs,
        `${adapter.source} ${methodName} deadline ${deadlineMs}ms`
      );
      return { source: adapter.source, value };
    } catch (error) {
      return { source: adapter.source, error };
    }
  }));

  const items = [];
  const errors = [];

  for (const result of results) {
    if (result.error) {
      errors.push({ source: result.source, message: result.error.message });
      eventBus.publish({
        source: result.source,
        type: "runtime.error",
        payload: { method: methodName, error: result.error.message }
      });
      continue;
    }

    if (Array.isArray(result.value)) {
      items.push(...result.value);
    } else if (result.value !== undefined) {
      items.push(result.value);
    }
  }

  const data = {
    items,
    errors,
    cached: false,
    phase: "cold",
    durationMs: Date.now() - startedAt
  };
  adapterCache.set(cacheKey, {
    data,
    savedAt: Date.now(),
    expiresAt: now + cacheTtlMs
  });
  return data;
}

function withDeadline(promise, deadlineMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), deadlineMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function invalidateAdapterCache() {
  adapterCache.clear();
}

function limitItems(data, maxItems, sorter) {
  const items = [...(data.items || [])];
  if (sorter) items.sort(sorter);
  return {
    ...data,
    items: items.slice(0, maxItems),
    limit: maxItems,
    totalBeforeLimit: items.length
  };
}

function byUpdatedAtDesc(a, b) {
  return timestampOf(b.updatedAt || b.updated_at || b.lastActivityAt || b.createdAt)
    - timestampOf(a.updatedAt || a.updated_at || a.lastActivityAt || a.createdAt);
}

function timestampOf(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function shouldForceRefresh(requestUrl) {
  const value = requestUrl.searchParams.get("refresh");
  return value === "1" || value === "true";
}

async function serveStatic(urlPath, response) {
  const cleanPath = urlPath === "/" ? "/index.html" : decodeURIComponent(urlPath);
  const filePath = path.resolve(webRoot, `.${cleanPath}`);
  const relativePath = path.relative(webRoot, filePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    writeText(response, 403, "Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const indexPath = path.join(webRoot, "index.html");
    writeFile(response, indexPath);
    return;
  }

  writeFile(response, filePath);
}

function writeFile(response, filePath) {
  response.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Cache-Control": cacheControl(filePath),
    ...(path.basename(filePath) === "service-worker.js" ? { "Service-Worker-Allowed": "/" } : {})
  });
  fs.createReadStream(filePath).pipe(response);
}

function writeJson(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function writeText(response, status, text) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(text);
}

function setCommonHeaders(response, request) {
  const origin = request.headers.origin;
  if (origin && config.server.allowedOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Control-Token");
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function requireSameOriginPushRequest(request) {
  const fetchSite = String(request.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") {
    throw httpError(403, "Web Push subscription changes require a same-origin request.");
  }
  const origin = String(request.headers.origin || "").trim();
  if (!origin) return;
  let originUrl;
  try { originUrl = new URL(origin); } catch { throw httpError(403, "Invalid request origin."); }
  if (originUrl.host !== String(request.headers.host || "")) {
    throw httpError(403, "Web Push subscription changes require a same-origin request.");
  }
}

async function readJson(request, options = {}) {
  const maxBytes = options.maxBytes ?? config.server.maxBodyBytes;
  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > maxBytes) throw requestError("Request body too large.", 413, "request_too_large");
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw requestError("Request body too large.", 413, "request_too_large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".webmanifest")) return "application/manifest+json; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function cacheControl(filePath) {
  const fileName = path.basename(filePath);
  if (fileName === "index.html" || fileName === "service-worker.js") return "no-cache";
  if (filePath.endsWith(".js") || filePath.endsWith(".css") || filePath.endsWith(".webmanifest")) return "no-cache";
  if (filePath.includes(`${path.sep}assets${path.sep}`)) return "public, max-age=31536000, immutable";
  return "no-cache";
}

function isAuthorized(request) {
  const authorization = String(request.headers.authorization || "");
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const headerToken = String(request.headers["x-control-token"] || "");
  const cookieToken = readCookie(request.headers.cookie, "hermes_control_session");
  return [bearer, headerToken, cookieToken].some((value) => constantTimeEquals(value, config.server.authToken));
}

function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function constantTimeEquals(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function isHermesBridgeTransportRoute(method, pathname) {
  return (method === "POST" && pathname === "/api/hermes/events")
    || (method === "GET" && pathname === "/api/hermes/approval-decisions/claim")
    || (method === "POST" && /^\/api\/hermes\/approval-decisions\/[^/]+\/ack$/.test(pathname));
}

function requireJsonContentType(request) {
  const value = String(request.headers["content-type"] || "").toLowerCase();
  if (!value.startsWith("application/json")) {
    throw requestError("Content-Type must be application/json", 415, "unsupported_media_type");
  }
}

function requestError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function allowRate(request) {
  const key = request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const current = rateBuckets.get(key);
  if (!current || now - current.startedAt >= config.server.rateLimitWindowMs) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= config.server.rateLimitMax;
}
