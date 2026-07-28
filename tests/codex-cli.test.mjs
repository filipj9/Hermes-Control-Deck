import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import { CodexCliClient } from "../apps/server/src/adapters/codex/CodexCliClient.mjs";

function createConfig() {
  return {
    executable: process.execPath,
    workdir: process.cwd(),
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    profile: "default",
    model: "",
    runTimeoutMs: 1000
  };
}

test("Codex CLI arguments use stdin JSON execution and never launch an app surface", () => {
  const client = new CodexCliClient(createConfig());
  const args = client.buildArgs({ resumeLast: true });

  assert.deepEqual(args.slice(-6), ["exec", "resume", "--last", "--json", "--skip-git-repo-check", "-"]);
  assert.ok(args.includes("--sandbox"));
  assert.ok(!args.includes("app"));
  assert.ok(!args.some((arg) => String(arg).toLowerCase().includes("cdp")));
});

test("Codex CLI runtime discovery reports an absolute executable and existing workdir", async () => {
  const client = new CodexCliClient(createConfig());
  const runtime = await client.describeRuntime();

  assert.equal(runtime.available, true);
  assert.equal(runtime.workdirExists, true);
  assert.equal(runtime.executable, "node.exe");
  assert.match(runtime.version, /\d+\.\d+/);
});
