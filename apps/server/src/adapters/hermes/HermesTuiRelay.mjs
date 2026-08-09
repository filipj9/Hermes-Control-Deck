import crypto from "node:crypto";
import { HermesWsClient } from "./HermesWsClient.mjs";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_PATH = "/api/tui-relay";
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const SESSION_SCOPED_METHODS = new Set([
  "session.status",
  "session.history",
  "session.interrupt",
  "prompt.cancel",
  "prompt.submit"
]);

/**
 * Keeps one upstream Hermes gateway transport and fans its events out to the
 * terminal TUI and the Control Deck. Hermes stores a single transport on each
 * live session, so two direct clients cannot safely share one session.
 */
export class HermesTuiRelay {
  constructor(config = {}, options = {}) {
    this.config = {
      enabled: Boolean(config.enabled),
      path: String(config.path || DEFAULT_PATH),
      token: String(config.token || ""),
      maxMessageBytes: positiveInteger(config.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES),
      maxTrackedSessions: positiveInteger(config.maxTrackedSessions, 50),
      requestTimeoutMs: positiveInteger(config.requestTimeoutMs, 15_000),
      upstream: { ...(config.upstream || {}) }
    };
    this.logger = options.logger || (() => {});
    this.upstreamFactory = options.upstreamFactory || ((upstreamConfig, handlers) => (
      new HermesWsClient(upstreamConfig, handlers)
    ));
    this.server = undefined;
    this.upstream = undefined;
    this.upstreamConnectPromise = undefined;
    this.clients = new Set();
    this.nextClientId = 1;
    this.started = false;
    this.closed = false;
    this.lastError = undefined;
    this.lastErrorAt = undefined;
    this.lastConnectedAt = undefined;
    this.needsSessionResume = false;
    this.resumePromise = undefined;
    this.trackedSessions = new Map();
    const configuredSessionId = String(this.config.upstream?.sessionId || "").trim();
    if (configuredSessionId) {
      this.rememberTrackedSession(configuredSessionId, configuredSessionId);
    }
    this.boundUpgradeHandler = (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    };
  }

  attach(server) {
    if (!this.config.enabled) return false;
    if (this.server) return true;
    this.server = server;
    this.closed = false;
    this.started = true;
    server.on("upgrade", this.boundUpgradeHandler);
    return true;
  }

  close() {
    this.closed = true;
    this.started = false;
    if (this.server) this.server.off("upgrade", this.boundUpgradeHandler);
    this.server = undefined;
    for (const client of [...this.clients]) this.closeClient(client, 1001, "relay stopping");
    this.clients.clear();
    this.upstream?.close?.();
    this.upstream = undefined;
    this.upstreamConnectPromise = undefined;
    this.resumePromise = undefined;
    this.trackedSessions.clear();
  }

  health() {
    return {
      enabled: this.config.enabled,
      configured: Boolean(this.config.token && this.config.upstream?.url),
      path: this.config.path,
      started: this.started,
      clients: this.clients.size,
      upstreamConnected: Boolean(this.upstream?.isConnected?.()),
      lastConnectedAt: this.lastConnectedAt || null,
      lastError: this.lastError || null,
      lastErrorAt: this.lastErrorAt || null
    };
  }

  async ensureUpstream() {
    if (this.closed) throw new Error("Hermes TUI relay is closed.");
    if (!this.upstream) {
      this.upstream = this.upstreamFactory(this.config.upstream, {
        onEvent: (message) => this.handleUpstreamEvent(message),
        onError: (error) => this.recordUpstreamError(error),
        onClose: (event) => {
          this.needsSessionResume = true;
          this.broadcastGatewayEvent("gateway.disconnected", {
            code: event?.code ?? null,
            reason: event?.reason || ""
          });
        }
      });
    }
    if (this.upstream.isConnected?.()) return this.upstream;
    if (!this.upstreamConnectPromise) {
      this.upstreamConnectPromise = Promise.resolve()
        .then(() => this.upstream.connect())
        .then(() => {
          this.lastConnectedAt = new Date().toISOString();
          this.lastError = undefined;
          this.lastErrorAt = undefined;
          return this.upstream;
        })
        .finally(() => {
          this.upstreamConnectPromise = undefined;
        });
    }
    await this.upstreamConnectPromise;
    return this.upstream;
  }

