import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { EventBus } from "../apps/server/src/infrastructure/EventBus.mjs";
import { HermesRuntimeAdapter } from "../apps/server/src/adapters/hermes/HermesRuntimeAdapter.mjs";

test("Hermes adapter covers the public WebUI contract with auth, SSE, approval, and cancel", async () => {
  const state = {
    loginCount: 0,
    models401Once: true,
    approvalChoice: "",
    cancelRequested: false,
    streamCount: 0
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const protectedRoute = url.pathname.startsWith("/api/")
      && !["/api/auth/status", "/api/auth/login"].includes(url.pathname);
    if (protectedRoute && request.headers.cookie !== "hermes_session=mock") {
      return json(response, 401, { error: "Authentication required" });
    }

    if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { status: "ok", runs: [] });
    if (request.method === "GET" && url.pathname === "/api/auth/status") {
      return json(response, 200, { auth_enabled: true, logged_in: Boolean(request.headers.cookie) });
    }
    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      state.loginCount += 1;
      await readBody(request);
      response.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "hermes_session=mock; Path=/; HttpOnly" });
      return response.end(JSON.stringify({ ok: true }));
    }
    if (request.method === "GET" && url.pathname === "/api/profiles") {
      return json(response, 200, { profiles: [{ name: "default", is_active: true, is_default: true, model: "test/model" }] });
    }
    if (request.method === "GET" && url.pathname === "/api/sessions/search") {
      return json(response, 200, { sessions: [{ session_id: "s-old", title: "Older", updated_at: "2026-07-28T00:00:00Z" }], count: 1 });
    }
    if (request.method === "GET" && url.pathname === "/api/models") {
      if (state.models401Once) {
        state.models401Once = false;
        return json(response, 401, { error: "expired" });
      }
      return json(response, 200, { models: [{ id: "test/model" }] });
    }
    if (request.method === "GET" && url.pathname === "/api/system/health") return json(response, 200, { status: "ok" });
    if (request.method === "GET" && url.pathname === "/api/kanban/boards") return json(response, 404, { error: "not found" });
    if (request.method === "GET" && url.pathname === "/api/kanban/tasks") {
      return json(response, 200, { tasks: [{ id: "task-1", title: "Fixture task", status: "todo" }], count: 1 });
    }
    if (request.method === "POST" && url.pathname === "/api/session/new") {
      await readBody(request);
      return json(response, 200, { session: { session_id: "s1" } });
    }
    if (request.method === "GET" && url.pathname === "/api/approval/pending") {
      return json(response, 200, { pending: { approval_id: "a1", command: "fixture command", question: "Allow?" } });
    }
    if (request.method === "POST" && url.pathname === "/api/approval/respond") {
      const body = await readBody(request);
      state.approvalChoice = body.choice;
      return json(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/chat/start") {
      const body = await readBody(request);
      state.streamCount += 1;
      const streamId = body.message === "cancel me" ? "stream-cancel" : "stream-1";
      return json(response, 200, { stream_id: streamId });
    }
    if (request.method === "GET" && url.pathname === "/api/chat/stream") {
      const streamId = url.searchParams.get("stream_id");
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      if (streamId === "stream-cancel") {
        return setTimeout(() => {
          response.write("event: done\ndata: {\"status\":\"cancelled\"}\n\n");
          response.end();
        }, 50);
      }
      response.write("event: token\ndata: {\"text\":\"hello\"}\n\n");
      response.write("event: reasoning\ndata: {\"reasoning\":\"planning\"}\n\n");
      response.write("event: tool\ndata: {\"name\":\"fixture\",\"status\":\"running\"}\n\n");
      response.write("event: done\ndata: {\"status\":\"done\"}\n\n");
      return response.end();
    }
    if (request.method === "GET" && url.pathname === "/api/chat/cancel") {
      state.cancelRequested = true;
      return json(response, 200, { ok: true, cancelled: true });
    }
    return json(response, 404, { error: "not found" });
  });

  await listen(server);
  try {
    const address = server.address();
    const eventBus = new EventBus();
    const adapter = new HermesRuntimeAdapter({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiPrefix: "/api",
      password: "fixture-password",
      profile: "default",
      model: "test/model",
      timeoutMs: 1000,
      streamTimeoutMs: 1000,
      maxPromptChars: 1000
    }, eventBus);
    const streamFrames = [];
    eventBus.clients.add({ write: (frame) => streamFrames.push(frame) });

    const preflight = await adapter.preflight();
    assert.equal(preflight.results.find((item) => item.name === "auth-status").ok, true);
    assert.equal(preflight.results.find((item) => item.name === "profiles").ok, true);
    assert.equal(preflight.results.find((item) => item.name === "kanban").ok, true);
    assert.equal(preflight.results.find((item) => item.name === "chat").tested, false);
    assert.equal(preflight.results.find((item) => item.name === "approval-respond").reason, "write-required");

    assert.equal((await adapter.listAgents()).length, 1);
    assert.equal((await adapter.listConversations()).length, 1);
    assert.equal((await adapter.listTasks()).length, 1);
    assert.equal((await adapter.runAction("models")).models.length, 1);
    assert.equal(state.loginCount >= 2, true, "401 should cause a fresh Hermes login");

    const created = await adapter.runAction("new-task");
    assert.equal(created.sessionId, "s1");
    assert.equal((await adapter.listApprovals())[0].id, "a1");

    const approval = await adapter.decideApproval({
      conversationId: "hermes:s1",
      approvalId: "a1",
      decision: "approve"
    });
    assert.equal(approval.status, "approved");
    assert.equal(state.approvalChoice, "once");

    await adapter.sendMessage({ conversationId: "hermes:s1", content: "hello", reasoning: "med" });
    await waitFor(() => eventBus.list(100).some((event) => event.type === "task.completed"));
    assert.equal(streamFrames.some((frame) => frame.includes('"event":"token"')), true);
    assert.equal(streamFrames.some((frame) => frame.includes('"event":"reasoning"')), true);

    const cancelMessage = await adapter.sendMessage({ conversationId: "hermes:s1", content: "cancel me" });
    await adapter.cancelTask(cancelMessage.id);
    assert.equal(state.cancelRequested, true);
  } finally {
    await close(server);
  }
});

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for Hermes fixture event.");
}
