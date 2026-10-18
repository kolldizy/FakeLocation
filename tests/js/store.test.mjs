/**
 * Store behaviour.
 *
 * The important property under test: the store only ever mirrors what the bridge
 * reported. There is no optimistic session, and a failing bridge clears the
 * session instead of leaving a stale "active" state on screen.
 *
 * `api.js` reads `globalThis.locationStudio` at module scope, so the fake bridge
 * has to exist before the module graph is imported.
 */

import test from "node:test";
import assert from "node:assert/strict";

const calls = [];
let responder = async () => ({ session: null, history: [], tunnel: null });

globalThis.locationStudio = {
  getAppInfo: async () => ({ ok: true, data: { appVersion: "test" } }),
  getSimulationStatus: async () => {
    calls.push("getSimulationStatus");
    const result = await responder();
    if (result && result.__error) {
      return {
        ok: false,
        error: { code: result.__error.code, message: result.__error.message, remedy: result.__error.remedy },
      };
    }
    return { ok: true, data: result };
  },
  loadWorkspace: async () => ({ ok: true, data: { document: workspaceDocument } }),
  saveWorkspace: async (params) => {
    calls.push({ method: "saveWorkspace", params });
    return { ok: true, data: { document: params.document } };
  },
};

let workspaceDocument = { locations: [], routes: [], settings: {} };

const store = await import("../../renderer/js/store.js");

function activeSession() {
  return {
    sessionId: "abc123",
    deviceId: "00008140-0000000000000000",
    mode: "route",
    state: "active",
    transport: "dvt-rsd",
    deviceAcknowledged: true,
    publishedPointCount: 7,
    current: { lat: 47.5, lon: 28.5 },
    locationOverrideActive: true,
  };
}

test("refreshSession mirrors the bridge's session exactly", async () => {
  responder = async () => ({ session: activeSession(), history: [], tunnel: { state: "open" } });
  const status = await store.refreshSession();

  assert.equal(status.session.state, "active");
  assert.deepEqual(store.state.session, activeSession());
  // Nothing is added locally: the object the bridge returned is what the UI sees.
  assert.equal(Object.keys(store.state.session).length, Object.keys(activeSession()).length);
});

test("a failed status query clears the session instead of keeping it", async () => {
  responder = async () => ({ session: activeSession(), history: [] });
  await store.refreshSession();
  assert.ok(store.state.session);

  responder = async () => ({ __error: { code: "BRIDGE_UNAVAILABLE", message: "The device bridge is not running." } });
  await assert.rejects(() => store.refreshSession(), /not running/);
  assert.equal(store.state.session, null, "a stale active session must never survive a failed query");
});

test("refreshSession tolerates an envelope with no session at all", async () => {
  responder = async () => ({ session: null, history: [], tunnel: null });
  await store.refreshSession();
  assert.equal(store.state.session, null);
});

test("selectedDevice resolves against the discovered list only", () => {
  store.setState({ devices: [], selectedDeviceId: "does-not-exist" });
  assert.equal(store.selectedDevice(), null);

  const device = { deviceId: "00008140-0000000000000000", connectionType: "USB" };
  store.setState({ devices: [device], selectedDeviceId: device.deviceId });
  assert.equal(store.selectedDevice(), device);
});

test("routeWaypoints keeps only what the device API accepts", () => {
  store.setState({
    route: [
      { id: "wp-1", name: "start", lat: 47.0, lon: 28.0, altitude: 12, selected: true },
      { id: "wp-2", name: "end", lat: 47.01, lon: 28.01 },
    ],
  });

  assert.deepEqual(store.routeWaypoints(), [
    { lat: 47.0, lon: 28.0, altitude: 12 },
    { lat: 47.01, lon: 28.01 },
  ]);
});

test("newId produces unique, prefixed identifiers", () => {
  const ids = new Set(Array.from({ length: 200 }, () => store.newId("route")));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^route-[a-z0-9]+-[a-z0-9]+$/);
});

test("subscribe notifies every listener and one failure cannot break the rest", () => {
  const seen = [];
  const unsubscribeBad = store.subscribe(() => {
    throw new Error("listener exploded");
  });
  const unsubscribeGood = store.subscribe((current) => seen.push(current.target.lat));

  const originalError = console.error;
  console.error = () => {};
  try {
    store.setState({ target: { lat: 1.25, lon: 2.5 } });
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(seen, [1.25]);
  unsubscribeGood();
  unsubscribeBad();
  store.setState({ target: { lat: 9.99, lon: 9.99 } });
  assert.deepEqual(seen, [1.25], "an unsubscribed listener must not be called again");
});

test("loadWorkspace adopts the persisted document", async () => {
  workspaceDocument = {
    schemaVersion: 1,
    locations: [{ id: "loc-1", name: "Home", lat: 47, lon: 28 }],
    routes: [{ id: "route-1", name: "Commute", points: [{ lat: 47, lon: 28 }, { lat: 48, lon: 29 }] }],
    settings: { tileStyle: "osm", mapCenter: { lat: 47, lon: 28, zoom: 14 }, lastTarget: { lat: 47.5, lon: 28.5, altitude: 20 } },
  };

  await store.loadWorkspace();

  assert.equal(store.state.savedLocations.length, 1);
  assert.equal(store.state.savedRoutes.length, 1);
  assert.equal(store.state.settings.tileStyle, "osm");
  assert.deepEqual(store.state.target, { lat: 47.5, lon: 28.5, altitude: 20 });
});

test("loadWorkspace survives a broken workspace file", async () => {
  const original = globalThis.locationStudio.loadWorkspace;
  globalThis.locationStudio.loadWorkspace = async () => ({ ok: false, error: { code: "INTERNAL", message: "corrupt" } });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await store.loadWorkspace();
  } finally {
    globalThis.locationStudio.loadWorkspace = original;
    console.warn = originalWarn;
  }
  assert.equal(store.state.savedLocations.length, 1, "the previous workspace must be left untouched");
});

test("persistWorkspace debounces writes and always stores a versioned document", async () => {
  calls.length = 0;
  store.setState({
    savedLocations: [{ id: "loc-9", name: "Lab", lat: 1, lon: 2 }],
    savedRoutes: [],
    routeOptions: { speedMps: 12.5, updateRateHz: 4, interpolate: true, loop: true },
    target: { lat: 47.0105, lon: 28.8638, altitude: 15 },
  });

  store.persistWorkspace();
  store.persistWorkspace();
  store.persistWorkspace();
  await new Promise((resolve) => setTimeout(resolve, 900));

  const writes = calls.filter((call) => typeof call === "object" && call.method === "saveWorkspace");
  assert.equal(writes.length, 1, "three requests inside the debounce window must collapse into one write");

  const document = writes[0].params.document;
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.locations.length, 1);
  assert.deepEqual(document.settings.lastTarget, { lat: 47.0105, lon: 28.8638, altitude: 15 });
  assert.equal(document.settings.routeSpeedMps, 12.5);
  assert.equal(document.settings.updateRateHz, 4);
});

test("a failed workspace write is swallowed, not surfaced as a crash", async () => {
  const original = globalThis.locationStudio.saveWorkspace;
  globalThis.locationStudio.saveWorkspace = async () => ({ ok: false, error: { code: "INTERNAL", message: "disk full" } });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    store.persistWorkspace();
    await new Promise((resolve) => setTimeout(resolve, 900));
  } finally {
    globalThis.locationStudio.saveWorkspace = original;
    console.warn = originalWarn;
  }
  assert.ok(true, "reaching here means the rejection was handled");
});
