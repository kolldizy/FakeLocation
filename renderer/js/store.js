/**
 * Central application state.
 *
 * This is the single source of truth for the UI. It holds *observed* state only:
 * `session` is always the bridge's reported session, never a locally assumed one.
 */

import { api } from "./api.js";

const DEFAULT_TARGET = { lat: 47.0105, lon: 28.8638, altitude: 15 };

const listeners = new Set();

export const state = {
  /** @type {Array<object>} */
  devices: [],
  /** @type {object|null} last discovery report, so an empty list can explain itself */
  discovery: null,
  selectedDeviceId: null,
  readyDeviceId: null,
  /** @type {object|null} latest readiness report for the selected device */
  readiness: null,
  /** @type {Array<object>|null} */
  capabilities: null,

  /** @type {object|null} last wireless probe report, verbatim from the bridge */
  wireless: null,
  /** @type {object|null} proven / selected / active-session transports for one device */
  wirelessLink: null,
  /** @type {object|null} live developer tunnel status */
  wirelessTunnel: null,

  bridge: { state: "stopped", detail: "Bridge has not been started yet." },
  health: null,
  appInfo: null,

  target: { ...DEFAULT_TARGET },
  route: [],
  routeEditing: false,
  /** Index of the waypoint the user last selected, or -1. UI-only, never persisted. */
  selectedWaypoint: -1,
  routeOptions: { speedMps: 8, updateRateHz: 5, interpolate: true, loop: false },

  savedLocations: [],
  savedRoutes: [],
  settings: { mapCenter: { lat: 47.0105, lon: 28.8638, zoom: 12 }, tileStyle: "dark" },

  /** @type {object|null} bridge-reported session */
  session: null,
  history: [],

  view: "map",
};

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setState(patch, meta = {}) {
  Object.assign(state, patch);
  for (const listener of listeners) {
    try {
      listener(state, meta);
    } catch (error) {
      console.error("state listener failed", error);
    }
  }
}

/** Refresh the bridge-reported session and mirror it into state. */
export async function refreshSession() {
  try {
    const status = await api.getSimulationStatus();
    setState({ session: status.session || null, history: status.history || [] });
    return status;
  } catch (error) {
    setState({ session: null });
    throw error;
  }
}

export function selectedDevice() {
  return state.devices.find((device) => device.deviceId === state.selectedDeviceId) || null;
}

export function routeWaypoints() {
  return state.route.map((point) => ({ lat: point.lat, lon: point.lon, ...(point.altitude !== undefined ? { altitude: point.altitude } : {}) }));
}

/* --------------------------------------------------------- persistence */

const PERSIST_DEBOUNCE_MS = 600;
let persistHandle = null;

export async function loadWorkspace() {
  try {
    const { document } = await api.loadWorkspace();
    setState({
      savedLocations: document.locations || [],
      savedRoutes: document.routes || [],
      settings: { ...state.settings, ...(document.settings || {}) },
      target: document.settings?.lastTarget || state.target,
    });
  } catch (error) {
    console.warn("workspace could not be loaded", error);
  }
}

export function persistWorkspace() {
  if (persistHandle) clearTimeout(persistHandle);
  persistHandle = setTimeout(async () => {
    persistHandle = null;
    try {
      await api.saveWorkspace({
        document: {
          schemaVersion: 1,
          locations: state.savedLocations,
          routes: state.savedRoutes,
          settings: {
            ...state.settings,
            lastDeviceId: state.selectedDeviceId,
            routeSpeedMps: state.routeOptions.speedMps,
            updateRateHz: state.routeOptions.updateRateHz,
            lastTarget: state.target,
          },
        },
      });
    } catch (error) {
      console.warn("workspace could not be saved", error);
    }
  }, PERSIST_DEBOUNCE_MS);
}

export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
