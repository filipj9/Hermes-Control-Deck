import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { HermesRuntimeAdapter } from "../apps/server/src/adapters/hermes/HermesRuntimeAdapter.mjs";

test("authenticates, creates a session, starts chat and reconnects an active stream after EOF", async (t) => {
  const requests = [];
  let streamConnections = 0;
  let sessionProbes = 0;
  const server = await startMockServer(async (request, response, body) => {
    requests.push({ method: request.method, url: request.url, cookie: request.headers.cookie, body });

    if (request.url === "/api/auth/login") {
      assert.deepEqual(JSON.parse(body), { password: "test-password" });
      response.setHeader("Set-Cookie", "hermes_session=test-cookie; Path=/; HttpOnly");
      return json(response, 200, { ok: true });
    }
    assert.equal(request.headers.cookie, "hermes_session=test-cookie");

    if (request.url === "/api/session/new") {
      assert.deepEqual(JSON.parse(body), { profile: "default" });
      return json(response, 200, { session: { session_id: "session-eof" } });
    }
    if (request.url === "/api/chat/start") {
      assert.deepEqual(JSON.parse(body), {
        session_id: "session-eof",
        message: "hello Hermes",
        profile: "default"
      });
      return json(response, 200, { stream_id: "stream-eof" });
    }
    if (request.url === "/api/chat/stream?stream_id=stream-eof") {
      streamConnections += 1;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`event: token\ndata: {"text":"part-${streamConnections}"}\n\n`);
      return;
    }
    if (request.url === "/api/session?session_id=session-eof") {
      sessionProbes += 1;
      return json(response, 200, {
        session: {
          session_id: "session-eof",
          is_streaming: sessionProbes === 1,
          active_stream_id: sessionProbes === 1 ? "stream-eof" : null
        }
      });
    }
    json(response, 404, { error: "not found" });
  });
  t.after(() => server.close());

  const published = [];
  const adapter = createAdapter(server, published, {
    streamReconnectAttempts: 2,
    streamReconnectBackoffMs: 1
  });

  const result = await adapter.sendMessage({ content: "hello Hermes" });
  assert.equal(result.metadata.streamId, "stream-eof");
  await waitFor(() => published.some((event) => event.type === "task.completed"));

  assert.equal(streamConnections, 2);
  assert.equal(sessionProbes, 2);
  assert.equal(adapter.activeStreamId, undefined);
  assert.equal(published.filter((event) => event.type === "task.progress" && event.payload.status === "reconnecting").length, 1);
  assert.equal(published.filter((event) => event.type === "conversation.message.created" && event.payload.event === "token").length, 2);
  const terminal = published.filter((event) => ["task.completed", "task.failed", "runtime.error"].includes(event.type));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].payload.synthetic, true);
  assert.equal(terminal[0].payload.reason, "sse_eof_backend_inactive");
  assert.equal(requests.filter((entry) => entry.url === "/api/auth/login").length, 1);
});

test("does not reconnect or duplicate a terminal SSE event", async (t) => {
  let streamConnections = 0;
  let sessionProbes = 0;
  const server = await startMockServer(async (request, response) => {
    if (request.url === "/api/auth/login") {
      response.setHeader("Set-Cookie", "hermes_session=terminal-cookie; Path=/");
      return json(response, 200, { ok: true });
    }
    if (request.url === "/api/session/new") return json(response, 200, { session: { session_id: "session-done" } });
    if (request.url === "/api/chat/start") return json(response, 200, { stream_id: "stream-done" });
    if (request.url === "/api/chat/stream?stream_id=stream-done") {
      streamConnections += 1;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end("event: done\ndata: {\"ok\":true}\n\nevent: stream_end\ndata: {}\n\n");
      return;
    }
    if (request.url?.startsWith("/api/session?")) {
      sessionProbes += 1;
      return json(response, 200, { session: { is_streaming: false, active_stream_id: null } });
    }
    json(response, 404, { error: "not found" });
  });
  t.after(() => server.close());

  const published = [];
  const adapter = createAdapter(server, published, { streamReconnectBackoffMs: 1 });
  await adapter.sendMessage({ content: "finish once" });
  await waitFor(() => published.some((event) => event.type === "task.completed"));
  await sleep(25);

  assert.equal(streamConnections, 1);
  assert.equal(sessionProbes, 0);
  assert.equal(adapter.activeStreamId, undefined);
  assert.equal(published.filter((event) => event.type === "task.completed").length, 1);
});

