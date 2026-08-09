export class HermesWsError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "HermesWsError";
    this.beforeSend = Boolean(options.beforeSend);
    this.code = options.code || "websocket_error";
  }
}

export class HermesWsClient {
  constructor(config = {}, handlers = {}) {
    this.config = config;
    this.handlers = handlers;
    this.url = String(config.url || "").trim();
    this.ticket = String(config.ticket || "");
    this.token = String(config.token || "");
    this.authBaseUrl = trimSlash(String(config.authBaseUrl || deriveAuthBaseUrl(this.url)).trim());
    this.authProvider = String(config.authProvider || "basic").trim() || "basic";
    this.authUsername = String(config.authUsername || "").trim();
    this.authPassword = String(config.authPassword || "");
    this.canMintTicket = Boolean(this.authBaseUrl && this.authUsername && this.authPassword);
    this.singleUseTicket = Boolean(this.ticket || this.canMintTicket);
    this.needsFreshTicket = false;
    this.ticketRefreshPromise = undefined;
    this.requestTimeoutMs = positiveInteger(config.requestTimeoutMs, 15000);
    this.reconnectEnabled = config.reconnect !== false;
    this.reconnectBackoffMs = positiveInteger(config.reconnectBackoffMs, 1000);
    this.reconnectMaxBackoffMs = positiveInteger(config.reconnectMaxBackoffMs, 15000);
    this.reconnectDelayMs = this.reconnectBackoffMs;
    this.socket = undefined;
    this.connecting = undefined;
    this.reconnectTimer = undefined;
    this.closedByCaller = false;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
  }

  isConfigured() {
    return Boolean(this.url);
  }

  isConnected() {
    const open = globalThis.WebSocket?.OPEN ?? 1;
    return Boolean(this.socket && this.socket.readyState === open);
  }

  describe() {
    return {
      transport: "hermes-tui/websocket",
      url: this.redactedUrl(),
      configured: this.isConfigured(),
      connected: this.isConnected(),
      pendingRequests: this.pending.size,
      authMode: this.canMintTicket
        ? "password_login_ticket"
        : (this.singleUseTicket ? "single_use_ticket" : (this.token ? "token" : "none")),
      reconnectBlocked: (this.singleUseTicket && !this.canMintTicket) || (this.needsFreshTicket && !this.canMintTicket),
      needsFreshTicket: this.needsFreshTicket
    };
  }

  async connect() {
    if (!this.isConfigured()) {
      throw new HermesWsError("Hermes TUI WebSocket URL is not configured.", { beforeSend: true, code: "not_configured" });
    }
    if (this.needsFreshTicket && !this.canMintTicket) {
      throw new HermesWsError(
        "Hermes TUI WebSocket needs a fresh single-use ticket after the previous connection closed.",
        { beforeSend: true, code: "fresh_ticket_required" }
      );
    }
    if (this.isConnected()) return this.describe();
    if (this.connecting) return this.connecting;

    this.closedByCaller = false;
    this.connecting = Promise.resolve()
      .then(() => this.canMintTicket ? this.refreshTicket() : undefined)
      .then(() => {
        if (this.needsFreshTicket) {
          throw new HermesWsError(
            "Hermes TUI WebSocket needs a fresh single-use ticket after the previous connection closed.",
            { beforeSend: true, code: "fresh_ticket_required" }
          );
        }
        return new Promise((resolve, reject) => {
      const WebSocketImpl = globalThis.WebSocket;
      if (typeof WebSocketImpl !== "function") {
        reject(new HermesWsError("This Node runtime does not provide a WebSocket client.", {
          beforeSend: true,
          code: "websocket_unavailable"
        }));
        return;
      }

      let settled = false;
      let opened = false;
      let socket;
      try {
        socket = new WebSocketImpl(this.buildUrl());
        this.socket = socket;
      } catch (error) {
        reject(new HermesWsError(`Hermes TUI WebSocket could not open: ${error.message}`, {
          beforeSend: true,
          code: "connect_failed"
        }));
        return;
      }

      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        opened = true;
        this.needsFreshTicket = false;
        this.reconnectDelayMs = this.reconnectBackoffMs;
        resolve(this.describe());
      };
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const attach = (name, handler) => {
        if (typeof socket.addEventListener === "function") socket.addEventListener(name, handler);
        else socket[`on${name}`] = handler;
      };

      attach("open", resolveOnce);
      attach("message", (event) => this.handleMessage(event?.data ?? event));
      attach("error", (event) => {
        const error = new HermesWsError("Hermes TUI WebSocket transport error.", {
          beforeSend: !opened,
          code: "transport_error"
        });
        this.handlers.onError?.(error, event);
        rejectOnce(error);
      });
      attach("close", (event) => {
        const error = new HermesWsError(
          `Hermes TUI WebSocket closed (${event?.code ?? "unknown"}).`,
          { beforeSend: !opened, code: "closed" }
        );
        rejectOnce(error);
        if (this.socket === socket) this.socket = undefined;
        this.rejectPending(error);
        this.handlers.onClose?.(event);
        if (this.singleUseTicket && opened) this.needsFreshTicket = true;
        if (!this.closedByCaller) this.scheduleReconnect();
      });
        });
      }).finally(() => {
      this.connecting = undefined;
    });

