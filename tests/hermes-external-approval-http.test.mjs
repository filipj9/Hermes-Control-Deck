import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(root, "apps", "server", "src", "server.mjs");
const bridgeToken = "external-approval-test-token-32-chars";
const controlToken = "external-control-test-token-32-chars";

test("forwards an external Hermes approval from bridge session to HTTP, SSE and decision", { timeout: 20_000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-approval-http-"));
  const mockRoutes = [];
  const mockHermes = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://mock-hermes");
    mockRoutes.push(requestUrl.pathname);
    if (requestUrl.pathname === "/health") return json(response, 200, { status: "ok" });
    if (requestUrl.pathname === "/api/auth/login") {
      response.setHeader("Set-Cookie", "hermes_session=test; Path=/; HttpOnly");
      return json(response, 200, { ok: true });
    }
    return json(response, 404, { error: "not found" });
  });
  await listen(mockHermes);
  const mockPort = mockHermes.address().port;

  const controlPort = await freePort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: {
      ...process.env,
      CONTROL_SERVER_HOST: "127.0.0.1",
      CONTROL_SERVER_PORT: String(controlPort),
      CONTROL_AUTH_TOKEN: controlToken,
      HERMES_ENABLED: "true",
      HERMES_BASE_URL: "http://127.0.0.1:" + mockPort,
      HERMES_PASSWORD: "integration-password",
      HERMES_BRIDGE_ENABLED: "true",
      HERMES_BRIDGE_TOKEN: bridgeToken,
      HERMES_BRIDGE_STATE_FILE: path.join(dataDir, "receiver.json"),
      CODEX_ENABLED: "false",
      CODEX_DESKTOP_ENABLED: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(() => {
    child.kill("SIGTERM");
    mockHermes.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const base = "http://127.0.0.1:" + controlPort;
  await waitForServer(base + "/", child, () => stderr);
  const controller = new AbortController();
  const sseResponse = await fetch(base + "/events", { headers: controlHeaders(), signal: controller.signal });
  const reader = sseResponse.body.getReader();

  await postApprovalBridge(base, "approval_requested", 0, {
    approval_id: "external-http-approval-1",
    gateway_id: "laptop-a",
    command: "echo integration",
    question: "Allow integration command?",
    surface: "gateway"
  });
  const approvalEvent = await readUntil(reader, "approval.requested", 5000);
  assert.match(approvalEvent, /external-http-approval-1/);

  const approvals = await (await fetch(base + "/api/approvals?refresh=1", { headers: controlHeaders() })).json();
  const approval = approvals.items.find((item) => item.id === "external-http-approval-1");
  assert.equal(approval.conversationId, "hermes:external-http-session");

  const decision = await fetch(base + "/api/approvals/external-http-approval-1/decision", {
    method: "POST",
    headers: { ...controlHeaders(), "content-type": "application/json" },
    body: JSON.stringify({
      source: "hermes",
      decision: "approve",
      approvalScope: "once"
    })
  });
  assert.equal(decision.status, 200);
  assert.equal(mockRoutes.includes("/api/approval/respond"), false);

  const claimed = await fetch(base + "/api/hermes/approval-decisions/claim?gateway_id=laptop-a&limit=1", {
    headers: { authorization: "Bearer " + bridgeToken }
  });
  assert.equal(claimed.status, 200);
  const claimedBody = await claimed.json();
  assert.equal(claimedBody.items.length, 1);
  assert.equal(claimedBody.items[0].approvalId, "external-http-approval-1");
  assert.equal(claimedBody.items[0].approval_id, "external-http-approval-1");
  assert.equal(claimedBody.items[0].gateway_id, "laptop-a");
  assert.equal(claimedBody.items[0].session_id, "external-http-session");
  assert.equal(claimedBody.items[0].choice, "once");

  const ack = await fetch(base + "/api/hermes/approval-decisions/" + encodeURIComponent(claimedBody.items[0].id) + "/ack", {
    method: "POST",
    headers: {
      authorization: "Bearer " + bridgeToken,
      "content-type": "application/json"
    },
    body: JSON.stringify({ gateway_id: "laptop-a", status: "applied" })
  });
  assert.equal(ack.status, 200);

  await postApprovalBridge(base, "approval_resolved", 1, {
    approval_id: "external-http-approval-1",
    gateway_id: "laptop-a",
    decision_id: claimedBody.items[0].id,
    choice: "once",
    status: "applied"
  });
  assert.match(await readUntil(reader, "approval.resolved", 3000), /external-http-approval-1/);
  const after = await (await fetch(base + "/api/approvals?refresh=1", { headers: controlHeaders() })).json();
  assert.equal(after.items.some((item) => item.id === "external-http-approval-1"), false);
  controller.abort();
});

function postApprovalBridge(base, event, seq, payload) {
  return fetch(base + "/api/hermes/events", {
    method: "POST",
    headers: {
      authorization: "Bearer " + bridgeToken,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      event_id: "external-http-event-" + seq,
      run_id: "external-http-approval-1",
      seq,
      event,
      session_id: "external-http-session",
      task_id: "external-http-run",
      source: "hermes-control-relay",
      payload
    })
  });
}

function controlHeaders() {
  return { "x-control-token": controlToken };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function waitForServer(url, child, getStderr) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Test server exited early: " + getStderr());
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Test server did not start: " + getStderr());
}

async function readUntil(reader, needle, timeoutMs) {
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("SSE did not contain " + needle)), deadline - Date.now()))
    ]);
    if (result.done) break;
    output += decoder.decode(result.value, { stream: true });
    if (output.includes(needle)) return output;
  }
  throw new Error("SSE did not contain " + needle);
}
