/**
 * IPC surface. This module is the trust boundary between the renderer and the
 * device bridge.
 *
 * Guarantees:
 *  - the renderer can only call the channels registered here;
 *  - the renderer never supplies a method name, argument vector or shell string;
 *  - every payload is shape-checked (electron/validation.cjs) before it is forwarded;
 *  - GPX files are read and written only through native file dialogs, with a
 *    size cap, and parsed by the bridge (defusedxml) rather than by the renderer.
 *
 * `registerIpc` takes its Electron APIs as a parameter so the whole channel
 * surface can be exercised in tests with fakes; in the app it defaults to the
 * real `electron` module.
 */

const fs = require("node:fs");
const path = require("node:path");

const {
  MAX_GPX_READ_BYTES,
  isPlainObject,
  asString,
  asNumber,
  asBoolean,
  validateDeviceId,
  validateTransport,
  validateCoordinate,
  validatePoints,
  validateOptions,
  safeFileName,
  toBridgeError,
} = require("./validation.cjs");
/**
 * Wraps a handler so every failure reaches the renderer in the same shape as a
 * bridge error, instead of surfacing as an unhandled IPC rejection.
 */
function guard(handler) {
  return async (event, params) => {
    try {
      const result = await handler(event, params ?? {});
      return { ok: true, data: result };
    } catch (error) {
      return { ok: false, error: toBridgeError(error) };
    }
  };
}

