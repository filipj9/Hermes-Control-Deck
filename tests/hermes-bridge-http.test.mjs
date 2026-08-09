import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(root, "apps", "server", "src", "server.mjs");
const token = "integration-test-token-32-characters";
const controlToken = "control-integration-token-32-characters";

test("HTTP receiver enforces auth, limits, dedupe, ordering and live SSE", { timeout: 20_000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-bridge-http-"));
  const port = await freePort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: {
      ...process.env,
      CONTROL_SERVER_HOST: "127.0.0.1",
      CONTROL_SERVER_PORT: String(port),
      CONTROL_AUTH_TOKEN: controlToken,
      HERMES_ENABLED: "false",
      CODEX_ENABLED: "false",
      CODEX_DESKTOP_ENABLED: "false",
      HERMES_BRIDGE_ENABLED: "true",
      HERMES_BRIDGE_TOKEN: token,
      HERMES_BRIDGE_STATE_FILE: path.join(dataDir, "receiver.json")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(() => {
    child.kill("SIGTERM");
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForServer(`http://127.0.0.1:${port}/`, child, () => stderr);
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/api/hermes/events/health`, { headers: controlHeaders() });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ready");

  const event = bridgeEvent("http-event-1", "http-run-1", 0, "stream_start");
  assert.equal((await fetch(`${base}/api/hermes/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event)
  })).status, 401);

  assert.equal((await fetch(`${base}/api/hermes/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
    body: JSON.stringify(event)
  })).status, 415);

  assert.equal((await fetch(`${base}/api/hermes/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(17_000) })
  })).status, 413);

  const controller = new AbortController();
  const sseResponse = await fetch(`${base}/events`, { headers: controlHeaders(), signal: controller.signal });
  assert.equal(sseResponse.status, 200);
  const reader = sseResponse.body.getReader();
  const sseEvent = bridgeEvent("http-sse-1", "http-sse-run", 0, "stream_start");
  const accepted = await post(base, sseEvent);
  assert.equal(accepted.status, 202);
  assert.match(await readUntil(reader, "http-sse-1", 3000), /task\.created/);
  controller.abort();

  const tasks = await (await fetch(`${base}/api/tasks`, { headers: controlHeaders() })).json();
  assert.equal(tasks.items.some((task) => task.id === "hermes:bridge:http-sse-run"), true);

  const duplicate = await post(base, sseEvent);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);

  assert.equal((await post(base, bridgeEvent("order-2", "order-run", 2, "tool"))).status, 202);
  const outOfOrder = await post(base, bridgeEvent("order-1", "order-run", 1, "reasoning"));
  assert.equal(outOfOrder.status, 409);
  assert.equal((await outOfOrder.json()).code, "out_of_order");
});

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

function bridgeEvent(eventId, runId, seq, event) {
  return {
    event_id: eventId,
    run_id: runId,
    seq,
    event,
    created_at: new Date().toISOString(),
    session_id: "integration-session",
    source: "hermes-gateway-state-db",
    payload: { task_title: "HTTP integration test" }
  };
}

function post(base, body) {
  return fetch(`${base}/api/hermes/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function controlHeaders() {
  return { "x-control-token": controlToken };
}

async function waitForServer(url, child, getStderr) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Test server exited early: ${getStderr()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Test server did not start: ${getStderr()}`);
}

async function readUntil(reader, needle, timeoutMs) {
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("SSE read timeout")), remaining))
    ]);
    if (result.done) break;
    output += decoder.decode(result.value, { stream: true });
    if (output.includes(needle)) return output;
  }
  throw new Error(`SSE did not contain ${needle}`);
}
