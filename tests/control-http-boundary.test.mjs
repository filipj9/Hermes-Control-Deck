import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sanitizePublicData } from "../apps/server/src/domain/publicData.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(root, "apps", "server", "src", "server.mjs");
const authToken = "test-control-token-that-is-longer-than-32-characters";

test("public data sanitizer removes raw transport data and nested credentials", () => {
  const sanitized = sanitizePublicData({
    content: "visible answer",
    publicKey: "safe-public-key",
    raw: "raw-frame",
    metadata: {
      HERMES_WS_TOKEN: "secret-token",
      password: "secret-password",
      nested: { cookie: "session=secret", output: "visible output" }
    }
  });

  assert.deepEqual(sanitized, {
    content: "visible answer",
    publicKey: "safe-public-key",
    metadata: { nested: { output: "visible output" } }
  });
});

test("HTTP control boundary rejects hostile hosts, origins and non-JSON mutations", { timeout: 15_000 }, async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: {
      ...process.env,
      CONTROL_SERVER_HOST: "127.0.0.1",
      CONTROL_SERVER_PORT: String(port),
      CONTROL_AUTH_TOKEN: authToken,
      CONTROL_TRUSTED_HOSTS: "deck.example.test",
      CONTROL_WEB_PUSH_ENABLED: "false",
      HERMES_ENABLED: "false",
      HERMES_WS_ENABLED: "false",
      HERMES_WS_URL: "",
      HERMES_TUI_RELAY_ENABLED: "false",
      HERMES_BRIDGE_ENABLED: "false",
      CODEX_ENABLED: "false",
      CODEX_EXPERIMENTAL_DESKTOP_ENABLED: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(() => child.kill("SIGTERM"));
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/healthz`, child, () => stderr);

  for (const fetchSite of [undefined, "same-origin"]) {
    const headers = { Host: "untrusted.example.test" };
    if (fetchSite) headers["Sec-Fetch-Site"] = fetchSite;
    assert.equal(await rawStatus(`${base}/healthz`, headers), 403,
      "An absent Origin must not bypass Host validation");
  }

  const trustedHeaders = { Authorization: `Bearer ${authToken}` };
  assert.equal((await fetch(`${base}/healthz`, { headers: trustedHeaders })).status, 200);

  for (const slash of ["%2f", "%5c"]) {
    const traversal = await fetch(`${base}/%2e%2e${slash}server${slash}src${slash}server.mjs`);
    assert.equal(traversal.status, 403);
    assert.doesNotMatch(await traversal.text(), /createCodexAdapter/);
  }

  const hostile = await fetch(`${base}/healthz`, {
    headers: { ...trustedHeaders, Origin: "https://attacker.invalid" }
  });
  assert.equal(hostile.status, 403);
  assert.equal(hostile.headers.get("access-control-allow-origin"), null);

  const hostilePreflight = await fetch(`${base}/api/actions`, {
    method: "OPTIONS",
    headers: { Origin: "https://attacker.invalid", "Access-Control-Request-Method": "POST" }
  });
  assert.equal(hostilePreflight.status, 403);

  const sameOrigin = await fetch(`${base}/healthz`, {
    headers: { ...trustedHeaders, Origin: base }
  });
  assert.equal(sameOrigin.status, 200);

  const proxiedTrustedOrigin = await fetch(`${base}/healthz`, {
    headers: {
      ...trustedHeaders,
      Host: `127.0.0.1:${port}`,
      Origin: "https://deck.example.test",
      "X-Forwarded-Host": "deck.example.test"
    }
  });
  assert.equal(proxiedTrustedOrigin.status, 200);

  const rebindingOrigin = await fetch(`${base}/healthz`, {
    headers: { ...trustedHeaders, Origin: "https://untrusted.example.test", Host: "untrusted.example.test" }
  });
  assert.equal(rebindingOrigin.status, 403);

  const nonJson = await fetch(`${base}/api/actions`, {
    method: "POST",
    headers: { ...trustedHeaders, Origin: base, "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ source: "hermes", action: "status" })
  });
  assert.equal(nonJson.status, 415);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function rawStatus(url, headers) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, response => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    }).on("error", reject);
  });
}

async function waitForServer(url, child, getStderr) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Test server exited early: ${getStderr()}`);
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${authToken}` } });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Test server did not start: ${getStderr()}`);
}