function registerIpc({ ipcMain, bridge, store, getWindow, electron }) {
  const { dialog, shell, app } = electron || require("electron");
  const handle = (channel, handler) => ipcMain.handle(channel, guard(handler));

  // ------------------------------------------------------------------ status
  handle("app:info", async () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    workspaceFile: store.filePath,
    bridgeStatus: bridge.status,
  }));

  handle("bridge:status", async () => bridge.status);

  handle("bridge:restart", async () => {
    await bridge.restart();
    return { status: bridge.status };
  });

  handle("bridge:health", async () => {
    await bridge.ensureStarted();
    return bridge.request("bridge.health");
  });

  handle("bridge:shutdownSimulation", async () => {
    if (bridge.status.state !== "ready") return { ok: true, skipped: true };
    return bridge.request("bridge.shutdown");
  });

  // ----------------------------------------------------------------- devices
  handle("devices:discover", async (_event, params) => {
    await bridge.ensureStarted();
    return bridge.request("devices.discover", {
      probeIdentity: params.probeIdentity === undefined ? true : asBoolean(params.probeIdentity, "probeIdentity"),
    });
  });

  handle("devices:capabilities", async (_event, params) => {
    await bridge.ensureStarted();
    const request = {};
    if (params.deviceId) request.deviceId = validateDeviceId(params);
    if (params.deep !== undefined) request.deep = asBoolean(params.deep, "deep");
    if (params.transport !== undefined) request.transport = validateTransport(params.transport);
    return bridge.request("devices.capabilities", request);
  });

  handle("devices:readiness", async (_event, params) => {
    await bridge.ensureStarted();
    const request = { deviceId: validateDeviceId(params) };
    if (params.openTunnel !== undefined) request.openTunnel = asBoolean(params.openTunnel, "openTunnel");
    if (params.transport !== undefined) request.transport = validateTransport(params.transport);
    return bridge.request("devices.readiness", request);
  });

  handle("devices:pair", async (_event, params) => {
    await bridge.ensureStarted();
    const request = { deviceId: validateDeviceId(params) };
    if (params.timeoutSeconds !== undefined) {
      request.timeoutSeconds = asNumber(params.timeoutSeconds, "timeoutSeconds", { min: 10, max: 180 });
    }
    return bridge.request("devices.pair", request);
  });

  // ---------------------------------------------------------------- wireless
  // The renderer names a device and, at most, one of three transport ids. Discovery
  // addresses, LAN hosts and ports are chosen by the bridge from what it just observed.

  handle("wireless:probe", async (_event, params) => {
    await bridge.ensureStarted();
    const request = {};
    if (params.deviceId !== undefined && params.deviceId !== null) request.deviceId = validateDeviceId(params);
    if (params.probeIdentity !== undefined) request.probeIdentity = asBoolean(params.probeIdentity, "probeIdentity");
    return bridge.request("wireless.probe", request);
  });

  handle("wireless:connect", async (_event, params) => {
    await bridge.ensureStarted();
    return bridge.request("wireless.connect", {
      deviceId: validateDeviceId(params),
      transport: validateTransport(params.transport),
    });
  });

  handle("wireless:disconnect", async (_event, params) => {
    await bridge.ensureStarted();
    const request = {};
    if (params.deviceId !== undefined && params.deviceId !== null) request.deviceId = validateDeviceId(params);
    return bridge.request("wireless.disconnect", request);
  });

  handle("wireless:status", async (_event, params) => {
    await bridge.ensureStarted();
    const request = {};
    if (params.deviceId !== undefined && params.deviceId !== null) request.deviceId = validateDeviceId(params);
    return bridge.request("wireless.status", request);
  });

  // -------------------------------------------------------------- simulation
  handle("simulation:start", async (_event, params) => {
    await bridge.ensureStarted();
    return bridge.request("simulation.start", {
      deviceId: validateDeviceId(params),
      coordinate: validateCoordinate(params.coordinate),
    });
  });

  handle("simulation:startRoute", async (_event, params) => {
    await bridge.ensureStarted();
    return bridge.request("simulation.startRoute", {
      deviceId: validateDeviceId(params),
      points: validatePoints(params.points, { minimum: 2 }),
      options: validateOptions(params.options),
    });
  });

  handle("simulation:pause", async (_event, params) =>
    bridge.request("simulation.pause", params.deviceId ? { deviceId: validateDeviceId(params) } : {})
  );

  handle("simulation:resume", async (_event, params) =>
    bridge.request("simulation.resume", params.deviceId ? { deviceId: validateDeviceId(params) } : {})
  );

  handle("simulation:stop", async (_event, params) => {
    await bridge.ensureStarted();
    return bridge.request("simulation.stop", params.deviceId ? { deviceId: validateDeviceId(params) } : {});
  });

  handle("simulation:status", async () => {
    if (bridge.status.state !== "ready") return { session: null, tunnel: null, history: [], bridge: bridge.status };
    return bridge.request("simulation.status");
  });

  handle("simulation:screenshot", async (_event, params) => {
    await bridge.ensureStarted();
    return bridge.request("simulation.screenshot", { deviceId: validateDeviceId(params) });
  });

  // ------------------------------------------------------------------ routes
  handle("route:analyze", async (_event, params) =>
    bridge.request("route.analyze", { points: validatePoints(params.points), options: validateOptions(params.options) })
  );

  handle("route:import", async () => {
    const window = getWindow();
    const result = await dialog.showOpenDialog(window, {
      title: "Import GPX route",
      filters: [{ name: "GPX route", extensions: ["gpx"] }],
      properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    const filePath = result.filePaths[0];
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_GPX_READ_BYTES) {
      throw new Error(`That file is ${(stats.size / 1048576).toFixed(1)} MB; the limit is 16 MB.`);
    }
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = await bridge.request("route.importGpx", {
      fileName: path.basename(filePath),
      content,
    });
    return { canceled: false, filePath, parsed };
  });

  handle("route:export", async (_event, params) => {
    const points = validatePoints(params.points);
    const name = asString(params.name, "name", { max: 120, required: false }) || "Location Studio route";
    const request = { points, name, options: validateOptions(params.options) };
    const altitude = asNumber(params.altitude, "altitude", { min: -12000, max: 12000, optional: true });
    if (altitude !== undefined) request.altitude = altitude;
    const speed = asNumber(params.speedMps, "speedMps", { min: 0, max: 400, optional: true });
    if (speed !== undefined) request.speedMps = speed;

    const bundle = await bridge.request("route.exportGpx", request);

    const window = getWindow();
    const result = await dialog.showSaveDialog(window, {
      title: "Export GPX",
      defaultPath: `${safeFileName(name)}.gpx`,
      filters: [{ name: "GPX route", extensions: ["gpx"] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const target = result.filePath.toLowerCase().endsWith(".gpx") ? result.filePath : `${result.filePath}.gpx`;
    fs.writeFileSync(target, bundle.content, "utf8");
    return { canceled: false, filePath: target, pointCount: bundle.pointCount, bytes: bundle.bytes };
  });

  // ------------------------------------------------------------- persistence
  handle("workspace:load", async () => ({ document: store.load(), filePath: store.filePath }));
  handle("workspace:save", async (_event, params) => {
    if (!isPlainObject(params.document)) throw new Error("'document' must be an object.");
    return { document: store.save(params.document), filePath: store.filePath };
  });
  handle("workspace:reveal", async () => {
    shell.showItemInFolder(store.filePath);
    return { filePath: store.filePath };
  });

  // ------------------------------------------------------------------- misc
  handle("app:openExternal", async (_event, params) => {
    const url = asString(params.url, "url", { max: 2048 });
    if (!/^https:\/\//i.test(url)) throw new Error("Only https:// links can be opened.");
    await shell.openExternal(url);
    return { opened: url };
  });
}

module.exports = {
  registerIpc,
  guard,
  safeFileName,
  validateDeviceId,
  validateTransport,
  validateCoordinate,
  validatePoints,
  validateOptions,
};
