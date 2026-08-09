import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { HermesApiClient } from "../apps/server/src/adapters/hermes/HermesApiClient.mjs";
import { EventBus } from "../apps/server/src/infrastructure/EventBus.mjs";
import { HermesRuntimeAdapter } from "../apps/server/src/adapters/hermes/HermesRuntimeAdapter.mjs";
import { toHermesTasks } from "../apps/server/src/adapters/hermes/HermesEventMapper.mjs";

test("Hermes mapper exposes an active health run and normalizes waiting aliases", () => {
  const tasks = toHermesTasks({
    status: "ok",
    active_runs: 1,
    active_run: {
      run_id: "run-42",
      session_id: "session-42",
      phase: "waiting",
      description: "Needs approval",
      started_at: 1_753_000_000
    }
  });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, "hermes:run-42");
  assert.equal(tasks[0].conversationId, "hermes:session-42");
  assert.equal(tasks[0].status, "waiting_approval");
  assert.equal(tasks[0].title, "Needs approval");
  assert.equal(tasks[0].createdAt, new Date(1_753_000_000 * 1000).toISOString());
});

test("Hermes task refresh reconciles Kanban with live health and explicit idle", async () => {
  const state = { healthMode: "running" };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": "hermes_session=fixture; Path=/; HttpOnly"
      });
      return response.end(JSON.stringify({ ok: true }));
    }
    if (request.method === "GET" && url.pathname === "/api/kanban/tasks") {
      return json(response, 200, {
        tasks: [
          {
            id: "historical",
            title: "Historical task",
            status: "done",
            updated_at: "2026-08-04T00:00:00Z"
          },
          {
            id: "stale-running",
            title: "Stale task",
            status: "running",
            updated_at: "2020-01-01T00:00:00Z"
          }
        ]
      });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      if (state.healthMode === "running") {
        return json(response, 200, {
          status: "ok",
          active_runs: 1,
          runs: [{ run_id: "live-1", status: "running", title: "WSL live run" }]
        });
      }
      return json(response, 200, { status: "ok", active_runs: 0, runs: [] });
    }
    return json(response, 404, { error: "not found" });
  });

  await listen(server);
  try {
    const address = server.address();
    const adapter = new HermesRuntimeAdapter({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiPrefix: "/api",
      password: "fixture-password",
      profile: "default",
      timeoutMs: 1000,
      maxPromptChars: 1000
    }, new EventBus());

    const activeTasks = await adapter.listTasks();
    const live = activeTasks.find((task) => task.id === "hermes:live-1");
    assert.equal(live?.status, "running");
    assert.equal(live?.title, "WSL live run");

    state.healthMode = "idle";
    const idleTasks = await adapter.listTasks();
    assert.equal(idleTasks.find((task) => task.id === "hermes:stale-running")?.status, "completed");
    assert.equal(idleTasks.find((task) => task.id === "hermes:historical")?.status, "completed");
  } finally {
    await close(server);
  }
});

test("Hermes SSE flushes a final frame without a trailing blank delimiter", async () => {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": "hermes_session=fixture; Path=/; HttpOnly"
      });
      return response.end(JSON.stringify({ ok: true }));
    }
    if (request.method === "GET" && url.pathname === "/api/chat/stream") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end('event: token\ndata: {"text":"tail"}');
      return;
    }
    return json(response, 404, { error: "not found" });
  });

  await listen(server);
  try {
    const address = server.address();
    const client = new HermesApiClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiPrefix: "/api",
      password: "fixture-password",
      timeoutMs: 1000
    });
    const events = [];
    await client.streamSse("/api/chat/stream?stream_id=tail", async (event) => events.push(event));
    assert.deepEqual(events.map((event) => event.data), [{ text: "tail" }]);
  } finally {
    await close(server);
  }
});

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
