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

test("CLI-first core excludes Desktop bridge source files", () => {
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

test("CLI-first core has no Desktop bridge imports", () => {
  const sourceRoots = [path.join(root, "apps"), path.join(root, "config"), path.join(root, "scripts")];
  const content = sourceRoots
    .flatMap((directory) => textFiles(directory))
    .filter((filePath) => !filePath.includes(`${path.sep}experimental${path.sep}codex-desktop${path.sep}`))
    .filter((filePath) => !filePath.endsWith(`${path.sep}createCodexAdapter.mjs`))
    .map((filePath) => fs.readFileSync(filePath, "utf8"))
    .join("\n");

  for (const forbidden of ["CodexDesktopBridge", "CodexApiClient", "CodexAppServerClient"]) {
    assert.equal(content.includes(forbidden), false, forbidden);
  }
});

test("experimental Desktop bridge stays quarantined and has no machine-specific defaults", () => {
  const experimentalRoot = path.join(root, "apps", "server", "src", "experimental", "codex-desktop");
  assert.equal(fs.existsSync(experimentalRoot), true);
  const content = textFiles(experimentalRoot).map((filePath) => fs.readFileSync(filePath, "utf8")).join("\n");
  assert.doesNotMatch(content, /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[0-1])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/);
  assert.doesNotMatch(content, /[A-Z]:\\Users\\[^\\\r\n]+/i);
  assert.doesNotMatch(content, /Stop-Process|taskkill|start-codex-desktop-bridge/i);
  assert.doesNotMatch(content, /\bspawn\s*\(|\b(?:child|process)\.kill\s*\(/i);
});

test("public copy ships a template environment only, never a live secret file", () => {
  assert.equal(fs.existsSync(path.join(root, ".env")), false);
  assert.equal(fs.existsSync(path.join(root, ".env.example")), true);
  assert.match(fs.readFileSync(path.join(root, ".env.example"), "utf8"), /CONTROL_AUTH_TOKEN=generate-a-long-random-token/);
});