test("stops reconnecting at the configured limit and emits one terminal error", async (t) => {
  let streamConnections = 0;
  let sessionProbes = 0;
  const server = await startMockServer(async (request, response) => {
    if (request.url === "/api/auth/login") {
      response.setHeader("Set-Cookie", "hermes_session=limit-cookie; Path=/");
      return json(response, 200, { ok: true });
    }
    if (request.url === "/api/session/new") return json(response, 200, { session: { session_id: "session-limit" } });
    if (request.url === "/api/chat/start") return json(response, 200, { stream_id: "stream-limit" });
    if (request.url === "/api/chat/stream?stream_id=stream-limit") {
      streamConnections += 1;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end();
      return;
    }
    if (request.url === "/api/session?session_id=session-limit") {
      sessionProbes += 1;
      return json(response, 200, {
        session: { is_streaming: true, active_stream_id: "stream-limit" }
      });
    }
    json(response, 404, { error: "not found" });
  });
  t.after(() => server.close());

  const published = [];
  const adapter = createAdapter(server, published, {
    streamReconnectAttempts: 1,
    streamReconnectBackoffMs: 1
  });
  await adapter.sendMessage({ content: "exhaust reconnects" });
  await waitFor(() => published.some((event) => event.type === "runtime.error"));

  assert.equal(streamConnections, 2);
  assert.equal(sessionProbes, 2);
  assert.equal(adapter.activeStreamId, undefined);
  assert.equal(published.filter((event) => event.type === "runtime.error").length, 1);
  assert.match(published.find((event) => event.type === "runtime.error").payload.error, /reconnect limit reached/);
});

test("captures a streamed approval with an id and resolves it through the deck decision path", async (t) => {
  let streamResponse;
  let approvalResponse;
  const server = await startMockServer(async (request, response, body) => {
    if (request.url === "/api/auth/login") {
      response.setHeader("Set-Cookie", "hermes_session=approval-cookie; Path=/");
      return json(response, 200, { ok: true });
    }
    if (request.url === "/api/session/new") return json(response, 200, { session: { session_id: "session-approval" } });
    if (request.url === "/api/chat/start") return json(response, 200, { stream_id: "stream-approval" });
    if (request.url === "/api/chat/stream?stream_id=stream-approval") {
      streamResponse = response;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('event: approval\ndata: {"command":"rm -f /tmp/test","description":"delete in root path"}\n\n');
      return;
    }
    if (request.url === "/api/approval/pending?session_id=session-approval") {
      return json(response, 200, {
        pending: {
          approval_id: "approval-stream",
          command: "rm -f /tmp/test",
          question: "Allow?"
        }
      });
    }
    if (request.url === "/api/approval/respond") {
      approvalResponse = JSON.parse(body);
      json(response, 200, { ok: true, choice: approvalResponse.choice });
      streamResponse?.end();
      return;
    }
    if (request.url === "/api/session?session_id=session-approval") {
      return json(response, 200, {
        session: {
          session_id: "session-approval",
          is_streaming: false,
          active_stream_id: null
        }
      });
    }
    if (request.url?.startsWith("/api/sessions")) return json(response, 200, { sessions: [] });
    json(response, 404, { error: "not found" });
  });
  t.after(() => {
    streamResponse?.end();
    server.close();
  });

  const published = [];
  const adapter = createAdapter(server, published);
  await adapter.sendMessage({ content: "trigger approval" });
  await waitFor(() => published.some((event) => event.type === "approval.requested" && event.payload.approvalId === "approval-stream"));

  const approvals = await adapter.listApprovals();
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].id, "approval-stream");
  assert.equal(approvals[0].metadata.streamId, "stream-approval");

  const result = await adapter.decideApproval({
    approvalId: "approval-stream",
    conversationId: "hermes:session-approval",
    decision: "approve",
    approvalScope: "once"
  });
  assert.equal(result.status, "approved");
  assert.deepEqual(approvalResponse, {
    session_id: "session-approval",
    approval_id: "approval-stream",
    choice: "once"
  });
  await waitFor(() => published.some((event) => event.type === "task.completed"));
  assert.equal(adapter.activeStreamId, undefined);
});

