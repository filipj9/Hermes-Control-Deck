import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../apps/web/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const styles = fs.readFileSync(new URL("../apps/web/styles.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} source not found`);
  return source.slice(start, end);
}

function readout({ model, reasoning, surface = "desktop" }) {
  const context = {
    state: {
      codexSurfaceMode: surface,
      runtimes: [{
        source: "codex",
        details: {
          model,
          reasoning,
          surfaces: {
            desktop: { model, reasoning },
            cli: { model, reasoning }
          }
        }
      }]
    },
    normalizeUiReasoning: (value) => value === "medium" ? "med" : value
  };
  vm.createContext(context);
  vm.runInContext(
    `${functionSource("codexModelReadout", "compactCodexModelName")}\n`
      + `${functionSource("compactCodexModelName", "renderVioletAgentConsole")}\n`
      + "result = codexModelReadout();",
    context
  );
  return context.result;
}

test("model indicator is compact, read-only text for the active Codex surface", () => {
  assert.equal(readout({ model: "GPT-6 Astra", reasoning: "high" }), "ASTRA · HIGH");
  assert.equal(readout({ model: "GPT-5.6 Luna", reasoning: "xhigh" }), "LUNA · XHIGH");
  assert.equal(readout({ model: "5.6 Sol", reasoning: "medium" }), "SOL · MED");
});

test("model indicator fails closed when the current model is unavailable", () => {
  assert.equal(readout({ model: "", reasoning: "high" }), "MODEL —");
  assert.equal(readout({ model: "configured default", reasoning: "high", surface: "cli" }), "MODEL —");
});

test("premium model indicator is display-only and remains readable on phones", () => {
  const render = functionSource("renderPremiumAgentConsole", "renderVioletHardwareDeck");
  assert.match(render, /data-codex-model-readout/);
  assert.match(render, /codexModelReadout\(\)/);
  assert.doesNotMatch(render, /data-action=["'](?:model|models|select-model)/);
  assert.match(styles, /small\[data-codex-model-readout="true"\][\s\S]*text-overflow:\s*clip/);
  assert.match(styles, /@media \(max-width:\s*699px\)[\s\S]*data-codex-model-readout/);
});
