import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class CodexCliClient {
  constructor(config) {
    this.config = config;
    this.executable = resolveCodexExecutable(config.executable);
    this.workdir = path.resolve(config.workdir || process.cwd());
    this.children = new Map();
    this.versionCache = undefined;
  }

  isAvailable() {
    return isExecutableAvailable(this.executable);
  }

  async describeRuntime() {
    const available = this.isAvailable();
    const version = available ? await this.version() : undefined;
    return {
      available,
      executable: executableLabel(this.executable),
      version: version || "unknown",
      workdirConfigured: Boolean(this.config.workdir),
      workdirExists: fs.existsSync(this.workdir),
      sandbox: this.config.sandbox,
      approvalPolicy: this.config.approvalPolicy,
      activeRuns: this.children.size
    };
  }

  async version() {
    if (this.versionCache) return this.versionCache;
    if (!this.isAvailable()) return undefined;
    const output = await collectCommandOutput(this.executable, ["--version"], 3000);
    const match = `${output.stdout}\n${output.stderr}`.match(/\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/);
    this.versionCache = match?.[0];
    return this.versionCache;
  }

  start(prompt, options = {}) {
    if (!this.isAvailable()) throw new Error("Codex executable missing. Set CODEX_EXECUTABLE or add codex to PATH.");
    if (!fs.existsSync(this.workdir)) throw new Error(`Codex workdir does not exist: ${this.workdir}`);
    if (this.children.has(options.taskId)) throw new Error("Codex task already has an active process.");

    const args = this.buildArgs(options);
    const child = spawn(this.executable, args, {
      cwd: this.workdir,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: { ...process.env, FORCE_COLOR: "0" }
    });
    const state = { child, closed: false, timedOut: false, timer: undefined };
    this.children.set(options.taskId, state);
    child.stdin.end(prompt);

    let stdoutBuffer = "";
    let stderrBuffer = "";
    const emitStdout = (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) options.onEvent?.(parseJsonLine(trimmed));
      }
    };
    const emitStderr = (chunk) => {
      stderrBuffer += chunk.toString("utf8");
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) options.onStderr?.(trimmed);
      }
    };

    child.stdout.on("data", emitStdout);
    child.stderr.on("data", emitStderr);
    child.on("error", (error) => {
      if (state.closed) return;
      state.closed = true;
      clearTimeout(state.timer);
      this.children.delete(options.taskId);
      options.onError?.(error);
    });
    child.on("close", (code, signal) => {
      if (state.closed) return;
      state.closed = true;
      clearTimeout(state.timer);
      this.children.delete(options.taskId);
      if (stdoutBuffer.trim()) options.onEvent?.(parseJsonLine(stdoutBuffer.trim()));
      if (stderrBuffer.trim()) options.onStderr?.(stderrBuffer.trim());
      options.onExit?.({ code, signal, timedOut: state.timedOut });
    });

    const timeoutMs = Number(options.timeoutMs || this.config.runTimeoutMs || 0);
    if (timeoutMs > 0) {
      state.timer = setTimeout(() => {
        if (state.closed) return;
        state.timedOut = true;
        killProcessTree(child).finally(() => options.onTimeout?.({ timeoutMs, pid: child.pid }));
      }, timeoutMs);
      state.timer.unref?.();
    }

    return { pid: child.pid, args, startedAt: new Date().toISOString() };
  }

  async stop(taskId, timeoutMs = 5000) {
    const state = this.children.get(taskId);
    if (!state || state.closed) return false;
    await killProcessTree(state.child);
    return waitForClose(state.child, timeoutMs);
  }

  write(taskId, text) {
    const state = this.children.get(taskId);
    const stdin = state?.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
    stdin.write(text);
    return true;
  }

  buildArgs(options) {
    const args = [];
    if (this.config.workdir) args.push("-C", this.workdir);
    if (this.config.sandbox) args.push("--sandbox", this.config.sandbox);
    const approvalPolicy = options.approvalPolicy || this.config.approvalPolicy;
    if (approvalPolicy) args.push("--ask-for-approval", approvalPolicy);
    if (this.config.model) args.push("--model", this.config.model);
    if (this.config.profile && this.config.profile !== "default") args.push("--profile", this.config.profile);
    args.push("exec");
    if (options.resumeLast) args.push("resume", "--last");
    args.push("--json", "--skip-git-repo-check", "-");
    return args;
  }
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return { type: "stdout", message: line };
  }
}

function resolveCodexExecutable(configured) {
  if (configured) return configured;
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const discovered = newestCodexBinary(path.join(localAppData, "OpenAI", "Codex", "bin"));
  return discovered || "codex";
}

function newestCodexBinary(root) {
  if (!fs.existsSync(root)) return undefined;
  const candidates = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const executable = path.join(root, entry.name, "codex.exe");
    if (!fs.existsSync(executable)) continue;
    candidates.push({ executable, mtimeMs: fs.statSync(executable).mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.executable;
}

function isExecutableAvailable(executable) {
  if (!executable) return false;
  if (path.isAbsolute(executable) || executable.includes(path.sep)) return fs.existsSync(executable);
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  return spawnSync(lookup, [executable], { stdio: "ignore", windowsHide: true }).status === 0;
}

function executableLabel(executable) {
  if (!executable) return "missing";
  return path.basename(executable);
}

function collectCommandOutput(executable, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      killProcessTree(child).finally(() => resolve({ stdout, stderr, timedOut: true }));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); resolve({ stdout, stderr }); });
    child.on("close", () => { clearTimeout(timer); resolve({ stdout, stderr }); });
  });
}

function killProcessTree(child) {
  if (!child?.pid) return Promise.resolve();
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return Promise.resolve();
  }
  try { child.kill("SIGTERM"); } catch { /* already closed */ }
  return Promise.resolve();
}

function waitForClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(child.exitCode !== null || child.signalCode !== null), timeoutMs);
    child.once("close", () => finish(true));
    child.once("error", () => finish(false));
  });
}
