import assert from "node:assert/strict";
import test from "node:test";

import { HermesTuiRelay } from "../apps/server/src/adapters/hermes/HermesTuiRelay.mjs";

function createFakeClient(id) {
  const writes = [];
  return {
    id,
    socket: {
      destroyed: false,
      write(value) {
        writes.push(Buffer.from(value));
      },
      end() {
        this.destroyed = true;
      },
      destroy() {
        this.destroyed = true;
      }
    },
    relayMaxMessageBytes: 1024 * 1024,
    closed: false,
    writes
  };
}

function createUpgradeSocket() {
  const writes = [];
  const handlers = new Map();
  return {
    destroyed: false,
    writes,
    on(event, handler) {
      handlers.set(event, handler);
    },
    setNoDelay() {},
    write(value) {
      writes.push(Buffer.isBuffer(value) ? Buffer.from(value) : String(value));
    },
    end() {
      this.destroyed = true;
    },
    destroy() {
      this.destroyed = true;
    },
    handlers
  };
}

function decodeServerTextFrame(buffer) {
  const first = buffer[0];
  assert.equal(first & 0x0f, 0x1);
  const second = buffer[1];
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  assert.equal(Boolean(second & 0x80), false);
  return JSON.parse(buffer.subarray(offset, offset + length).toString("utf8"));
}

function createRelay(requests) {
  const upstream = {
    isConnected: () => true,
    connect: async () => {},
    close: () => {},
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "session.resume") {
        return { session_id: "canonical-live-session", resumed: true };
      }
      if (method === "session.status") {
        return { session_id: params.session_id, status: "ready" };
      }
      if (method === "prompt.submit") return { accepted: true };
      throw new Error(`Unexpected upstream method: ${method}`);
    }
  };
  const relay = new HermesTuiRelay({
    enabled: true,
    token: "test-relay-token",
    upstream: { url: "ws://gateway.test/api/ws" }
  }, {
    upstreamFactory: () => upstream
  });
  return { relay, upstream };
}

test("keeps RPC responses private and broadcasts gateway events to every downstream client", async () => {
  const requests = [];
  const { relay } = createRelay(requests);
  const requester = createFakeClient(1);
  const observer = createFakeClient(2);
  relay.clients.add(requester);
  relay.clients.add(observer);

  await relay.forwardRequest(requester, {
    jsonrpc: "2.0",
    id: 7,
    method: "session.resume",
    params: { session_id: "durable-session" }
  });

  assert.deepEqual(requests[0], {
    method: "session.resume",
    params: { session_id: "durable-session" }
  });
  assert.equal(requester.writes.length, 1);
  assert.deepEqual(decodeServerTextFrame(requester.writes[0]), {
    jsonrpc: "2.0",
    id: 7,
    result: { session_id: "canonical-live-session", resumed: true }
  });
  assert.equal(observer.writes.length, 0);

  relay.broadcast({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "message.start", payload: { session_id: "canonical-live-session" } }
  });

  assert.equal(requester.writes.length, 2);
  assert.equal(observer.writes.length, 1);
  assert.equal(decodeServerTextFrame(observer.writes[0]).params.type, "message.start");
});

test("sends the TUI gateway.ready contract immediately after an authenticated upgrade", () => {
  const requests = [];
  const { relay } = createRelay(requests);
  const socket = createUpgradeSocket();

  relay.handleUpgrade({
    url: "/api/tui-relay?token=test-relay-token",
    headers: {
      host: "localhost",
      authorization: "",
      "sec-websocket-key": "test-key",
      "sec-websocket-version": "13"
    }
  }, socket, Buffer.alloc(0));

  assert.match(String(socket.writes[0]), /101 Switching Protocols/);
  const ready = decodeServerTextFrame(socket.writes[1]);
  assert.equal(ready.method, "event");
  assert.equal(ready.params.type, "gateway.ready");
  assert.deepEqual(ready.params.payload, {});
  assert.equal(socket.writes[1].at(-1), 10);
  relay.close();
});

test("maps a durable session alias to the canonical session for TUI requests", async () => {
  const requests = [];
  const { relay } = createRelay(requests);
  const client = createFakeClient(1);
  relay.clients.add(client);

  await relay.forwardRequest(client, {
    jsonrpc: "2.0",
    id: 1,
    method: "session.resume",
    params: { session_id: "durable-session" }
  });
  requests.length = 0;

  await relay.forwardRequest(client, {
    jsonrpc: "2.0",
    id: 2,
    method: "session.status",
    params: { session_id: "durable-session" }
  });
  await relay.forwardRequest(client, {
    jsonrpc: "2.0",
    id: 3,
    method: "prompt.submit",
    params: { session_id: "durable-session", text: "hello" }
  });

  assert.deepEqual(requests, [
    { method: "session.status", params: { session_id: "canonical-live-session" } },
    { method: "prompt.submit", params: { session_id: "canonical-live-session", text: "hello" } }
  ]);
});

test("keeps the durable session id for an explicit resume after alias mapping", async () => {
  const requests = [];
  const { relay } = createRelay(requests);
  const client = createFakeClient(1);
  relay.clients.add(client);

  await relay.forwardRequest(client, {
    jsonrpc: "2.0",
    id: 1,
    method: "session.resume",
    params: { session_id: "durable-session" }
  });
  await relay.forwardRequest(client, {
    jsonrpc: "2.0",
    id: 2,
    method: "session.resume",
    params: { session_id: "durable-session" }
  });

  assert.deepEqual(requests, [
    { method: "session.resume", params: { session_id: "durable-session" } },
    { method: "session.resume", params: { session_id: "durable-session" } }
  ]);
});

test("resumes the durable session after an upstream gateway reconnect", async () => {
  const requests = [];
  const { relay } = createRelay(requests);
  const client = createFakeClient(1);
  relay.clients.add(client);

  await relay.forwardRequest(client, {
    jsonrpc: "2.0",
    id: 1,
    method: "session.resume",
    params: { session_id: "durable-session" }
  });
  assert.equal(relay.trackedSessions.has("durable-session"), true);

  relay.handleUpstreamEvent({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "gateway.ready", payload: {} }
  });
  await relay.resumePromise;

  const resumeRequests = requests.filter((request) => request.method === "session.resume");
  assert.equal(resumeRequests.length, 2);
  assert.deepEqual(resumeRequests[1], {
    method: "session.resume",
    params: { session_id: "durable-session" }
  });
  assert.equal(
    decodeServerTextFrame(client.writes.at(-1)).params.type,
    "session.reconnected"
  );
});

test("bounds remembered session aliases without evicting the newest", () => {
  const relay = new HermesTuiRelay({
    enabled: true,
    token: "relay-test-token-32-characters-long",
    maxTrackedSessions: 2,
    upstream: { url: "ws://unused" }
  });

  relay.rememberTrackedSession("session-a", "canonical-a");
  relay.rememberTrackedSession("session-b", "canonical-b");
  relay.rememberTrackedSession("session-c", "canonical-c");

  assert.deepEqual([...relay.trackedSessions.keys()], ["session-b", "session-c"]);
});
