/**
 * Preload: the renderer's entire privileged API.
 *
 * Every entry is a fixed channel. There is no generic `invoke(channel, …)`
 * escape hatch, so a compromised renderer cannot reach an arbitrary IPC channel.
 */

const { contextBridge, ipcRenderer } = require("electron");

/** Calls that must return the full `{ok, data|error}` envelope. */
const invoke = (channel) => (params) => ipcRenderer.invoke(channel, params ?? {});

/** Subscribe helper that returns an unsubscribe function. */
function subscribe(channel, callback) {
  if (typeof callback !== "function") {
    throw new TypeError("A callback function is required.");
  }
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("locationStudio", {
  // App + bridge lifecycle
  getAppInfo: invoke("app:info"),
  getBridgeStatus: invoke("bridge:status"),
  getBridgeHealth: invoke("bridge:health"),
  restartBridge: invoke("bridge:restart"),
  shutdownSimulation: invoke("bridge:shutdownSimulation"),
  onBridgeStatus: (callback) => subscribe("bridge:status", callback),
  onBridgeLog: (callback) => subscribe("bridge:log", callback),
  onBridgeEvent: (callback) => subscribe("bridge:event", callback),

  // Devices
  discoverDevices: invoke("devices:discover"),
  getCapabilities: invoke("devices:capabilities"),
  checkReadiness: invoke("devices:readiness"),
  pairDevice: invoke("devices:pair"),

  // Wireless link
  probeWireless: invoke("wireless:probe"),
  connectWireless: invoke("wireless:connect"),
  disconnectWireless: invoke("wireless:disconnect"),
  getWirelessStatus: invoke("wireless:status"),

  // Simulation
  startSimulation: invoke("simulation:start"),
  startRouteSimulation: invoke("simulation:startRoute"),
  pauseSimulation: invoke("simulation:pause"),
  resumeSimulation: invoke("simulation:resume"),
  stopSimulation: invoke("simulation:stop"),
  getSimulationStatus: invoke("simulation:status"),
  captureDeviceScreenshot: invoke("simulation:screenshot"),

  // Routes and GPX
  analyzeRoute: invoke("route:analyze"),
  importGpx: invoke("route:import"),
  exportGpx: invoke("route:export"),

  // Workspace persistence
  loadWorkspace: invoke("workspace:load"),
  saveWorkspace: invoke("workspace:save"),
  revealWorkspaceFile: invoke("workspace:reveal"),

  // Misc
  openExternal: invoke("app:openExternal"),
});
