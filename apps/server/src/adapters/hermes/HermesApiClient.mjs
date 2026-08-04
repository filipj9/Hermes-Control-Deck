export class HermesApiClient {
  constructor(config) {
    this.baseUrl = config.baseUrl;
    this.apiPrefix = config.apiPrefix || "/api";
    this.password = config.password || "";
    this.timeoutMs = config.timeoutMs || 3500;
    this.streamTimeoutMs = Number.isFinite(config.streamTimeoutMs) ? config.streamTimeoutMs : 0;
    this.cookie = "";
    this.loggedIn = false;
  }

  async health() {
    return this.request("/health", { auth: false });
  }

  async authStatus() {
    return this.request(`${this.apiPrefix}/auth/status`, { auth: false });
  }

  async ensureLogin() {
    if (this.loggedIn) return;
    if (!this.password) {
      throw new Error("Hermes password missing. Set HERMES_PASSWORD in .env.");
    }

    const response = await this.fetchWithTimeout(`${this.baseUrl}${this.apiPrefix}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: this.password })
    });

    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      this.cookie = setCookie.split(",").map((part) => part.split(";")[0]).join("; ");
    }

    if (!response.ok) {
      const body = await safeBody(response);
      throw new Error(`Hermes login failed: ${response.status} ${body}`);
    }

    this.loggedIn = true;
  }

  async request(route, options = {}) {
    const auth = options.auth !== false;
    if (auth) await this.ensureLogin();

    const response = await this.fetchWithTimeout(`${this.baseUrl}${route}`, {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      timeoutMs: options.timeoutMs
    });

    if (response.status === 401 && auth) {
      this.loggedIn = false;
      this.cookie = "";
      await this.ensureLogin();
      return this.request(route, { ...options, auth: false });
    }

    if (!response.ok) {
      const body = await safeBody(response);
      throw new Error(`Hermes ${route} failed: ${response.status} ${body}`);
    }

    return parseResponse(response);
  }

  async firstJson(routes, options = {}) {
    const errors = [];

    for (const route of routes) {
      try {
        const data = await this.request(route, options);
        return { route, data };
      } catch (error) {
        errors.push(`${route}: ${error.message}`);
      }
    }

    throw new Error(errors.join(" | "));
  }

  async streamSse(route, onEvent) {
    await this.ensureLogin();

    const controller = this.streamTimeoutMs > 0 ? new AbortController() : undefined;
    const timeout = controller ? setTimeout(() => controller.abort(), this.streamTimeoutMs) : undefined;

    try {
      const response = await fetch(`${this.baseUrl}${route}`, {
        headers: {
          Accept: "text/event-stream",
          ...(this.cookie ? { Cookie: this.cookie } : {})
        },
        ...(controller ? { signal: controller.signal } : {})
      });

      if (!response.ok) {
        const body = await safeBody(response);
        throw new Error(`Hermes stream ${route} failed: ${response.status} ${body}`);
      }

      const reader = response.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const chunks = buffer.split(/\r?\n\r?\n/);
        buffer = chunks.pop() ?? "";

        for (const chunk of chunks) {
          const event = parseSseChunk(chunk);
          if (event) {
            await onEvent(event);
            if (event.event === "done" || event.event === "stream_end") return;
          }
        }
      }

      // Some Hermes WebUI versions close the stream with one final SSE frame
      // that is not followed by the blank delimiter. Do not drop that frame.
      buffer += decoder.decode();
      const finalEvent = parseSseChunk(buffer.trim());
      if (finalEvent) await onEvent(finalEvent);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);

    try {
      return await fetch(url, {
        ...withoutTimeoutOption(options),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function withoutTimeoutOption(options) {
  const copy = { ...options };
  delete copy.timeoutMs;
  return copy;
}

function parseSseChunk(chunk) {
  const lines = chunk.split(/\r?\n/);
  let event = "message";
  const data = [];

  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }

  if (!data.length) return null;

  const rawData = data.join("\n");
  let parsed = rawData;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    // Keep text payloads as-is.
  }

  return { event, data: parsed, raw: rawData };
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function safeBody(response) {
  try {
    const text = await response.text();
    return text.slice(0, 240);
  } catch {
    return "";
  }
}
