import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAuthToken, loadConfig } from "../apps/server/src/infrastructure/config.mjs";

const envKeys = [
  "HERMES_ENABLED",
  "HERMES_BASE_URL",
  "CODEX_ENABLED",
  "CODEX_WORKDIR",
  "CONTROL_AUTH_TOKEN",
  "CONTROL_MAX_BODY_BYTES",
  "CONTROL_MAX_PROMPT_CHARS",
  "HERMES_WS_ENABLED",
  "HERMES_WS_URL",
  "HERMES_TUI_RELAY_ENABLED",
  "HERMES_TUI_RELAY_TOKEN",
  "HERMES_TUI_RELAY_UPSTREAM_WS_URL",
  "HERMES_BRIDGE_ENABLED",
  "HERMES_BRIDGE_TOKEN",
  "HERMES_EXTERNAL_APPROVAL_MONITOR_ENABLED",
  "CODEX_EXPERIMENTAL_DESKTOP_ENABLED",
  "CODEX_EXPERIMENTAL_DESKTOP_CDP_HOST",
  "CODEX_EXPERIMENTAL_DESKTOP_CDP_PORT",
  "CODEX_EXPERIMENTAL_DESKTOP_REQUEST_TIMEOUT_MS",
  "CODEX_EXPERIMENTAL_DESKTOP_CODEX_HOME",
  "CODEX_EXPERIMENTAL_DESKTOP_STATE_FILE"
];

function withEnv(values, callback) {
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) {
    if (Object.hasOwn(values, key)) process.env[key] = values[key];
    else delete process.env[key];
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("CLI-first config is explicit and valid without private defaults", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-control-config-"));
  const config = withEnv({
    HERMES_ENABLED: "false",
    CODEX_ENABLED: "true",
    CODEX_WORKDIR: root,
    CONTROL_AUTH_TOKEN: "x".repeat(64)
  }, () => loadConfig(root));

  assert.equal(config.hermes.enabled, false);
  assert.equal(config.codex.mode, "cli");
  assert.equal(config.codex.surface, "cli");
  assert.equal(config.codex.workdir, root);
  assert.equal(config.server.maxBodyBytes, 262144);
  assert.equal(config.hermes.ws.enabled, false);
  assert.equal(config.hermes.relay.enabled, false);
  assert.equal(config.hermes.bridge.enabled, false);
  assert.equal(config.hermes.externalApprovalMonitorEnabled, false);
  assert.equal(config.codex.experimentalDesktop.enabled, false);
  assert.equal(config.codex.experimentalDesktop.cdpHost, "127.0.0.1");
});

test("experimental Desktop config rejects a non-loopback CDP endpoint", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-control-config-"));
  assert.throws(
    () => withEnv({
      HERMES_ENABLED: "false",
      CODEX_ENABLED: "true",
      CODEX_WORKDIR: root,
      CODEX_EXPERIMENTAL_DESKTOP_ENABLED: "true",
      CODEX_EXPERIMENTAL_DESKTOP_CDP_HOST: "0.0.0.0",
      CONTROL_AUTH_TOKEN: "x".repeat(64)
    }, () => loadConfig(root)),
    /loopback host/
  );
});

test("optional Hermes transports require explicit secrets and upstreams", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-control-config-"));
  assert.throws(
    () => withEnv({
      HERMES_ENABLED: "false",
      HERMES_TUI_RELAY_ENABLED: "true",
      HERMES_TUI_RELAY_TOKEN: "short",
      HERMES_TUI_RELAY_UPSTREAM_WS_URL: "ws://127.0.0.1:8791/api/ws",
      CODEX_ENABLED: "false",
      CODEX_WORKDIR: root,
      CONTROL_AUTH_TOKEN: "x".repeat(64)
    }, () => loadConfig(root)),
    /HERMES_TUI_RELAY_TOKEN/
  );
});

test("enabled Hermes requires an explicitly configured base URL", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-control-config-"));
  assert.throws(
    () => withEnv({
      HERMES_ENABLED: "true",
      HERMES_BASE_URL: "",
      CODEX_ENABLED: "false",
      CODEX_WORKDIR: root,
      CONTROL_AUTH_TOKEN: "x".repeat(64)
    }, () => loadConfig(root)),
    /HERMES_BASE_URL is required/
  );
});

test("generated auth tokens have sufficient entropy for local setup", () => {
  const token = createAuthToken();
  assert.match(token, /^[0-9a-f]{64}$/);
});
