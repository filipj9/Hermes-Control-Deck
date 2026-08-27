import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const TERMINAL_TYPES = new Set(["task.completed", "task.failed"]);
const TRUSTED_PUSH_HOSTS = [
  ".push.apple.com",
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  ".notify.windows.com"
];

export class PushNotificationService {
  constructor(config, options = {}) {
    this.config = config;
    this.sender = options.sender;
    this.logger = options.logger || (() => {});
    this.subscriptions = [];
    this.ready = false;
    this.sentKeys = new Set();
    this.sentKeyOrder = [];
  }

  async start() {
    if (!this.config.enabled) return;
    validatePushConfig(this.config);
    if (!this.sender) {
      const imported = await import("web-push");
      this.sender = imported.default || imported;
    }
    this.sender.setVapidDetails(
      this.config.subject,
      this.config.publicKey,
      this.config.privateKey
    );
    this.subscriptions = loadSubscriptions(this.config.stateFile, this.logger)
      .slice(-this.config.maxSubscriptions);
    this.ready = true;
  }

  status() {
    return {
      enabled: this.config.enabled,
      ready: this.ready,
      supported: this.config.enabled && this.ready,
      publicKey: this.config.enabled && this.ready ? this.config.publicKey : "",
      subscriptionCount: this.subscriptions.length
    };
  }

  subscribe(input) {
    this.assertReady();
    const subscription = normalizeSubscription(input);
    const index = this.subscriptions.findIndex((item) => item.endpoint === subscription.endpoint);
    const created = index === -1;
    if (created) this.subscriptions.push(subscription);
    else this.subscriptions[index] = { ...this.subscriptions[index], ...subscription };
    this.subscriptions = this.subscriptions.slice(-this.config.maxSubscriptions);
    this.persist();
    return { created, subscriptionCount: this.subscriptions.length };
  }

  unsubscribe(endpoint) {
    this.assertReady();
    const normalized = normalizeEndpoint(endpoint);
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter((item) => item.endpoint !== normalized);
    if (this.subscriptions.length !== before) this.persist();
    return { removed: before - this.subscriptions.length, subscriptionCount: this.subscriptions.length };
  }

  async sendTest(source = "system") {
    this.assertReady();
    return await this.sendPayload({
      title: "Hermes Control notifications enabled",
      body: "Background Web Push is connected.",
      tag: "hermes-control-push-test",
      data: { url: "/?notification=test", source }
    });
  }

  async handleEvent(event) {
    if (!this.ready || !TERMINAL_TYPES.has(event?.type)) return { skipped: true };
    const key = terminalKey(event);
    if (this.sentKeys.has(key)) return { skipped: true, duplicate: true };
    this.remember(key);

    const failed = event.type === "task.failed" || event.payload?.status === "failed";
    const cancelled = event.payload?.status === "cancelled";
    const source = event.source === "hermes" ? "Hermes" : event.source === "codex" ? "Codex" : "Agent";
    const state = failed ? "failed" : cancelled ? "was cancelled" : "completed";
    return await this.sendPayload({
      title: `${source} task ${state}`,
      body: "Open Hermes Control to view the result.",
      tag: key.slice(0, 120),
      data: {
        url: taskUrl(event),
        source: event.source,
        taskId: safeIdentifier(event.taskId)
      }
    });
  }

  async sendPayload(payload) {
    if (!this.subscriptions.length) return { sent: 0, removed: 0, failed: 0 };
    const body = JSON.stringify({
      title: String(payload.title || "Hermes Control").slice(0, 80),
      body: String(payload.body || "Task update available.").slice(0, 160),
      tag: String(payload.tag || "hermes-control-task").slice(0, 120),
      icon: "/assets/pwa-clean-icon-192.png",
      badge: "/assets/pwa-clean-icon-192.png",
      data: payload.data || { url: "/" }
    });

    const stale = new Set();
    let sent = 0;
    let failed = 0;
    for (const subscription of [...this.subscriptions]) {
      try {
        await this.sender.sendNotification(subscription, body, { TTL: this.config.ttlSeconds });
        sent += 1;
      } catch (error) {
        if (error?.statusCode === 404 || error?.statusCode === 410) stale.add(subscription.endpoint);
        else failed += 1;
        this.logger(`Web Push delivery failed (${error?.statusCode || "network"}).`);
      }
    }

    if (stale.size) {
      this.subscriptions = this.subscriptions.filter((item) => !stale.has(item.endpoint));
      this.persist();
    }
    return { sent, removed: stale.size, failed };
  }