test("resolves a WebUI approval event without an id through the later legacy pending record", async (t) => {
  let streamResponse;
  let approvalResponse;
  let pendingChecks = 0;
  const server = await startMockServer(async (request, response, body) => {
    if (request.url === "/api/auth/login") {
      response.setHeader("Set-Cookie", "hermes_session=run-approval-cookie; Path=/");
      return json(response, 200, { ok: true });
    }
    if (request.url === "/api/session/new") return json(response, 200, { session: { session_id: "session-run-approval" } });
    if (request.url === "/api/chat/start") return json(response, 200, { stream_id: "stream-run-approval" });
    if (request.url === "/api/chat/stream?stream_id=stream-run-approval") {
      streamResponse = response;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('event: approval\ndata: {"command":"rm -f /tmp/run-test","description":"delete in root path"}\n\n');
      response.end();
      return;
    }
    if (request.url === "/api/approval/pending?session_id=session-run-approval") {
      pendingChecks += 1;
      return json(response, 200, pendingChecks === 1 ? { pending: null } : {
        pending: {
          approval_id: "approval-run-fallback",
          command: "rm -f /tmp/run-test",
          question: "Allow?"
        }
      });
    }
    if (request.url === "/api/approval/respond") {
      approvalResponse = { method: request.method, body: JSON.parse(body) };
      json(response, 200, { ok: true, choice: approvalResponse.body.choice });
      streamResponse?.end();
      return;
    }
    if (request.url === "/api/session?session_id=session-run-approval") {
      return json(response, 200, {
        session: { session_id: "session-run-approval", is_streaming: false, active_stream_id: null }
      });
    }
    if (request.url?.startsWith("/api/sessions")) return json(response, 200, { sessions: [] });
    json(response, 404, { error: "not found" });
  });
  t.after(() => {
    streamResponse?.end();
    server.close();
  });

  const published = [];
  const adapter = createAdapter(server, published);
  await adapter.sendMessage({ content: "trigger run approval" });
  await waitFor(() => published.some((event) => event.type === "approval.requested" && event.payload.approvalId === "hermes:run:stream-run-approval"));

  const captured = published.find((event) => event.type === "approval.requested").payload.approval;
  assert.equal(captured.metadata.approvalProtocol, "webui-stream");
  assert.equal(captured.metadata.responseRoute, undefined);
  const visibleApprovals = await adapter.listApprovals();
  assert.ok(visibleApprovals.some((approval) => approval.status === "pending"));

  const result = await adapter.decideApproval({
    approvalId: captured.id,
    conversationId: "hermes:session-run-approval",
    decision: "approve",
    approvalScope: "once"
  });
  assert.equal(result.status, "approved");
  assert.deepEqual(approvalResponse, {
    method: "POST",
    body: {
      session_id: "session-run-approval",
      approval_id: "approval-run-fallback",
      choice: "once"
    }
  });
  await waitFor(() => published.some((event) => event.type === "task.completed"));
  assert.equal(adapter.activeStreamId, undefined);
});

