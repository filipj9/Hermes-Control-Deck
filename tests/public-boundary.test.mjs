import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function textFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...textFiles(filePath));
    else if (/\.(mjs|js|json|md|yml|yaml|ps1|cmd|example)$/.test(entry.name)) files.push(filePath);
  }
  return files;
}

test("public copy excludes private bridge source files", () => {
  const forbiddenFiles = [
    "apps/server/src/adapters/codex/CodexDesktopBridge.mjs",
    "apps/server/src/adapters/codex/CodexApiClient.mjs",
    "apps/server/src/adapters/codex/CodexAppServerClient.mjs",
    "scripts/start-codex-desktop-bridge.ps1",
    "scripts/inspect-codex-desktop.mjs",
    "scripts/verify-codex-desktop-contracts.mjs"
  ];
  for (const relativePath of forbiddenFiles) assert.equal(fs.existsSync(path.join(root, relativePath)), false, relativePath);
});

test("public source has no private bridge imports or machine-specific network defaults", () => {
  const sourceRoots = [path.join(root, "apps"), path.join(root, "config"), path.join(root, "scripts")];
  const content = sourceRoots.flatMap((directory) => textFiles(directory)).map((filePath) => fs.readFileSync(filePath, "utf8")).join("\n");

  for (const forbidden of ["CodexDesktopBridge", "CodexApiClient", "CodexAppServerClient", "192.0.2.10", "198.51.100.20", "C:\\Users\\example"]) {
    assert.equal(content.includes(forbidden), false, forbidden);
  }
});

test("public copy ships a template environment only, never a live secret file", () => {
  assert.equal(fs.existsSync(path.join(root, ".env")), false);
  assert.equal(fs.existsSync(path.join(root, ".env.example")), true);
  assert.match(fs.readFileSync(path.join(root, ".env.example"), "utf8"), /CONTROL_AUTH_TOKEN=generate-a-long-random-token/);
});