  assertReady() {
    if (!this.config.enabled || !this.ready) {
      const error = new Error("Web Push is not enabled or ready.");
      error.statusCode = 503;
      error.code = "web_push_unavailable";
      throw error;
    }
  }

  remember(key) {
    this.sentKeys.add(key);
    this.sentKeyOrder.push(key);
    while (this.sentKeyOrder.length > 500) {
      this.sentKeys.delete(this.sentKeyOrder.shift());
    }
  }

  persist() {
    persistSubscriptions(this.config.stateFile, this.subscriptions);
  }
}

function terminalKey(event) {
  const identity = safeIdentifier(event.taskId || event.conversationId || event.id || "unknown");
  return `${event.source || "runtime"}:${event.type}:${identity}`;
}

function taskUrl(event) {
  const params = new URLSearchParams({ notification: "task" });
  if (event.source) params.set("source", safeIdentifier(event.source));
  if (event.taskId) params.set("task", safeIdentifier(event.taskId));
  return `/?${params.toString()}`;
}

function safeIdentifier(value) {
  return String(value || "").replace(/[^a-zA-Z0-9:._-]/g, "").slice(0, 160);
}

function normalizeSubscription(input) {
  const endpoint = normalizeEndpoint(input?.endpoint);
  const p256dh = normalizeKey(input?.keys?.p256dh, "p256dh", 80);
  const auth = normalizeKey(input?.keys?.auth, "auth", 16);
  return {
    endpoint,
    expirationTime: Number.isFinite(input?.expirationTime) ? input.expirationTime : null,
    keys: { p256dh, auth },
    createdAt: new Date().toISOString()
  };
}

function normalizeEndpoint(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 2048) throw invalidSubscription("Invalid Web Push endpoint.");
  let url;
  try { url = new URL(text); } catch { throw invalidSubscription("Invalid Web Push endpoint."); }
  if (url.protocol !== "https:" || url.username || url.password || isLocalHost(url.hostname)) {
    throw invalidSubscription("Web Push endpoint must be a public HTTPS URL.");
  }
  if (!isTrustedPushHost(url.hostname)) {
    throw invalidSubscription("Web Push endpoint host is not an approved browser push service.");
  }
  return url.toString();
}

function normalizeKey(value, name, minLength) {
  const text = String(value || "").trim();
  if (text.length < minLength || text.length > 512 || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw invalidSubscription(`Invalid Web Push ${name} key.`);
  }
  return text;
}

function isLocalHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (!net.isIP(host)) return false;
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function isTrustedPushHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return TRUSTED_PUSH_HOSTS.some((allowed) => allowed.startsWith(".")
    ? host.endsWith(allowed)
    : host === allowed);
}

function validatePushConfig(config) {
  if (!/^[A-Za-z0-9_-]{80,120}$/.test(String(config.publicKey || ""))) {
    throw new Error("CONTROL_WEB_PUSH_PUBLIC_KEY must contain a valid VAPID public key.");
  }
  if (!/^[A-Za-z0-9_-]{40,80}$/.test(String(config.privateKey || ""))) {
    throw new Error("CONTROL_WEB_PUSH_PRIVATE_KEY must contain a valid VAPID private key.");
  }
  if (!/^(?:mailto:|https:\/\/)/i.test(String(config.subject || ""))) {
    throw new Error("CONTROL_WEB_PUSH_SUBJECT must be a mailto: or HTTPS URI.");
  }
  if (config.ttlSeconds < 0 || config.ttlSeconds > 86400 || config.maxSubscriptions < 1 || config.maxSubscriptions > 100) {
    throw new Error("Web Push TTL or subscription limit is invalid.");
  }
}

function invalidSubscription(message) {
  const error = new Error(message);
  error.statusCode = 422;
  error.code = "invalid_push_subscription";
  return error;
}

function loadSubscriptions(filePath, logger) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed?.subscriptions)
      ? parsed.subscriptions.map(normalizeSubscription).filter(Boolean)
      : [];
  } catch {
    logger("Web Push subscription state could not be loaded; starting empty.");
    return [];
  }
}

function persistSubscriptions(filePath, subscriptions) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const state = { version: 1, subscriptions };
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* Best effort on Windows. */ }
}
