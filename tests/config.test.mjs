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
  "CONTROL_MAX_PROMPT_CHARS"
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