test("resolves an id-less WebUI approval through the session-scoped response contract", async (t) => {
  let streamResponse;
  let approvalResponse;
  const server = await startMockServer(async (request, response, body) => {
    if (request.url === "/api/auth/login") {
      response.setHeader("Set-Cookie", "hermes_session=session-only-cookie; Path=/");
      return json(response, 200, { ok: true });
    }
    if (request.url === "/api/session/new") return json(response, 200, { session: { session_id: "session-webui-no-id" } });
    if (request.url === "/api/chat/start") return json(response, 200, { stream_id: "stream-webui-no-id" });
    if (request.url === "/api/chat/stream?stream_id=stream-webui-no-id") {
      streamResponse = response;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('event: approval\ndata: {"command":"rm -f /tmp/session-only","description":"delete in root path"}\n\n');
      response.end();
      return;
    }
    if (request.url === "/api/approval/pending?session_id=session-webui-no-id") {
      return json(response, 200, { pending: null });
    }
    if (request.url === "/api/approval/respond") {
      approvalResponse = JSON.parse(body);
      return json(response, 200, { ok: true, choice: approvalResponse.choice });
    }
    if (request.url === "/api/session?session_id=session-webui-no-id") {
      return json(response, 200, {
        session: { session_id: "session-webui-no-id", is_streaming: false, active_stream_id: null }
      });
    }
    if (request.url?.startsWith("/api/sessions")) return json(response, 200, { sessions: [] });
    json(response, 404, { error: "not found" });
  });
  t.after(() => {
    streamResponse?.end();
    server.close();
  });

  const published = [];
  const adapter = createAdapter(server, published);
  await adapter.sendMessage({ content: "trigger session-only approval" });
  await waitFor(() => published.some((event) => event.type === "approval.requested"));

  const captured = published.find((event) => event.type === "approval.requested").payload.approval;
  assert.equal(captured.metadata.approvalProtocol, "webui-stream");
  const result = await adapter.decideApproval({
    approvalId: captured.id,
    conversationId: "hermes:session-webui-no-id",
    decision: "approve",
    approvalScope: "once"
  });

  assert.equal(result.status, "approved");
  assert.deepEqual(approvalResponse, {
    session_id: "session-webui-no-id",
    choice: "once"
  });
  await waitFor(() => published.some((event) => event.type === "task.completed"));
  assert.equal(adapter.activeStreamId, undefined);
});

test("STOP cancels the captured stream, clears status and does not emit a second terminal event", async (t) => {
  let openStreamResponse;
  const cancelled = [];
  const server = await startMockServer(async (request, response) => {
    if (request.url === "/api/auth/login") {
      response.setHeader("Set-Cookie", "hermes_session=cancel-cookie; Path=/");
      return json(response, 200, { ok: true });
    }
    if (request.url === "/api/session/new") return json(response, 200, { session: { session_id: "session-cancel" } });
    if (request.url === "/api/chat/start") return json(response, 200, { stream_id: "stream-cancel" });
    if (request.url === "/api/chat/stream?stream_id=stream-cancel") {
      openStreamResponse = response;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write("event: token\ndata: {\"text\":\"working\"}\n\n");
      return;
    }
    if (request.url === "/api/chat/cancel?stream_id=stream-cancel") {
      cancelled.push("stream-cancel");
      json(response, 200, { ok: true });
      openStreamResponse?.end();
      return;
    }
    json(response, 404, { error: "not found" });
  });
  t.after(() => {
    openStreamResponse?.end();
    server.close();
  });

  const published = [];
  const adapter = createAdapter(server, published, { streamReconnectBackoffMs: 1 });
  await adapter.sendMessage({ content: "cancel me" });
  await waitFor(() => Boolean(openStreamResponse));
  const staleStop = await adapter.cancelTask("hermes:stream:older-stream");
  assert.equal(staleStop.metadata.stale, true);
  assert.equal(adapter.activeStreamId, "stream-cancel");
  assert.deepEqual(cancelled, []);
  const stopped = await adapter.cancelTask("hermes:stream:stream-cancel");
  await sleep(25);

  assert.deepEqual(cancelled, ["stream-cancel"]);
  assert.equal(stopped.streamId, "stream-cancel");
  assert.equal(adapter.activeStreamId, undefined);
  const terminal = published.filter((event) => ["task.completed", "task.failed", "runtime.error"].includes(event.type));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].payload.status, "cancelled");
});

