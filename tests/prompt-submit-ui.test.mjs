import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const appSource = fs.readFileSync(new URL("../apps/web/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const cssSource = fs.readFileSync(new URL("../apps/web/styles.css", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("../apps/server/src/server.mjs", import.meta.url), "utf8");
const sendPromptBody = appSource.match(/async function sendPrompt\(button\) \{([\s\S]*?)\n\}\n\nfunction setPromptSendingState/)?.[1] || "";

test("prompt submit takes a synchronous lock before transport work", () => {
  assert.match(appSource, /promptSending: false/);
  assert.match(sendPromptBody, /if \(state\.promptSending\) return false;/);
  assert.ok(sendPromptBody.indexOf("state.promptSending = true") < sendPromptBody.indexOf("postJson"));
  assert.match(sendPromptBody, /state\.promptSending = false;/);
});

test("prompt UI acknowledges immediately and sends an idempotent request", () => {
  assert.ok(sendPromptBody.indexOf('el.promptInput.value = ""') < sendPromptBody.indexOf('postJson("/api/messages"'));
  assert.ok(sendPromptBody.indexOf("closePromptSheet()") < sendPromptBody.indexOf('postJson("/api/messages"'));
  assert.match(sendPromptBody, /asyncAck: true/);
  assert.match(sendPromptBody, /requestId/);
});

test("prompt failure restores the draft and reopens the composer", () => {
  assert.match(sendPromptBody, /el\.promptInput\.value = draft/);
  assert.match(sendPromptBody, /openPromptSheet\(\{ focus: true \}\)/);
});

test("runtime actions have a short post-response lock", () => {
  assert.match(appSource, /actionLocks: \{\}/);
  assert.match(appSource, /const actionKey = `\$\{source\}:\$\{action\}`/);
  assert.match(appSource, /state\.actionLocks\[actionKey\] = Date\.now\(\) \+ 600/);
});

test("late HTTP acknowledgement cannot overwrite a terminal stream", () => {
  assert.match(sendPromptBody, /completedBeforeAcknowledgement/);
  assert.match(appSource, /queueStreamRender\(\);\s*return existing;/);
});

test("server keeps async acknowledgement opt-in and deduplicated", () => {
  assert.match(serverSource, /if \(body\.asyncAck === true\)/);
  assert.match(serverSource, /acceptedMessageRequests\.get\(requestKey\)/);
  assert.match(serverSource, /writeJson\(response, 202, accepted\)/);
  assert.match(serverSource, /\.then\(\(\) => adapter\.sendMessage\(body\)\)/);
  assert.match(serverSource, /deliveryFailed: true/);
  assert.doesNotMatch(serverSource, /acceptedMessageRequests\.delete\(requestKey\)/);
});

test("sending state disables the prompt button", () => {
  assert.match(appSource, /button\.disabled = sending/);
  assert.match(cssSource, /\.prompt-run\.is-sending/);
  assert.match(cssSource, /pointer-events: none/);
});
