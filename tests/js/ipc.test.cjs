/**
 * IPC boundary tests.
 *
 * `registerIpc` receives its Electron APIs by injection, so every privileged
 * channel can be driven with fakes. What is being verified:
 *   - the channel list is exactly the intended one (no accidental additions);
 *   - hostile or malformed payloads never reach the bridge;
 *   - the renderer cannot choose a bridge method name or a shell command;
 *   - GPX files only move through native dialogs, with a size cap.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { registerIpc } = require("../../electron/ipc.cjs");

const EXPECTED_CHANNELS = [
  "app:info",
  "app:openExternal",
  "bridge:health",
  "bridge:restart",
  "bridge:shutdownSimulation",
  "bridge:status",
  "devices:capabilities",
  "devices:discover",
  "devices:pair",
  "devices:readiness",
  "route:analyze",
  "route:export",
  "route:import",
  "simulation:pause",
  "simulation:resume",
  "simulation:screenshot",
  "simulation:start",
  "simulation:startRoute",
  "simulation:status",
  "simulation:stop",
  "workspace:load",
  "workspace:reveal",
  "workspace:save",
];

const UDID = "00008140-0000000000000000";

function makeHarness(overrides = {}) {
  const handlers = new Map();
  const calls = [];

  const ipcMain = {
    handle(channel, handler) {
      if (handlers.has(channel)) throw new Error(`duplicate channel ${channel}`);
      handlers.set(channel, handler);
    },
  };

  const bridge = {
    status: { state: "ready", detail: "Bridge handshake complete.", interpreter: "python.exe" },
    ensureStarted: async () => {},
    restart: async () => {},
    request: async (method, params) => {
      calls.push({ method, params });
      return { method, params };
    },
    ...overrides.bridge,
  };

  const store = {
    filePath: path.join(os.tmpdir(), "location-studio-test", "workspace.json"),
    load: () => ({ schemaVersion: 1, locations: [], routes: [], settings: {} }),
    save: (document) => document,
  };

  const dialog = {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
    ...overrides.dialog,
  };

  const shellCalls = [];
  const electron = {
    dialog,
    shell: {
      showItemInFolder: (target) => shellCalls.push(["showItemInFolder", target]),
      openExternal: async (url) => shellCalls.push(["openExternal", url]),
      ...overrides.shell,
    },
    app: { getVersion: () => "1.0.0-test" },
  };

  registerIpc({
    ipcMain,
    bridge,
    store,
    getWindow: () => ({ id: 1 }),
    electron,
  });

  return {
    calls,
    shellCalls,
    bridge,
    store,
    handlers,
    invoke: (channel, params) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`channel ${channel} was never registered`);
      return handler({ sender: { id: 1 } }, params);
    },
  };
}

test("the registered channel list is exactly the reviewed surface", () => {
  const harness = makeHarness();
  assert.deepEqual([...harness.handlers.keys()].sort(), EXPECTED_CHANNELS);
});

test("app:info reports versions and the workspace path", async () => {
  const harness = makeHarness();
  const response = await harness.invoke("app:info", {});
  assert.equal(response.ok, true);
  assert.equal(response.data.appVersion, "1.0.0-test");
  assert.equal(response.data.workspaceFile, harness.store.filePath);
  assert.equal(response.data.bridgeStatus.state, "ready");
});

test("devices:discover defaults probeIdentity to true and rejects non-booleans", async () => {
  const harness = makeHarness();
  const byDefault = await harness.invoke("devices:discover", {});
  assert.equal(byDefault.ok, true);
  assert.deepEqual(harness.calls.at(-1), { method: "devices.discover", params: { probeIdentity: true } });

  const cheap = await harness.invoke("devices:discover", { probeIdentity: false });
  assert.equal(cheap.ok, true);
  assert.deepEqual(harness.calls.at(-1), { method: "devices.discover", params: { probeIdentity: false } });

  const before = harness.calls.length;
  const invalid = await harness.invoke("devices:discover", { probeIdentity: "yes" });
  assert.equal(invalid.ok, false);
  // A malformed payload is a client mistake, so it is reported as INVALID_PARAMS
  // rather than as an internal bridge fault.
  assert.equal(invalid.error.code, "INVALID_PARAMS");
  assert.equal(harness.calls.length, before, "an invalid payload must not reach the bridge");
});

test("device identifiers are validated before any bridge call", async () => {
  const harness = makeHarness();
  const invalidIds = ["", "  ", "not a udid", "-- leading dashes", "x", "a".repeat(70), 42, "$(whoami)"];
  for (const deviceId of invalidIds) {
    const response = await harness.invoke("devices:readiness", { deviceId });
    assert.equal(response.ok, false, `expected refusal for ${JSON.stringify(deviceId)}`);
  }
  assert.equal(harness.calls.length, 0);

  const response = await harness.invoke("devices:readiness", { deviceId: UDID, openTunnel: false });
  assert.equal(response.ok, true);
  assert.deepEqual(harness.calls.at(-1), { method: "devices.readiness", params: { deviceId: UDID, openTunnel: false } });
});

test("pairing bounds the trust prompt timeout", async () => {
  const harness = makeHarness();
  assert.equal((await harness.invoke("devices:pair", { deviceId: UDID, timeoutSeconds: 5 })).ok, false);
  assert.equal((await harness.invoke("devices:pair", { deviceId: UDID, timeoutSeconds: 600 })).ok, false);
  const accepted = await harness.invoke("devices:pair", { deviceId: UDID, timeoutSeconds: 120 });
  assert.equal(accepted.ok, true);
  assert.deepEqual(harness.calls.at(-1), { method: "devices.pair", params: { deviceId: UDID, timeoutSeconds: 120 } });
});

test("simulation:start rejects out-of-range and non-numeric coordinates", async () => {
  const harness = makeHarness();
  const bad = [
    undefined,
    null,
    {},
    { lat: 91, lon: 0 },
    { lat: -90.0001, lon: 0 },
    { lat: 0, lon: 181 },
    { lat: 0, lon: -180.5 },
    { lat: "47.0", lon: 28.8 },
    { lat: Number.NaN, lon: 0 },
    { lat: Number.POSITIVE_INFINITY, lon: 0 },
    { lat: 47, lon: 28, altitude: 99999 },
    { lat: 47, lon: 28, altitude: "high" },
  ];
  for (const coordinate of bad) {
    const response = await harness.invoke("simulation:start", { deviceId: UDID, coordinate });
    assert.equal(response.ok, false, `expected refusal for ${JSON.stringify(coordinate)}`);
  }
  assert.equal(harness.calls.length, 0);

  const good = await harness.invoke("simulation:start", { deviceId: UDID, coordinate: { lat: 47.0105, lon: 28.8638, altitude: 15 } });
  assert.equal(good.ok, true);
  assert.deepEqual(harness.calls.at(-1).params.coordinate, { lat: 47.0105, lon: 28.8638, altitude: 15 });
});

test("simulation:startRoute enforces the point count and option bounds", async () => {
  const harness = makeHarness();
  const point = { lat: 47, lon: 28 };

  assert.equal((await harness.invoke("simulation:startRoute", { deviceId: UDID, points: [point] })).ok, false);
  assert.equal((await harness.invoke("simulation:startRoute", { deviceId: UDID, points: "route" })).ok, false);

  const tooMany = Array.from({ length: 20_001 }, () => point);
  assert.equal((await harness.invoke("simulation:startRoute", { deviceId: UDID, points: tooMany })).ok, false);

  assert.equal(
    (await harness.invoke("simulation:startRoute", { deviceId: UDID, points: [point, point], options: { speedMps: 0 } })).ok,
    false
  );
  assert.equal(
    (await harness.invoke("simulation:startRoute", { deviceId: UDID, points: [point, point], options: { updateRateHz: 100 } })).ok,
    false
  );
  assert.equal(
    (await harness.invoke("simulation:startRoute", { deviceId: UDID, points: [point, point], options: { loop: "yes" } })).ok,
    false
  );

  const accepted = await harness.invoke("simulation:startRoute", {
    deviceId: UDID,
    points: [{ lat: 47, lon: 28 }, { lat: 47.001, lon: 28.001 }],
    options: { speedMps: 8, updateRateHz: 5, loop: true, interpolate: true },
  });
  assert.equal(accepted.ok, true);
  const forwarded = harness.calls.at(-1);
  assert.equal(forwarded.method, "simulation.startRoute");
  assert.equal(forwarded.params.points.length, 2);
  assert.deepEqual(forwarded.params.options, { speedMps: 8, updateRateHz: 5, loop: true, interpolate: true });
});

test("pause and resume tolerate a missing deviceId but reject a malformed one", async () => {
  const harness = makeHarness();
  assert.equal((await harness.invoke("simulation:pause", {})).ok, true);
  assert.deepEqual(harness.calls.at(-1), { method: "simulation.pause", params: {} });

  assert.equal((await harness.invoke("simulation:resume", { deviceId: UDID })).ok, true);
  assert.deepEqual(harness.calls.at(-1), { method: "simulation.resume", params: { deviceId: UDID } });

  assert.equal((await harness.invoke("simulation:pause", { deviceId: "../../etc" })).ok, false);
});

test("simulation:status short-circuits when the bridge is not ready", async () => {
  const harness = makeHarness({ bridge: { status: { state: "starting", detail: "handshake" } } });
  const response = await harness.invoke("simulation:status", {});
  assert.equal(response.ok, true);
  assert.equal(response.data.session, null);
  assert.deepEqual(response.data.history, []);
  assert.equal(harness.calls.length, 0, "an unready bridge must not be asked for a session");
});

test("route:analyze validates points and forwards options", async () => {
  const harness = makeHarness();
  assert.equal((await harness.invoke("route:analyze", { points: [] })).ok, false);
  assert.equal((await harness.invoke("route:analyze", { points: [{ lat: 200, lon: 0 }] })).ok, false);

  const ok = await harness.invoke("route:analyze", {
    points: [{ lat: 47, lon: 28 }, { lat: 47.01, lon: 28.01 }],
    options: { speedMps: 12, updateRateHz: 4 },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(harness.calls.at(-1), {
    method: "route.analyze",
    params: { points: [{ lat: 47, lon: 28 }, { lat: 47.01, lon: 28.01 }], options: { speedMps: 12, updateRateHz: 4 } },
  });
});

test("route:import reads only through the dialog and caps the file size", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-gpx-"));
  const smallFile = path.join(tempDir, "route.gpx");
  const hugeFile = path.join(tempDir, "huge.gpx");
  fs.writeFileSync(smallFile, "<gpx></gpx>");
  fs.writeFileSync(hugeFile, Buffer.alloc(16 * 1024 * 1024 + 1));

  try {
    const cancelled = makeHarness();
    const cancelResponse = await cancelled.invoke("route:import", {});
    assert.equal(cancelResponse.ok, true);
    assert.deepEqual(cancelResponse.data, { canceled: true });
    assert.equal(cancelled.calls.length, 0);

    const okHarness = makeHarness({ dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [smallFile] }) } });
    const opened = await okHarness.invoke("route:import", {});
    assert.equal(opened.ok, true);
    assert.equal(opened.data.parsed.method, "route.importGpx");
    assert.equal(opened.data.parsed.params.fileName, "route.gpx");
    assert.equal(opened.data.parsed.params.content, "<gpx></gpx>");

    const hugeHarness = makeHarness({ dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [hugeFile] }) } });
    const refused = await hugeHarness.invoke("route:import", {});
    assert.equal(refused.ok, false);
    assert.match(refused.error.message, /limit is 16 MB/);
    assert.equal(hugeHarness.calls.length, 0, "an oversized file must not be read into the bridge");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("route:export sanitises the suggested file name and appends .gpx", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-export-"));
  let suggestedPath = null;
  let savedPath = null;

  const harness = makeHarness({
    bridge: {
      request: async (method, params) => {
        harness.calls.push({ method, params });
        return { fileName: "route.gpx", content: "<gpx/>", pointCount: params.points.length, bytes: 6 };
      },
    },
    dialog: {
      showSaveDialog: async (_window, options) => {
        suggestedPath = options.defaultPath;
        savedPath = path.join(tempDir, "chosen-name");
        return { canceled: false, filePath: savedPath };
      },
    },
  });

  try {
    const response = await harness.invoke("route:export", {
      points: [{ lat: 47, lon: 28 }],
      name: "../../evil<>|name?.gpx",
      speedMps: 8,
    });
    assert.equal(response.ok, true);
    assert.equal(suggestedPath, "evilname.gpx");
    assert.equal(response.data.filePath, `${savedPath}.gpx`);
    assert.equal(fs.readFileSync(`${savedPath}.gpx`, "utf8"), "<gpx/>");
    assert.equal(response.data.pointCount, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workspace:save refuses non-objects and returns the stored document", async () => {
  const harness = makeHarness();
  assert.equal((await harness.invoke("workspace:save", { document: "not a document" })).ok, false);
  assert.equal((await harness.invoke("workspace:save", { document: [1, 2, 3] })).ok, false);

  const stored = await harness.invoke("workspace:save", { document: { schemaVersion: 1, locations: [], routes: [] } });
  assert.equal(stored.ok, true);
  assert.equal(stored.data.document.schemaVersion, 1);
});

test("app:openExternal only opens https links", async () => {
  const harness = makeHarness();
  const refused = ["http://example.com", "file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "-a", ""];
  for (const url of refused) {
    const response = await harness.invoke("app:openExternal", { url });
    assert.equal(response.ok, false, `expected refusal for ${url}`);
  }
  assert.equal(harness.shellCalls.length, 0);

  const opened = await harness.invoke("app:openExternal", { url: "https://support.apple.com/guide/iphone/welcome/ios" });
  assert.equal(opened.ok, true);
  assert.deepEqual(harness.shellCalls.at(-1), ["openExternal", "https://support.apple.com/guide/iphone/welcome/ios"]);
});

test("bridge errors keep their code, remedy and retryable flag", async () => {
  const harness = makeHarness({
    bridge: {
      request: async () => {
        throw Object.assign(new Error("The iPhone is not paired."), {
          code: "NOT_PAIRED",
          remedy: "Unlock the iPhone and pair it from Device Center.",
          retryable: true,
          details: "lockdownd refused the session.",
          toJSON() {
            return {
              code: this.code,
              message: this.message,
              remedy: this.remedy,
              retryable: this.retryable,
              details: this.details,
            };
          },
        });
      },
    },
  });

  const response = await harness.invoke("devices:readiness", { deviceId: UDID });
  assert.equal(response.ok, false);
  assert.deepEqual(response.error, {
    code: "NOT_PAIRED",
    message: "The iPhone is not paired.",
    remedy: "Unlock the iPhone and pair it from Device Center.",
    retryable: true,
    details: "lockdownd refused the session.",
  });
});

test("a bridge start failure is reported as a structured envelope", async () => {
  const harness = makeHarness({
    bridge: {
      ensureStarted: async () => {
        throw new Error("The bridge did not become ready in time.");
      },
    },
  });
  const response = await harness.invoke("devices:discover", {});
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "INTERNAL");
  assert.match(response.error.message, /did not become ready/);
});

test("the renderer cannot supply a method name, argument vector or shell command", async () => {
  const harness = makeHarness();
  const hostile = [
    ["bridge:health", { method: "rm -rf /", params: { command: "shutdown /s" } }],
    ["devices:discover", { params: ["--cli", "--sudo"] }],
    ["simulation:status", { method: "bridge.shutdown" }],
  ];
  for (const [channel, payload] of hostile) {
    const response = await harness.invoke(channel, payload);
    assert.equal(response.ok, true, `${channel} should ignore extra fields, not forward them`);
  }
  // Only the fixed, reviewed methods are reachable, regardless of what the
  // renderer puts in the payload.
  assert.deepEqual(
    harness.calls.map((call) => call.method),
    ["bridge.health", "devices.discover", "simulation.status"]
  );
  assert.deepEqual(harness.calls[1].params, { probeIdentity: true });
  for (const call of harness.calls) {
    assert.ok(!("command" in (call.params || {})), `${call.method} must not receive a command field`);
  }
});