  handleUpgrade(request, socket, head) {
    let requestUrl;
    try {
      requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (requestUrl.pathname !== this.config.path) return;
    if (!tokenMatches(this.config.token, relayTokenFromRequest(request, requestUrl))) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    const key = String(request.headers["sec-websocket-key"] || "");
    const version = String(request.headers["sec-websocket-version"] || "");
    if (!key || version !== "13") {
      rejectUpgrade(socket, 400, "Unsupported WebSocket request");
      return;
    }

    const accept = crypto.createHash("sha1")
      .update(`${key}${WEBSOCKET_GUID}`)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n"
    ].join("\r\n"));
    socket.setNoDelay?.(true);

    const client = {
      id: this.nextClientId++,
      socket,
      buffer: Buffer.alloc(0),
      relayMaxMessageBytes: this.config.maxMessageBytes,
      fragments: undefined,
      closed: false
    };
    this.clients.add(client);
    socket.on("data", (chunk) => this.handleClientData(client, chunk));
    socket.on("error", (error) => this.recordClientError(client, error));
    socket.on("close", () => this.removeClient(client));
    socket.on("end", () => this.removeClient(client));
    if (head?.length) this.handleClientData(client, head);

    // Hermes TUI waits for this notification before it sends session.resume.
    // Send it before the upstream connection completes so a remote relay does
    // not make the terminal time out during gateway authentication.
    this.writeJson(client, {
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "gateway.ready",
        payload: {}
      }
    });

    // Connect lazily, but immediately after the client handshake so the TUI
    // does not race the first session.resume/prompt.submit request.
    this.ensureUpstream().catch((error) => this.recordUpstreamError(error));
  }

  handleClientData(client, chunk) {
    if (client.closed) return;
    client.buffer = Buffer.concat([client.buffer, Buffer.from(chunk)]);
    if (client.buffer.length > this.config.maxMessageBytes * 2) {
      this.closeClient(client, 1009, "message too large");
      return;
    }

    while (!client.closed) {
      const frame = readFrame(client);
      if (frame.incomplete) return;
      if (frame.error) {
        this.closeClient(client, frame.error.code, frame.error.reason);
        return;
      }
      client.buffer = frame.remaining;
      if (frame.opcode === 0x8) {
        this.closeClient(client, 1000, "");
        return;
      }
      if (frame.opcode === 0x9) {
        this.writeFrame(client, 0xA, frame.payload);
        continue;
      }
      if (frame.opcode === 0xA) continue;
      if (frame.opcode === 0x2) {
        this.closeClient(client, 1003, "binary messages are not supported");
        return;
      }
      this.handleTextFrame(client, frame);
    }
  }

  handleTextFrame(client, frame) {
    let text;
    if (frame.opcode === 0x1) {
      if (frame.fin) {
        text = frame.payload.toString("utf8");
      } else {
        client.fragments = [frame.payload];
        return;
      }
    } else if (frame.opcode === 0x0) {
      if (!client.fragments) {
        this.closeClient(client, 1002, "unexpected continuation frame");
        return;
      }
      client.fragments.push(frame.payload);
      if (!frame.fin) return;
      text = Buffer.concat(client.fragments).toString("utf8");
      client.fragments = undefined;
    } else {
      return;
    }
    if (Buffer.byteLength(text, "utf8") > this.config.maxMessageBytes) {
      this.closeClient(client, 1009, "message too large");
      return;
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.writeJson(client, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Invalid JSON" }
      });
      return;
    }
    if (!message || typeof message !== "object" || typeof message.method !== "string") {
      this.writeJson(client, {
        jsonrpc: "2.0",
        id: message?.id ?? null,
        error: { code: -32600, message: "Invalid JSON-RPC request" }
      });
      return;
    }
    this.forwardRequest(client, message).catch((error) => {
      this.recordClientError(client, error);
      if (message.id !== undefined) {
        this.writeJson(client, {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: safeErrorMessage(error) }
        });
      }
    });
  }

  async forwardRequest(client, message) {
    const upstream = await this.ensureUpstream();
    const upstreamMessage = this.normalizeSessionRequest(message);
    const result = await upstream.request(upstreamMessage.method, upstreamMessage.params || {}, {
      timeoutMs: this.config.requestTimeoutMs
    });
    this.trackSession(message, result);
    if (message.id !== undefined) {
      this.writeJson(client, { jsonrpc: "2.0", id: message.id, result });
    }
  }

  handleUpstreamEvent(message) {
    if (message?.method === "event" && message?.params?.type === "gateway.ready") {
      this.resumeTrackedSessions().catch((error) => this.recordUpstreamError(error));
    }
    this.broadcast(message);
  }

  trackSession(message, result) {
    if (!message || !result || typeof result !== "object") return;
    const params = message.params && typeof message.params === "object" ? message.params : {};
    const canonical = String(
      result.session_id
      || result.sessionId
      || params.session_id
      || ""
    ).trim();
    if (!canonical) return;

    const target = String(
      result.session_key
      || (typeof result.resumed === "string" ? result.resumed : "")
      || result.stored_session_id
      || params.session_id
      || canonical
    ).trim();
    if (!target) return;
    this.rememberTrackedSession(target, canonical);
  }

  rememberTrackedSession(target, canonical) {
    this.trackedSessions.delete(target);
    this.trackedSessions.set(target, { target, canonical });
    while (this.trackedSessions.size > this.config.maxTrackedSessions) {
      const oldest = this.trackedSessions.keys().next().value;
      if (!oldest) break;
      this.trackedSessions.delete(oldest);
    }
  }

  async resumeTrackedSessions() {
    if (!this.upstream || !this.trackedSessions.size) {
      this.needsSessionResume = false;
      return;
    }
    if (this.resumePromise) return this.resumePromise;
    this.resumePromise = (async () => {
      for (const entry of [...this.trackedSessions.values()]) {
        try {
          const result = await this.upstream.request("session.resume", {
            // Hermes expects the durable session key for resume. The result
            // may expose a separate canonical runtime id used by live turns.
            session_id: entry.target
          }, { timeoutMs: this.config.requestTimeoutMs });
          const canonical = String(result?.session_id || entry.canonical || "").trim();
          if (canonical) this.trackedSessions.set(entry.target, { ...entry, canonical });
          this.broadcastGatewayEvent("session.reconnected", {
            session_id: canonical || entry.canonical,
            session_key: entry.target
          });
        } catch (error) {
          this.recordUpstreamError(error);
          this.broadcastGatewayEvent("session.reconnect_failed", {
            session_id: entry.canonical,
            session_key: entry.target,
            error: safeErrorMessage(error)
          });
        }
      }
      this.needsSessionResume = false;
    })().finally(() => {
      this.resumePromise = undefined;
    });
    return this.resumePromise;
  }

  normalizeSessionRequest(message) {
    if (!message || !SESSION_SCOPED_METHODS.has(message.method)) return message;
    const params = message.params && typeof message.params === "object" ? message.params : {};
    const requested = String(params.session_id || params.sessionId || "").trim();
    if (!requested) return message;
    const resolved = this.resolveSessionId(requested);
    if (!resolved || resolved === requested) return message;
    const nextParams = { ...params, session_id: resolved };
    delete nextParams.sessionId;
    return { ...message, params: nextParams };
  }

  resolveSessionId(sessionId) {
    const requested = String(sessionId || "").trim();
    if (!requested) return requested;
    const direct = this.trackedSessions.get(requested);
    if (direct?.canonical && direct.canonical !== requested) return direct.canonical;
    for (const entry of this.trackedSessions.values()) {
      if (entry?.target === requested && entry.canonical && entry.canonical !== requested) {
        return entry.canonical;
      }
    }
    return requested;
  }

  broadcast(message) {
    if (!message || typeof message !== "object") return;
    for (const client of [...this.clients]) this.writeJson(client, message);
  }

  broadcastGatewayEvent(type, payload = {}) {
    this.broadcast({
      jsonrpc: "2.0",
      method: "event",
      params: { type, payload }
    });
  }

  writeJson(client, value) {
    try {
      // Hermes TUI consumes newline-delimited JSON-RPC, including messages
      // sent over WebSocket frames. The Deck client also accepts this form.
      this.writeFrame(client, 0x1, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
    } catch (error) {
      this.recordClientError(client, error);
      this.removeClient(client);
    }
  }

  writeFrame(client, opcode, payload) {
    if (client.closed || !client.socket || client.socket.destroyed) return;
    const body = Buffer.from(payload || "");
    let header;
    if (body.length < 126) {
      header = Buffer.from([0x80 | opcode, body.length]);
    } else if (body.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(body.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(body.length), 2);
    }
    client.socket.write(Buffer.concat([header, body]));
  }

  closeClient(client, code = 1000, reason = "") {
    if (client.closed) return;
    client.closed = true;
    this.clients.delete(client);
    try {
      const reasonBuffer = Buffer.from(String(reason).slice(0, 120), "utf8");
      const payload = Buffer.alloc(2 + reasonBuffer.length);
      payload.writeUInt16BE(code, 0);
      reasonBuffer.copy(payload, 2);
      this.writeFrame({ ...client, closed: false }, 0x8, payload);
    } catch {
      // The socket may already be gone.
    }
    try {
      client.socket.end();
    } catch {
      client.socket.destroy?.();
    }
  }

  removeClient(client) {
    if (client.closed) {
      this.clients.delete(client);
      return;
    }
    client.closed = true;
    this.clients.delete(client);
  }

  recordClientError(client, error) {
    this.logger("warning", `TUI relay client ${client?.id || "unknown"}: ${safeErrorMessage(error)}`);
  }

  recordUpstreamError(error) {
    this.lastError = safeErrorMessage(error);
    this.lastErrorAt = new Date().toISOString();
    this.logger("warning", `TUI relay upstream: ${this.lastError}`);
    this.broadcastGatewayEvent("gateway.error", { error: this.lastError });
  }
}

