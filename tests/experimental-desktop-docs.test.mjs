import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const guide = fs.readFileSync(
  new URL("../docs/EXPERIMENTAL_CODEX_DESKTOP.md", import.meta.url),
  "utf8"
);
const compatibility = fs.readFileSync(
  new URL("../COMPATIBILITY.md", import.meta.url),
  "utf8"
);

test("experimental Desktop guide uses package activation without terminating Codex", () => {
  assert.match(guide, /Get-AppxPackage -Name "OpenAI\.Codex"/);
  assert.match(guide, /IApplicationActivationManager/);
  assert.match(guide, /\[PreserveSig\][\s\S]*ActivateApplication/);
  assert.match(guide, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(guide, /--remote-debugging-port=4248/);
  assert.doesNotMatch(guide, /Stop-Process|taskkill(?:\.exe)?/i);
  assert.doesNotMatch(guide, /discovers its executable|pauses and asks you to exit/i);
});

test("experimental Desktop documentation records current fixtures without claiming stable support", () => {
  assert.match(guide, /26\.1016\.6573\.0/);
  assert.match(guide, /replacement STOP\s+control/);
  assert.match(guide, /tested snapshot, not a compatibility guarantee/i);
  assert.match(compatibility, /26\.1016\.6573\.0/);
  assert.match(compatibility, /physical E2E is still required after every update/i);
});
