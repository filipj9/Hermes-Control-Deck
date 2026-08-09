import assert from "node:assert/strict";
import test from "node:test";

import { HermesRuntimeAdapter } from "../apps/server/src/adapters/hermes/HermesRuntimeAdapter.mjs";
import { HermesWsClient, HermesWsError } from "../apps/server/src/adapters/hermes/HermesWsClient.mjs";

function createConfig() {
  return {
    apiPrefix: "/api",
    baseUrl: "http://unused",
    profile: "default",
    timeoutMs: 3500,
    ws: { enabled: true, url: "ws://unused/api/ws" }
  };
}

test("uses a gated ticket in the WebSocket URL and redacts it from diagnostics", () => {
  const client = new HermesWsClient({
    url: "wss://hermes.example/api/ws?mode=tui",
    ticket: "fresh-ticket",
    token: "legacy-token"
  });

  const built = new URL(client.buildUrl());
  assert.equal(built.searchParams.get("ticket"), "fresh-ticket");
  assert.equal(built.searchParams.get("token"), null);
  assert.equal(client.redactedUrl(), "wss://hermes.example/api/ws?mode=tui");
});

test("can mint a fresh gated ticket from local login credentials", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/auth/password-login")) {
      return {
        ok: true,
        status: 200,
        headers: { getSetCookie: () => ["hermes_session=test-session; Path=/"] },
        json: async () => ({ ok: true })
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { getSetCookie: () => [], get: () => "" },
      json: async () => ({ ticket: "fresh-runtime-ticket", ttl_seconds: 30 })
    };
  };

  try {
    const client = new HermesWsClient({
      url: "ws://hermes.example:8791/api/ws",
      authBaseUrl: "http://hermes.example:8791",
      authProvider: "basic",
      authUsername: "hermes",
      authPassword: "local-only-secret",
      reconnect: true
    });

    await client.refreshTicket();

    assert.equal(client.ticket, "fresh-runtime-ticket");
    assert.equal(client.describe().authMode, "password_login_ticket");
    assert.equal(client.describe().reconnectBlocked, false);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.body.includes("local-only-secret"), true);
    assert.equal(calls[1].options.headers.cookie, "hermes_session=test-session");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not schedule reconnect attempts for a single-use ticket", () => {
  const client = new HermesWsClient({
    url: "wss://hermes.example/api/ws",
    ticket: "single-use-ticket",
    reconnect: true
  });

  client.scheduleReconnect();

  assert.equal(client.reconnectTimer, undefined);
  assert.equal(client.describe().reconnectBlocked, true);
  assert.equal(client.describe().authMode, "single_use_ticket");
});

test("parses complete JSON WebSocket frames without a trailing newline", async () => {
  const events = [];
  const client = new HermesWsClient({}, { onEvent: (event) => events.push(event) });
  const resultPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("RPC response was not parsed")), 1000);
    client.pending.set(7, {
      resolve: (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      reject,
      method: "session.resume",
      sent: true,
      timeout
    });
  });

  client.handleMessage(JSON.stringify({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "gateway.ready", payload: {} }
  }));
  client.handleMessage(JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    result: { session_id: "existing-tui-session", resumed: true }
  }));

  assert.deepEqual(await resultPromise, { session_id: "existing-tui-session", resumed: true });
  assert.equal(events[0].params.type, "gateway.ready");
});

function createAdapter(wsClient) {
  const published = [];
  const adapter = new HermesRuntimeAdapter(createConfig(), {
    publish(event) {
      published.push(event);
    }
  }, {
    monitorExternalApprovals: false,
    wsClient
  });
  return { adapter, published };
}

test("routes a prompt through the optional TUI WebSocket and maps live events", async () => {
  const requests = [];
  const wsClient = {
    isConfigured: () => true,
    describe: () => ({ transport: "hermes-tui/websocket", configured: true, connected: true, pendingRequests: 0 }),
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "session.create") return { session_id: "tui-session-1" };
      if (method === "prompt.submit") return { accepted: true };
      throw new Error(`unexpected method ${method}`);
    }
  };
  const { adapter, published } = createAdapter(wsClient);

  const result = await adapter.sendMessage({ content: "hello from the deck" });

  assert.deepEqual(requests.map((request) => request.method), ["session.create", "prompt.submit"]);
  assert.equal(requests[1].params.session_id, "tui-session-1");
  assert.equal(result.metadata.transport, "websocket");
  assert.equal(published.find((event) => event.type === "task.created")?.payload.status, "running");

  adapter.handleHermesWsEvent({
    method: "event",
    params: {
      type: "message.delta",
      payload: { session_id: "tui-session-1", text: "hello back" }
    }
  });
  adapter.handleHermesWsEvent({
    method: "event",
    params: {
      type: "session.turn_complete",
      payload: { session_id: "tui-session-1" }
    }
  });

  assert.equal(
    published.some((event) => event.type === "conversation.message.created" && event.payload.delta === "hello back"),
    true
  );
  assert.equal(published.filter((event) => event.type === "task.completed").length, 1);
  assert.equal(adapter.wsSessions.size, 0);
});

