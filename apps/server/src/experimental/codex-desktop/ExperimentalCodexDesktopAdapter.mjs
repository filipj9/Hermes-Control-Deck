import { CodexRuntimeAdapter } from "./CodexRuntimeAdapter.mjs";

export class ExperimentalCodexDesktopAdapter extends CodexRuntimeAdapter {
  constructor(config, eventBus) {
    const desktop = config.experimentalDesktop;
    super({
      ...config,
      mode: "desktop",
      surface: "desktop",
      desktopEnabled: true,
      desktopAppServerEnabled: false,
      desktopCdpHost: desktop.cdpHost,
      desktopCdpPort: desktop.cdpPort,
      desktopBridgeStateFile: desktop.stateFile,
      desktopBridgeRequestTimeoutMs: desktop.requestTimeoutMs,
      codexHome: desktop.codexHome || undefined,
      sqliteHome: desktop.codexHome || undefined
    }, eventBus);
  }

  async health() {
    const health = await super.health("desktop");
    return {
      ...health,
      details: {
        ...health.details,
        surface: "desktop",
        experimental: true,
        support: "unofficial-unsupported"
      }
    };
  }

  async startTask(input = {}) {
    return super.startTask({ ...input, surface: "desktop" });
  }

  async sendMessage(input = {}) {
    return super.sendMessage({ ...input, surface: "desktop" });
  }

  async cancelTask(taskId) {
    return super.runAction("stop", { taskId, surface: "desktop" });
  }

  async decideApproval(input = {}) {
    return super.decideApproval({ ...input, surface: "desktop" });
  }

  async runAction(action, payload = {}) {
    return super.runAction(action, { ...payload, surface: "desktop" });
  }
}
