import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EventBus } from "../apps/server/src/infrastructure/EventBus.mjs";
import { PushNotificationService } from "../apps/server/src/infrastructure/PushNotificationService.mjs";

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-control-clean-push-"));
  const sent = [];
  const sender = {
    setVapidDetails(...values) { this.vapid = values; },
    async sendNotification(subscription, payload, options) {
      sent.push({ subscription, payload: JSON.parse(payload), options });
      if (overrides.statusCode) throw Object.assign(new Error("push failed"), { statusCode: overrides.statusCode });
      return { statusCode: 201 };
    }
  };
  const service = new PushNotificationService({
    enabled: true,
    publicKey: "p".repeat(87),
    privateKey: "s".repeat(43),
    subject: "https://example.invalid",
    ttlSeconds: 3600,
    maxSubscriptions: 10,
    stateFile: path.join(root, "push.json")
  }, { sender });
  return { root, sent, sender, service };
}

function subscription(id = "one") {
  return {
    endpoint: `https://web.push.apple.com/${id}`,
    expirationTime: null,
    keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) }
  };
}

test("Web Push is opt-in and validates VAPID before loading transport", async () => {
  const { service } = fixture();
  service.config.publicKey = "short";
  await assert.rejects(service.start(), /VAPID public key/);

  const disabled = new PushNotificationService({ enabled: false });
  await disabled.start();
  assert.deepEqual(disabled.status(), {
    enabled: false,
    ready: false,
    supported: false,
    publicKey: "",
    subscriptionCount: 0
  });
});

test("Web Push persists only the browser subscription and never the VAPID private key", async () => {
  const { service } = fixture();
  await service.start();
  service.subscribe(subscription());
  const stored = fs.readFileSync(service.config.stateFile, "utf8");
  assert.match(stored, /web\.push\.apple\.com/);
  assert.equal(stored.includes(service.config.privateKey), false);
  assert.equal(stored.includes("userAgent"), false);
});

test("Web Push accepts known browser services and rejects arbitrary public or local endpoints", async () => {
  const { service } = fixture();
  await service.start();
  assert.doesNotThrow(() => service.subscribe(subscription("apple")));
  assert.throws(() => service.subscribe({ ...subscription(), endpoint: "https://example.com/push" }), /approved browser push service/);
  assert.throws(() => service.subscribe({ ...subscription(), endpoint: "https://127.0.0.1/private" }), /public HTTPS URL/);
});

test("terminal events from Codex and Hermes produce privacy-safe notifications without touching adapters", async () => {
  const { service, sent } = fixture();
  await service.start();
  service.subscribe(subscription());
  const privateOutput = "private assistant response must never leave the server";
  await service.handleEvent({
    id: "codex-event",
    source: "codex",
    type: "task.completed",
    taskId: "codex-task",
    payload: { status: "completed", output: privateOutput }
  });
  await service.handleEvent({
    id: "hermes-event",
    source: "hermes",
    type: "task.failed",
    taskId: "hermes-task",
    payload: { status: "failed", error: privateOutput }
  });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((item) => item.payload.title), ["Codex task completed", "Hermes task failed"]);
  assert.equal(JSON.stringify(sent).includes(privateOutput), false);
  assert.ok(sent.every((item) => item.payload.icon === "/assets/pwa-clean-icon-192.png"));
});

test("EventBus observers are asynchronous, isolated, and deduplicate terminal delivery", async () => {
  const { service, sent } = fixture();
  await service.start();
  service.subscribe(subscription());
  const bus = new EventBus();
  bus.subscribe((event) => service.handleEvent(event), { types: ["task.completed", "task.failed"] });
  bus.subscribe(() => { throw new Error("observer isolation"); });
  const input = { source: "codex", type: "task.completed", taskId: "same-task", payload: { status: "completed" } };
  assert.doesNotThrow(() => bus.publish(input));
  assert.doesNotThrow(() => bus.publish(input));
  assert.doesNotThrow(() => bus.publish({ source: "codex", type: "task.progress", taskId: "same-task" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
});

test("expired subscriptions are removed without failing runtime completion", async () => {
  const { service } = fixture({ statusCode: 410 });
  await service.start();
  service.subscribe(subscription("expired"));
  const result = await service.handleEvent({ source: "hermes", type: "task.completed", taskId: "h-1", payload: {} });
  assert.deepEqual(result, { sent: 0, removed: 1, failed: 0 });
  assert.equal(service.status().subscriptionCount, 0);
});

test("Clean PWA contains the opt-in UI and background notification handlers", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const html = fs.readFileSync(path.join(root, "apps", "web", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "apps", "web", "app.js"), "utf8");
  const worker = fs.readFileSync(path.join(root, "apps", "web", "service-worker.js"), "utf8");
  assert.match(html, /id="premiumNotificationToggle"/);
  assert.match(app, /pushManager\.subscribe/);
  assert.match(worker, /addEventListener\("push"/);
  assert.match(worker, /addEventListener\("notificationclick"/);
});

test("public push routes remain authenticated, same-origin and opt-in", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const server = fs.readFileSync(path.join(root, "apps", "server", "src", "server.mjs"), "utf8");
  const config = fs.readFileSync(path.join(root, "apps", "server", "src", "infrastructure", "config.mjs"), "utf8");
  assert.match(server, /pathname === "\/api\/push\/subscriptions"/);
  assert.match(server, /requireSameOriginPushRequest\(request\)/);
  assert.match(server, /requestUrl\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(config, /CONTROL_WEB_PUSH_ENABLED/);
  assert.match(config, /CONTROL_WEB_PUSH_PRIVATE_KEY/);
});