test("resumes the configured live TUI session before submitting a prompt", async () => {
  const requests = [];
  const wsClient = {
    isConfigured: () => true,
    describe: () => ({ transport: "hermes-tui/websocket", configured: true, connected: true, pendingRequests: 0 }),
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "session.resume") return { session_id: "existing-tui-session" };
      if (method === "prompt.submit") return { accepted: true };
      throw new Error(`unexpected method ${method}`);
    }
  };
  const { adapter } = createAdapter(wsClient);
  adapter.config.ws.sessionId = "existing-tui-session";

  await adapter.sendMessage({ content: "send to the open TUI" });

  assert.deepEqual(requests.map((request) => request.method), ["session.resume", "prompt.submit"]);
  assert.equal(requests[0].params.session_id, "existing-tui-session");
  assert.equal(requests[1].params.session_id, "existing-tui-session");
});

test("uses the canonical session id returned by resume for prompt submission", async () => {
  const requests = [];
  const wsClient = {
    isConfigured: () => true,
    describe: () => ({ transport: "hermes-tui/websocket", configured: true, connected: true, pendingRequests: 0 }),
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "session.resume") return { session_id: "canonical-short-id", resumed: true };
      if (method === "prompt.submit") {
        assert.equal(params.session_id, "canonical-short-id");
        return { status: "accepted" };
      }
      throw new Error(`unexpected method ${method}`);
    }
  };
  const { adapter } = createAdapter(wsClient);
  adapter.config.ws.sessionId = "long-hand-off-session-id";

  const result = await adapter.sendMessage({ content: "use the canonical id" });

  assert.equal(result.metadata.sessionId, "canonical-short-id");
  assert.deepEqual(requests.map((request) => request.method), ["session.resume", "prompt.submit"]);
  assert.equal(adapter.wsActiveSessionId, "canonical-short-id");
});

test("exposes the live TUI session separately from WebUI sessions", async () => {
  const wsClient = {
    isConfigured: () => true,
    describe: () => ({ transport: "hermes-tui/websocket", configured: true, connected: true, pendingRequests: 0 })
  };
  const { adapter } = createAdapter(wsClient);
  adapter.wsActiveSessionId = "canonical-tui-session";
  adapter.client.firstJson = async () => ({
    data: { sessions: [{ session_id: "webui-session", title: "WebUI session" }] }
  });

  const conversations = await adapter.listConversations();

  assert.equal(conversations[0].id, "hermes:canonical-tui-session");
  assert.equal(conversations[0].title, "Live TUI session");
  assert.equal(conversations[0].metadata.transport, "websocket");
  assert.equal(conversations[0].metadata.surface, "tui");
  assert.equal(conversations[0].metadata.selected, true);
  assert.equal(conversations.some((conversation) => conversation.id === "hermes:webui-session"), true);
});

test("falls back to HTTP before sending and closes the provisional TUI task", async () => {
  const wsClient = {
    isConfigured: () => true,
    describe: () => ({ transport: "hermes-tui/websocket", configured: true, connected: true, pendingRequests: 0 }),
    request: async (method) => {
      if (method === "session.create") return { session_id: "tui-session-fallback" };
      throw new HermesWsError("Hermes TUI socket is not open.", { beforeSend: true, code: "not_open" });
    }
  };
  const { adapter, published } = createAdapter(wsClient);
  const httpRoutes = [];
  adapter.client.request = async (route) => {
    httpRoutes.push(route);
    assert.equal(route, "/api/chat/start");
    return { result: "http-fallback-accepted" };
  };

  const result = await adapter.sendMessage({ content: "use the safe fallback" });

  assert.equal(result.metadata.result.result, "http-fallback-accepted");
  assert.deepEqual(httpRoutes, ["/api/chat/start"]);
  assert.equal(adapter.wsSessions.size, 0);
  assert.equal(published.some((event) => event.type === "task.created"), true);
  assert.equal(
    published.some((event) => event.type === "task.failed" && event.payload.fallback === true),
    true
  );
});

test("observes activity from a configured live TUI session without inventing a prompt", () => {
  const wsClient = {
    isConfigured: () => true,
    describe: () => ({ transport: "hermes-tui/websocket", configured: true, connected: true, pendingRequests: 0 })
  };
  const { adapter, published } = createAdapter(wsClient);
  adapter.config.ws.sessionId = "existing-tui-session";

  adapter.handleHermesWsEvent({
    method: "event",
    params: {
      type: "message.start",
      payload: { session_id: "existing-tui-session" }
    }
  });
  adapter.handleHermesWsEvent({
    method: "event",
    params: {
      type: "reasoning.delta",
      payload: { session_id: "existing-tui-session", text: "planning" }
    }
  });
  adapter.handleHermesWsEvent({
    method: "event",
    params: {
      type: "message.complete",
      payload: { session_id: "existing-tui-session" }
    }
  });

  assert.equal(published.filter((event) => event.type === "task.created").length, 1);
  assert.equal(
    published.some((event) => event.type === "conversation.message.created" && event.payload.content === ""),
    false
  );
  assert.equal(published.some((event) => event.type === "task.progress" && event.payload.message === "planning"), true);
  assert.equal(published.filter((event) => event.type === "task.completed").length, 1);
  assert.equal(adapter.wsSessions.size, 0);
});
