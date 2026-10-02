import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { HermesApiClient } from "../apps/server/src/adapters/hermes/HermesApiClient.mjs";
import { HermesRuntimeAdapter } from "../apps/server/src/adapters/hermes/HermesRuntimeAdapter.mjs";
import { EventBus } from "../apps/server/src/infrastructure/EventBus.mjs";

test("Hermes health timeout reports a useful bounded error", async (t) => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const client = new HermesApiClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiPrefix: "/api",
    timeoutMs: 40
  });

  await assert.rejects(
    client.health(),
    (error) => error.code === "HERMES_TIMEOUT" && /timed out after 40ms/i.test(error.message)
  );
});

test("Hermes runtime stays visible as offline when remote health is unavailable", async () => {
  const bridgeHealth = {
    ok: true,
    enabled: true,
    configured: true,
    status: "ready",
    pendingApprovals: 0
  };
  const runtime = new HermesRuntimeAdapter({
    baseUrl: "http://127.0.0.1:1",
    apiPrefix: "/api",
    timeoutMs: 100,
    ws: { enabled: false }
  }, new EventBus(), {
    monitorExternalApprovals: false,
    bridgeReceiver: { health: () => bridgeHealth }
  });
  runtime.client.health = async () => {
    const error = new Error("Hermes request timed out after 100ms.");
    error.code = "HERMES_TIMEOUT";
    throw error;
  };

  const result = await runtime.health();

  assert.equal(result.source, "hermes");
  assert.equal(result.ok, false);
  assert.equal(result.status, "offline");
  assert.equal(result.details.status, "offline");
  assert.equal(result.details.remote.connected, false);
  assert.match(result.details.error, /timed out after 100ms/i);
  assert.equal(result.details.capabilities.includes("health"), true);
  assert.deepEqual(result.details.control.bridge, bridgeHealth);
});
