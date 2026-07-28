import assert from "node:assert/strict";
import test from "node:test";
import { EventBus } from "../apps/server/src/infrastructure/EventBus.mjs";

test("EventBus keeps unified events newest-first and suppresses noisy stream fragments", () => {
  const bus = new EventBus();
  bus.publish({ source: "hermes", type: "task.created", taskId: "h-1", payload: { title: "one" } });
  bus.publish({ source: "codex", type: "conversation.message.created", taskId: "c-1", payload: { event: "token", text: "fragment" } });
  bus.publish({ source: "codex", type: "task.completed", taskId: "c-1", payload: { status: "completed" } });

  const events = bus.list(10);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "task.completed");
  assert.equal(events[1].source, "hermes");
  assert.ok(events.every((event) => event.source === "hermes" || event.source === "codex"));
});

test("EventBus writes SSE frames to attached clients", () => {
  const bus = new EventBus();
  const writes = [];
  const response = {
    writeHead(status, headers) {
      assert.equal(status, 200);
      assert.equal(headers["Content-Type"], "text/event-stream");
    },
    write(value) { writes.push(value); },
    on(name, handler) {
      assert.equal(name, "close");
      this.closeHandler = handler;
    }
  };

  bus.attach(response);
  bus.publish({ source: "codex", type: "runtime.connected", payload: { mode: "cli" } });
  response.closeHandler?.();

  assert.ok(writes.some((value) => value.includes("event: runtime.connected")));
});
