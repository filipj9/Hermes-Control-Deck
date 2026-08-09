import { CodexRuntimeAdapter } from "./CodexRuntimeAdapter.mjs";

export async function createCodexAdapter(config, eventBus, options = {}) {
  if (!config.experimentalDesktop?.enabled) {
    return new CodexRuntimeAdapter(config, eventBus);
  }

  const platform = options.platform || process.platform;
  if (platform !== "win32") {
    throw new Error("The experimental Codex Desktop bridge is Windows-only.");
  }

  const loadDesktop = options.loadDesktop || (() => import(
    "../../experimental/codex-desktop/ExperimentalCodexDesktopAdapter.mjs"
  ));
  const { ExperimentalCodexDesktopAdapter } = await loadDesktop();
  return new ExperimentalCodexDesktopAdapter(config, eventBus);
}