    return this.connecting;
  }

  async refreshTicket() {
    if (!this.canMintTicket) {
      throw new HermesWsError("Hermes TUI ticket refresh is not configured.", {
        beforeSend: true,
        code: "ticket_refresh_not_configured"
      });
    }
    if (this.ticketRefreshPromise) return this.ticketRefreshPromise;

    this.ticketRefreshPromise = (async () => {
      let loginResponse;
      try {
        loginResponse = await fetch(`${this.authBaseUrl}/auth/password-login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: this.authProvider,
            username: this.authUsername,
            password: this.authPassword,
            next: "/"
          })
        });
      } catch (error) {
        throw new HermesWsError(`Hermes TUI authentication failed: ${error.message}`, {
          beforeSend: true,
          code: "ticket_auth_failed"
        });
      }
      if (!loginResponse.ok) {
        throw new HermesWsError(`Hermes TUI authentication failed (${loginResponse.status}).`, {
          beforeSend: true,
          code: "ticket_auth_failed"
        });
      }

      const cookie = cookieHeaderFromResponse(loginResponse);
      if (!cookie) {
        throw new HermesWsError("Hermes TUI authentication returned no session cookie.", {
          beforeSend: true,
          code: "ticket_auth_failed"
        });
      }

      let ticketResponse;
      try {
        ticketResponse = await fetch(`${this.authBaseUrl}/api/auth/ws-ticket`, {
          method: "POST",
          headers: { cookie }
        });
      } catch (error) {
        throw new HermesWsError(`Hermes TUI ticket request failed: ${error.message}`, {
          beforeSend: true,
          code: "ticket_request_failed"
        });
      }
      if (!ticketResponse.ok) {
        throw new HermesWsError(`Hermes TUI ticket request failed (${ticketResponse.status}).`, {
          beforeSend: true,
          code: "ticket_request_failed"
        });
      }

      let payload;
      try {
        payload = await ticketResponse.json();
      } catch {
        throw new HermesWsError("Hermes TUI ticket response was not valid JSON.", {
          beforeSend: true,
          code: "ticket_request_failed"
        });
      }
      const ticket = String(payload?.ticket || "").trim();
      if (!ticket) {
        throw new HermesWsError("Hermes TUI ticket response did not include a ticket.", {
          beforeSend: true,
          code: "ticket_request_failed"
        });
      }
      this.ticket = ticket;
      this.needsFreshTicket = false;
      return ticket;
    })().finally(() => {
      this.ticketRefreshPromise = undefined;
    });

    return this.ticketRefreshPromise;
  }

  async request(method, params = {}, options = {}) {
    try {
      await this.connect();
    } catch (error) {
      if (error instanceof HermesWsError) throw error;
      throw new HermesWsError(`Hermes TUI WebSocket connection failed: ${error.message}`, {
        beforeSend: true,
        code: "connect_failed"
      });
    }

    if (!this.isConnected()) {
      throw new HermesWsError("Hermes TUI WebSocket is not open.", { beforeSend: true, code: "not_open" });
    }

    const id = this.nextId++;
    const timeoutMs = positiveInteger(options.timeoutMs, this.requestTimeoutMs);
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, method, sent: false, timeout: undefined };
      pending.timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new HermesWsError(`Hermes TUI ${method} timed out after ${timeoutMs}ms.`, {
          beforeSend: !pending.sent,
          code: "request_timeout"
        }));
      }, timeoutMs);
      pending.timeout.unref?.();
      this.pending.set(id, pending);

      try {
        this.socket.send(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        pending.sent = true;
      } catch (error) {
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        reject(new HermesWsError(`Hermes TUI ${method} could not be sent: ${error.message}`, {
          beforeSend: true,
          code: "send_failed"
        }));
      }
    });
  }

  close() {
    this.closedByCaller = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const error = new HermesWsError("Hermes TUI WebSocket client closed.", { code: "closed_by_caller" });
    this.rejectPending(error);
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket?.close();
    } catch {
      // The socket may already be closed.
    }
  }

  buildUrl() {
    const parsed = new URL(this.url);
    if (this.ticket) {
      parsed.searchParams.set("ticket", this.ticket);
    } else if (this.token && !parsed.searchParams.has("ticket")) {
      // Legacy token auth remains available for non-gated/loopback gateways.
      parsed.searchParams.set("token", this.token);
    }
    return parsed.toString();
  }

  redactedUrl() {
    try {
      const parsed = new URL(this.url);
      parsed.searchParams.delete("token");
      parsed.searchParams.delete("ticket");
      return parsed.toString();
    } catch {
      return this.url ? "configured" : "";
    }
  }

  handleMessage(data) {
    if (data === undefined || data === null) return;
    if (typeof data !== "string") {
      if (data instanceof ArrayBuffer) data = new TextDecoder().decode(data);
      else if (typeof data.text === "function") {
        data.text().then((text) => this.handleMessage(text)).catch((error) => this.handlers.onError?.(error));
        return;
      } else data = String(data);
    }

    this.buffer += data;

    // Hermes sends one JSON-RPC object per WebSocket frame without requiring a
    // trailing newline. Keep newline support for streamed fixtures, but flush
    // a complete frame immediately so RPC responses do not wait for timeout.
    if (!this.buffer.includes("\n")) {
      const candidate = this.buffer.trim();
      if (!candidate) {
        this.buffer = "";
        return;
      }
      try {
        JSON.parse(candidate);
      } catch {
        return;
      }
      this.buffer = "";
      this.handleJsonLine(candidate);
      return;
    }

    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.handleJsonLine(line);
  }

  handleJsonLine(line) {
    const trimmed = String(line || "").trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.handlers.onProtocolError?.(`Hermes TUI emitted invalid JSON: ${trimmed.slice(0, 160)}`);
      return;
    }

    if (message?.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new HermesWsError(message.error.message || `${pending.method} failed`, {
          beforeSend: !pending.sent,
          code: "rpc_error"
        }));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message?.method) this.handlers.onEvent?.(message);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new HermesWsError(error.message, {
        beforeSend: !pending.sent,
        code: error.code || "closed"
      }));
    }
    this.pending.clear();
  }

  scheduleReconnect() {
    if (
      !this.reconnectEnabled
      || this.reconnectTimer
      || this.closedByCaller
      || !this.isConfigured()
      || (this.singleUseTicket && !this.canMintTicket)
      || (this.needsFreshTicket && !this.canMintTicket)
    ) return;
    const delayMs = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectMaxBackoffMs, Math.max(this.reconnectBackoffMs, delayMs * 2));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch((error) => {
        this.handlers.onError?.(error);
        this.scheduleReconnect();
      });
    }, delayMs);
    this.reconnectTimer.unref?.();
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function deriveAuthBaseUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return trimSlash(parsed.toString());
  } catch {
    return "";
  }
}

function cookieHeaderFromResponse(response) {
  const values = response.headers?.getSetCookie?.() ?? [];
  if (values.length) return values.map((value) => value.split(";")[0]).join("; ");
  const single = response.headers?.get?.("set-cookie") || "";
  return single
    .split(",")
    .map((value) => value.split(";")[0])
    .filter(Boolean)
    .join("; ");
}