function readFrame(client) {
  const buffer = client.buffer;
  if (buffer.length < 2) return { incomplete: true };
  const first = buffer[0];
  const second = buffer[1];
  const fin = Boolean(first & 0x80);
  const rsv = first & 0x70;
  const opcode = first & 0x0f;
  const masked = Boolean(second & 0x80);
  let length = second & 0x7f;
  let offset = 2;
  if (rsv || !masked) return { error: { code: 1002, reason: "invalid WebSocket frame" } };
  if (length === 126) {
    if (buffer.length < offset + 2) return { incomplete: true };
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return { incomplete: true };
    const large = buffer.readBigUInt64BE(offset);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
      return { error: { code: 1009, reason: "message too large" } };
    }
    length = Number(large);
    offset += 8;
  }
  if (length > client.relayMaxMessageBytes && client.relayMaxMessageBytes) {
    return { error: { code: 1009, reason: "message too large" } };
  }
  if (buffer.length < offset + 4 + length) return { incomplete: true };
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return { fin, opcode, payload, remaining: buffer.subarray(offset + length) };
}

function relayTokenFromRequest(request, requestUrl) {
  const header = String(request.headers["x-hermes-tui-relay-token"] || "").trim();
  if (header) return header;
  const authorization = String(request.headers.authorization || "");
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  return String(requestUrl.searchParams.get("token") || requestUrl.searchParams.get("relay_token") || "");
}

function tokenMatches(expected, actual) {
  if (!expected || !actual) return false;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  return expectedBuffer.length === actualBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function rejectUpgrade(socket, status, message) {
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } finally {
    socket.destroy();
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeErrorMessage(error) {
  return String(error?.message || error || "Unknown relay error").slice(0, 300);
}