test("parses a terminal SSE frame even when the server closes without a blank delimiter", async (t) => {
  const server = await startMockServer(async (request, response) => {
    if (request.url === "/api/auth/login") {
      response.setHeader("Set-Cookie", "hermes_session=final-frame-cookie; Path=/");
      return json(response, 200, { ok: true });
    }
    if (request.url === "/api/session/new") return json(response, 200, { session: { session_id: "session-final-frame" } });
    if (request.url === "/api/chat/start") return json(response, 200, { stream_id: "stream-final-frame" });
    if (request.url === "/api/chat/stream?stream_id=stream-final-frame") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end("event: done\ndata: {\"ok\":true}");
      return;
    }
    json(response, 404, { error: "not found" });
  });
  t.after(() => server.close());

  const published = [];
  const adapter = createAdapter(server, published);
  await adapter.sendMessage({ content: "final frame" });
  await waitFor(() => published.some((event) => event.type === "task.completed"));

  assert.equal(published.filter((event) => event.type === "task.completed").length, 1);
  assert.equal(adapter.activeStreamId, undefined);
});

test("does not fall back to /chat after an ambiguous /chat/start transport failure", async () => {
  const adapter = new HermesRuntimeAdapter({
    apiPrefix: "/api",
    baseUrl: "http://127.0.0.1:1",
    profile: "default",
    timeoutMs: 1000
  }, { publish() {} }, { monitorExternalApprovals: false });
  const calls = [];
  adapter.client.request = async (route) => {
    calls.push(route);
    throw new Error("Hermes /api/chat/start failed: request timeout");
  };

  await assert.rejects(adapter.startHermesChat({ session_id: "s", message: "one", profile: "default" }), /timeout/);
  assert.deepEqual(calls, ["/api/chat/start"]);
});

test("explicit STOP can cancel an older tracked stream without touching the latest stream", async () => {
  const published = [];
  const adapter = new HermesRuntimeAdapter({
    apiPrefix: "/api",
    baseUrl: "http://127.0.0.1:1",
    profile: "default",
    timeoutMs: 1000
  }, { publish: (event) => published.push(event) }, { monitorExternalApprovals: false });
  const cancelled = [];
  adapter.client.request = async (route) => {
    cancelled.push(route);
    return { ok: true };
  };
  adapter.activeStreamId = "newer";
  adapter.streamStates.set("older", {
    streamId: "older",
    sessionId: "session-older",
    cancelRequested: false,
    terminalPublished: false
  });

  const result = await adapter.cancelTask("hermes:stream:older");

  assert.equal(result.streamId, "older");
  assert.equal(adapter.activeStreamId, "newer");
  assert.deepEqual(cancelled, ["/api/chat/cancel?stream_id=older"]);
  assert.equal(published.at(-1).payload.status, "cancelled");
});

function createAdapter(server, published, overrides = {}) {
  return new HermesRuntimeAdapter({
    apiPrefix: "/api",
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    password: "test-password",
    profile: "default",
    timeoutMs: 1000,
    streamTimeoutMs: 0,
    ...overrides
  }, { publish: (event) => published.push(event) }, {
    monitorExternalApprovals: false
  });
}

async function startMockServer(handler) {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      await handler(request, response, Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (!response.headersSent) json(response, 500, { error: error.message });
      else response.destroy(error);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error("Timed out waiting for mock Hermes state.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
