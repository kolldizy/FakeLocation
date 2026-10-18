/**
 * Thin, typed wrapper over the preload API.
 *
 * Every call returns either the bridge payload or throws an `ApiError` carrying
 * the bridge's own error code. Callers never have to inspect envelopes.
 */

export class ApiError extends Error {
  constructor(payload = {}) {
    super(payload.message || "The operation failed.");
    this.name = "ApiError";
    this.code = payload.code || "INTERNAL";
    this.details = payload.details || null;
    this.remedy = payload.remedy || null;
    this.retryable = Boolean(payload.retryable);
  }
}

const bridge = globalThis.locationStudio;

export const available = Boolean(bridge);

function requireBridge() {
  if (!bridge) {
    throw new ApiError({
      code: "BRIDGE_UNAVAILABLE",
      message: "The desktop bridge is unavailable.",
      details: "This page is running outside the Electron shell, so device features cannot work.",
    });
  }
  return bridge;
}

async function unwrap(promise) {
  const envelope = await promise;
  if (!envelope || typeof envelope !== "object") {
    throw new ApiError({ message: "The bridge returned an unexpected response." });
  }
  if (envelope.ok) return envelope.data;
  throw new ApiError(envelope.error || {});
}

const invoke = (name) => (params) => unwrap(requireBridge()[name](params));

export const api = {
  // App + bridge
  getAppInfo: invoke("getAppInfo"),
  getBridgeStatus: invoke("getBridgeStatus"),
  getBridgeHealth: invoke("getBridgeHealth"),
  restartBridge: invoke("restartBridge"),
  shutdownSimulation: invoke("shutdownSimulation"),
  onBridgeStatus: (cb) => requireBridge().onBridgeStatus(cb),
  onBridgeLog: (cb) => requireBridge().onBridgeLog(cb),
  onBridgeEvent: (cb) => requireBridge().onBridgeEvent(cb),

  // Devices
  discoverDevices: invoke("discoverDevices"),
  getCapabilities: invoke("getCapabilities"),
  checkReadiness: invoke("checkReadiness"),
  pairDevice: invoke("pairDevice"),

  // Simulation
  startSimulation: invoke("startSimulation"),
  startRouteSimulation: invoke("startRouteSimulation"),
  pauseSimulation: invoke("pauseSimulation"),
  resumeSimulation: invoke("resumeSimulation"),
  stopSimulation: invoke("stopSimulation"),
  getSimulationStatus: invoke("getSimulationStatus"),
  captureDeviceScreenshot: invoke("captureDeviceScreenshot"),

  // Routes
  analyzeRoute: invoke("analyzeRoute"),
  importGpx: invoke("importGpx"),
  exportGpx: invoke("exportGpx"),

  // Workspace
  loadWorkspace: invoke("loadWorkspace"),
  saveWorkspace: invoke("saveWorkspace"),
  revealWorkspaceFile: invoke("revealWorkspaceFile"),

  // Misc
  openExternal: invoke("openExternal"),
};
