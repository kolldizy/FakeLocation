/**
 * Bridge supervisor: owns the Python child process and the JSON-RPC channel.
 *
 * Responsibilities
 *  - find a Python interpreter that can import pymobiledevice3;
 *  - keep exactly one bridge process alive, with bounded restart on crash;
 *  - correlate request/response by id and enforce per-method timeouts;
 *  - forward one-way events to the renderer.
 *
 * The renderer never chooses a command line: method names come from a fixed
 * allowlist and arguments are serialised to JSON only.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const DEFAULT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUTS = {
  "bridge.health": 45_000,
  "devices.discover": 60_000,
  "devices.capabilities": 120_000,
  "devices.readiness": 150_000,
  "devices.pair": 200_000,
  // A probe is three multicast browses plus one lockdown handshake per candidate.
  "wireless.probe": 90_000,
  // Connecting can open a userspace tunnel, which itself allows 75 s.
  "wireless.connect": 180_000,
  "wireless.disconnect": 40_000,
  "wireless.status": 15_000,
  "simulation.start": 150_000,
  "simulation.startRoute": 150_000,
  "simulation.pause": 20_000,
  "simulation.resume": 20_000,
  "simulation.stop": 40_000,
  "simulation.screenshot": 60_000,
  "route.importGpx": 20_000,
  "route.exportGpx": 20_000,
  "route.analyze": 20_000,
  "bridge.shutdown": 40_000,
};

const MAX_RESTARTS = 4;
const RESTART_WINDOW_MS = 60_000;

class BridgeClient extends EventEmitter {
  /**
   * @param {{projectRoot: string, bridgeRoot?: string, log: (level: string, message: string) => void}} options
   */
  constructor(options) {
    super();
    this.projectRoot = options.projectRoot;
    // The bridge package lives next to the app in development, but must be
    // unpacked beside the asar archive in a packaged build: a Python interpreter
    // cannot import modules from inside an asar file.
    this.bridgeRoot = options.bridgeRoot || path.join(options.projectRoot, "bridge");
    // Any real directory will do as the child's working directory; the asar path
    // itself is not one.
    this.workingDir = path.dirname(this.bridgeRoot);
    this.log = options.log || (() => {});
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.status = { state: "stopped", detail: "Bridge has not been started yet.", interpreter: null };
    this.restarts = [];
    this.buffer = "";
    this.stderrTail = [];
    this.startPromise = null;
  }

  // ------------------------------------------------------------ interpreter

  /**
   * Candidate interpreters, most specific first. Nothing is executed until a
   * candidate has been probed successfully.
   */
  interpreterCandidates() {
    const candidates = [];
    const override = process.env.LOCATION_STUDIO_PYTHON;
    if (override) candidates.push({ file: override, args: [] });

    const venvPaths =
      process.platform === "win32"
        ? [path.join(this.projectRoot, ".venv", "Scripts", "python.exe")]
        : [path.join(this.projectRoot, ".venv", "bin", "python3"), path.join(this.projectRoot, ".venv", "bin", "python")];
    for (const file of venvPaths) {
      if (fs.existsSync(file)) candidates.push({ file, args: [] });
    }

    if (process.platform === "win32") {
      candidates.push({ file: "py", args: ["-3.12"] });
      candidates.push({ file: "py", args: ["-3.11"] });
      candidates.push({ file: "py", args: ["-3"] });
      candidates.push({ file: "python", args: [] });
    } else {
      candidates.push({ file: "python3", args: [] });
      candidates.push({ file: "python", args: [] });
    }
    return candidates;
  }

  probeInterpreter(candidate, timeoutMs = 20_000) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      let child;
      try {
        child = spawn(candidate.file, [...candidate.args, "-c", "import pymobiledevice3,sys;print(sys.executable)"], {
          windowsHide: true,
          cwd: this.workingDir,
        });
      } catch (error) {
        finish({ ok: false, reason: `${candidate.file}: ${error.message}` });
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, reason: `${candidate.file} timed out while checking pymobiledevice3` });
      }, timeoutMs);
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk.toString()));
      child.stderr.on("data", (chunk) => (err += chunk.toString()));
      child.on("error", (error) => {
        clearTimeout(timer);
        finish({ ok: false, reason: `${candidate.file}: ${error.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && out.trim()) finish({ ok: true, interpreter: out.trim() });
        else finish({ ok: false, reason: (err || out || `exit code ${code}`).trim().slice(0, 400) });
      });
    });
  }

  // ---------------------------------------------------------------- process

  async ensureStarted() {
    if (this.child && this.status.state === "ready") return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async _start() {
    this._setStatus({ state: "starting", detail: "Looking for a Python interpreter with pymobiledevice3…" });

    const failures = [];
    for (const candidate of this.interpreterCandidates()) {
      const probe = await this.probeInterpreter(candidate);
      if (probe.ok) {
        this.interpreter = probe.interpreter;
        break;
      }
      failures.push(probe.reason);
    }

    if (!this.interpreter) {
      this._setStatus({
        state: "unavailable",
        detail:
          "No Python interpreter with pymobiledevice3 was found. The map, route editor and GPX tools still work; " +
          "device features stay disabled until the bridge dependency is installed.",
        failures,
      });
      throw new BridgeStartError(
        "The device bridge is not available.",
        "Install the bridge dependency, then press Restart bridge.\n\n" +
          "Location Studio looks for Python in this order: the LOCATION_STUDIO_PYTHON environment " +
          "variable, a project .venv, then any system Python 3.11+.\n\n" +
          "In the project folder:\n" +
          "  py -3.11 -m venv .venv\n" +
          "  .\\.venv\\Scripts\\python.exe -m pip install -r " +
          path.join(this.bridgeRoot, "requirements.txt") +
          "\n\n" +
          "Checked interpreters:\n" +
          failures.map((reason) => `  • ${reason}`).join("\n")
      );
    }

    this.restarts = this.restarts.filter((at) => Date.now() - at < RESTART_WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) {
      this._setStatus({
        state: "unavailable",
        detail: `The bridge crashed ${this.restarts.length} times in under a minute; automatic restart is paused.`,
      });
      throw new BridgeStartError(
        "The device bridge keeps crashing.",
        "Press Restart bridge to try again, or run the bridge manually to see the error:\n\n" +
          `  ${this.interpreter} -m location_studio_bridge serve`
      );
    }

    return this._spawn();
  }

  _spawn() {
    const env = {
      ...process.env,
      PYTHONPATH: [this.bridgeRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
    };

    const child = spawn(this.interpreter, ["-m", "location_studio_bridge", "serve"], {
      cwd: this.workingDir,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child = child;
    this.buffer = "";
    this._setStatus({ state: "starting", detail: "Bridge process started; waiting for handshake.", interpreter: this.interpreter });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => this._onStderr(chunk));

    child.on("error", (error) => {
      this._setStatus({ state: "crashed", detail: `Could not start the bridge process: ${error.message}` });
      this._rejectAll(new Error(`Bridge process error: ${error.message}`));
    });

    child.on("close", (code, signal) => {
      const expected = this.stopping === true;
      this.child = null;
      this.stopping = false;
      this._rejectAll(new Error("The device bridge stopped before answering."));
      if (expected) {
        this._setStatus({ state: "stopped", detail: "Bridge stopped." });
        return;
      }
      this.restarts.push(Date.now());
      this._setStatus({
        state: "crashed",
        detail: `Bridge exited unexpectedly (code ${code}, signal ${signal || "none"}). Last stderr output is shown above.`,
      });
      this.emit("bridge-status", this.status);
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new BridgeStartError("The bridge did not become ready in time.", this.stderrTail.join("\n")));
      }, 30_000);
      this.once("ready", () => {
        clearTimeout(timer);
        resolve();
      });
      this.once("bridge-failed", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async stop() {
    const child = this.child;
    if (!child) {
      this._setStatus({ state: "stopped", detail: "Bridge is not running." });
      return;
    }
    this.stopping = true;
    try {
      await this.request("bridge.shutdown", {}, { timeoutMs: 20_000 });
    } catch {
      /* the process may already be gone */
    }
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 5_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async restart() {
    await this.stop();
    await this.ensureStarted();
  }

  // ------------------------------------------------------------------ stdio

  _onStdout(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.log("warn", `Discarded non-JSON bridge output: ${line.slice(0, 200)}`);
        continue;
      }
      this._dispatch(message);
    }
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.log("error", "Bridge output exceeded the buffer limit; resetting.");
      this.buffer = "";
    }
  }

  _onStderr(chunk) {
    const text = chunk.toString().replace(/\s+$/, "");
    if (!text) return;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.stderrTail.push(line);
      if (this.stderrTail.length > 60) this.stderrTail.shift();
      this.emit("bridge-log", line);
    }
  }

  _dispatch(message) {
    if (message.type === "ready") {
      this._setStatus({ state: "ready", detail: "Bridge handshake complete.", interpreter: this.interpreter });
      this.emit("ready");
      return;
    }
    if (message.type === "event") {
      this.emit("event", { event: message.event, data: message.data });
      return;
    }
    if (message.type === "response") {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new BridgeRequestError(message.error || { code: "INTERNAL", message: "Unknown bridge error." }));
    }
  }

  _rejectAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  _setStatus(status) {
    this.status = { ...this.status, ...status, at: Date.now() };
    this.emit("bridge-status", this.status);
  }

  // --------------------------------------------------------------- requests

  request(method, params = {}, options = {}) {
    if (typeof method !== "string" || !method) {
      return Promise.reject(new BridgeRequestError({ code: "INVALID_REQUEST", message: "A method name is required." }));
    }
    if (!this.child || !this.child.stdin.writable) {
      return Promise.reject(
        new BridgeStartError("The device bridge is not running.", "Press Restart bridge in the Device workspace to try again.")
      );
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs || REQUEST_TIMEOUTS[method] || DEFAULT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeRequestError({
            code: "TIMEOUT",
            message: `${method} did not answer within ${Math.round(timeoutMs / 1000)}s.`,
            details: "The bridge process may be waiting on the device. Check the USB connection.",
            retryable: true,
          })
        );
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeRequestError({ code: "INTERNAL", message: `Could not write to the bridge: ${error.message}` }));
      }
    });
  }
}

class BridgeRequestError extends Error {
  constructor(payload) {
    super(payload.message || "Bridge request failed.");
    this.name = "BridgeRequestError";
    this.code = payload.code || "INTERNAL";
    this.details = payload.details;
    this.remedy = payload.remedy;
    this.retryable = Boolean(payload.retryable);
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details, remedy: this.remedy, retryable: this.retryable };
  }
}

class BridgeStartError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "BridgeStartError";
    this.code = "BRIDGE_UNAVAILABLE";
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details, retryable: true };
  }
}

module.exports = { BridgeClient, BridgeRequestError, BridgeStartError };
