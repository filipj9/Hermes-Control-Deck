import { createEvent } from "../domain/events.mjs";

export class EventBus {
  constructor() {
    this.events = [];
    this.clients = new Set();
    this.retentionMs = 15 * 60 * 1000;
    this.maxEvents = 300;
  }

  publish(input) {
    const event = createEvent(input);
    if (shouldKeepInHistory(event)) {
      this.events.unshift(event);
      this.pruneHistory();
    }

    const serialized = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(serialized);
      } catch {
        this.clients.delete(client);
      }
    }

    return event;
  }

  list(limit = 100, options = {}) {
    this.pruneHistory();
    const maxAgeMs = options.maxAgeMs ?? this.retentionMs;
    const since = Date.now() - maxAgeMs;
    return this.events
      .filter((event) => Date.parse(event.timestamp) >= since)
      .slice(0, limit);
  }

  attach(response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    response.write(": codex-control stream\n\n");
    this.clients.add(response);

    for (const event of this.list(25).reverse()) {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }

    const heartbeat = setInterval(() => {
      response.write(": keepalive\n\n");
    }, 25000);

    response.on("close", () => {
      clearInterval(heartbeat);
      this.clients.delete(response);
    });
  }

  pruneHistory() {
    const since = Date.now() - this.retentionMs;
    this.events = this.events
      .filter((event) => Date.parse(event.timestamp) >= since)
      .slice(0, this.maxEvents);
  }
}

function shouldKeepInHistory(event) {
  const streamEvent = event.payload?.event;
  if (event.type === "conversation.message.created" && streamEvent === "token") return false;
  if (event.type === "task.progress" && streamEvent === "metering") return false;
  if (streamEvent === "reasoning" || streamEvent === "thinking" || streamEvent === "trace") return false;
  return true;
}
