/**
 * Map Studio — coordinate design and route building.
 *
 * Everything in this view is design-time data. Nothing here touches the iPhone;
 * the only device-facing operations live in Motion Lab and the Simulation Console.
 *
 * Route metrics are requested from the bridge (`route.analyze`) so the numbers the
 * user sees are the same numbers the device playback will use. A local calculation
 * is used as a fallback when the bridge is unavailable, and is labelled as such.
 */

import { api, available as bridgeAvailable } from "./api.js";
import { state, setState, subscribe, newId, persistWorkspace } from "./store.js";
import { studioMap } from "./maps.js";
import { promptText, confirmAction } from "./dialog.js";
import { consoleLog, toast, reportError } from "./logpanel.js";
import {
  $,
  el,
  clear,
  fmtCoord,
  fmtCoordPair,
  fmtClock,
  fmtDistance,
  parseCoordinate,
  validateLatitude,
  validateLongitude,
  validateAltitude,
  routeLengthM,
  buildPlaybackPoints,
  debounce,
} from "./util.js";

let initialised = false;
let searchHost = null;
let analysing = false;
let analysedSignature = "";
let locationsSignature = "";
let routeSignature = "";
let routesSignature = "";

/** Cheap change detector so a full re-render only happens when data actually moved. */
function signature(value) {
  return JSON.stringify(value);
}

/* ------------------------------------------------------------------ helpers */

function setHint(node, text, kind = "") {
  const target = typeof node === "string" ? $(node) : node;
  if (!target) return;
  target.textContent = text;
  target.className = `hint${kind ? ` ${kind}` : ""}`;
}

function routeOptions() {
  return { ...state.routeOptions };
}

function waypointsForPlayback(points) {
  return buildPlaybackPoints(points, routeOptions());
}

/* ------------------------------------------------------------------- target */

function readTargetInputs() {
  const lat = parseCoordinate($("input-lat").value);
  const lon = parseCoordinate($("input-lon").value);
  const rawAlt = $("input-alt").value;
  const altitude = rawAlt === "" ? null : parseCoordinate(rawAlt);

  const problems = [];
  const latProblem = validateLatitude(lat);
  if (latProblem) problems.push(latProblem);
  const lonProblem = validateLongitude(lon);
  if (lonProblem) problems.push(lonProblem);
  const altProblem = validateAltitude(rawAlt === "" ? null : rawAlt);
  if (altProblem) problems.push(altProblem);

  if (problems.length) return { ok: false, problems };
  return { ok: true, target: { lat, lon, ...(altitude === null ? {} : { altitude }) } };
}

function applyTarget(lat, lon, { altitude, pan = false, source = "input", quiet = false } = {}) {
  const target = {
    lat,
    lon,
    ...(altitude === undefined || altitude === null ? {} : { altitude }),
  };
  if (!quiet && source === "input") setHint("coord-status", `Target set from ${source}.`, "ok");

  setState({ target });
  $("input-lat").value = fmtCoord(target.lat);
  $("input-lon").value = fmtCoord(target.lon);
  if (target.altitude !== undefined) $("input-alt").value = String(target.altitude);
  studioMap.setTarget(target.lat, target.lon, pan);
  studioMap.setDeviceLocation(null);
  persistWorkspace();
  return target;
}

/* ------------------------------------------------------------- saved places */

function locationRow(location) {
  const load = el("button", { className: "btn tiny", text: "Set target", attrs: { type: "button" } });
  load.addEventListener("click", (event) => {
    event.stopPropagation();
    applyTarget(location.lat, location.lon, { altitude: location.altitude, pan: true, source: "saved location" });
    setHint("coord-status", `Target moved to “${location.name}”.`, "ok");
    toast("Target updated", `${location.name} — ${fmtCoordPair(location.lat, location.lon)}`, { kind: "ok" });
  });

  const useAsWaypoint = el("button", { className: "btn tiny ghost", text: "+ Waypoint", attrs: { type: "button" } });
  useAsWaypoint.addEventListener("click", (event) => {
    event.stopPropagation();
    addWaypoint(location.lat, location.lon, location.altitude);
  });

  const remove = el("button", { className: "btn tiny danger", text: "✕", attrs: { type: "button", title: "Delete" } });
  remove.addEventListener("click", async (event) => {
    event.stopPropagation();
    const ok = await confirmAction({
      title: "Delete saved location",
      message: `Remove “${location.name}” from the workspace?`,
      confirmLabel: "Delete",
      danger: true,
      hint: "This only affects the local workspace file on this PC.",
    });
    if (!ok) return;
    setState({ savedLocations: state.savedLocations.filter((item) => item.id !== location.id) });
    persistWorkspace();
    toast("Location deleted", location.name);
  });

  return el("div", { className: "list-row" }, [
    el("div", { className: "grow" }, [
      el("div", { className: "name", text: location.name }),
      el("div", {
        className: "meta",
        text: `${fmtCoordPair(location.lat, location.lon)}${location.altitude !== undefined ? ` · ${location.altitude} m` : ""}`,
      }),
    ]),
    load,
    useAsWaypoint,
    remove,
  ]);
}

function renderLocations() {
  const nextSignature = signature(state.savedLocations);
  if (nextSignature === locationsSignature) return;
  locationsSignature = nextSignature;

  const host = $("saved-list");
  clear(host);
  $("saved-count").textContent = String(state.savedLocations.length);
  if (!state.savedLocations.length) {
    host.appendChild(el("div", { className: "empty", text: "No saved locations yet." }));
    return;
  }
  for (const location of state.savedLocations) host.appendChild(locationRow(location));
}

/* ------------------------------------------------------------- route editing */

function addWaypoint(lat, lon, altitude) {
  const point = { lat, lon, ...(altitude === undefined || altitude === null ? {} : { altitude }) };
  setState({ route: [...state.route, point] });
  persistWorkspace();
  setHint("coord-status", `Waypoint ${state.route.length} added.`, "ok");
}

function moveWaypoint(index, direction) {
  const next = [...state.route];
  const target = index + direction;
  if (target < 0 || target >= next.length) return;
  [next[index], next[target]] = [next[target], next[index]];
  setState({ route: next });
  persistWorkspace();
}

function waypointRow(point, index) {
  const up = el("button", { className: "btn tiny ghost", text: "↑", attrs: { type: "button", title: "Move earlier" } });
  up.disabled = index === 0;
  up.addEventListener("click", () => moveWaypoint(index, -1));

  const down = el("button", { className: "btn tiny ghost", text: "↓", attrs: { type: "button", title: "Move later" } });
  down.disabled = index === state.route.length - 1;
  down.addEventListener("click", () => moveWaypoint(index, 1));

  const remove = el("button", { className: "btn tiny danger", text: "✕", attrs: { type: "button", title: "Remove" } });
  remove.addEventListener("click", () => {
    setState({ route: state.route.filter((_, position) => position !== index) });
    persistWorkspace();
  });

  const label = el("button", { className: "btn tiny", text: "◎", attrs: { type: "button", title: "Centre map here" } });
  label.addEventListener("click", () => {
    studioMap.map.setView([point.lat, point.lon], Math.max(studioMap.map.getZoom(), 14));
  });

  return el("div", { className: "list-row" }, [
    el("div", {
      className: "device-glyph",
      text: String(index + 1),
      attrs: { style: "flex:0 0 30px; width:30px; height:30px; font-size:11px; border-radius:7px;" },
    }),
    el("div", { className: "grow" }, [
      el("div", { className: "name", text: fmtCoordPair(point.lat, point.lon) }),
      el("div", {
        className: "meta",
        text: point.altitude !== undefined ? `altitude ${point.altitude} m (metadata only)` : "no altitude recorded",
      }),
    ]),
    label,
    up,
    down,
    remove,
  ]);
}

function renderWaypoints() {
  const nextSignature = signature(state.route);
  if (nextSignature === routeSignature) return;
  routeSignature = nextSignature;

  const host = $("waypoint-list");
  clear(host);
  $("route-count").textContent = `${state.route.length} WAYPOINT${state.route.length === 1 ? "" : "S"}`;
  if (!state.route.length) {
    host.appendChild(el("div", { className: "empty", text: "Add at least two waypoints to build a route." }));
    studioMap.redrawRoute(state.route, -1);
    return;
  }
  state.route.forEach((point, index) => host.appendChild(waypointRow(point, index)));
  studioMap.redrawRoute(state.route, -1);
}

function renderSavedRoutes() {
  const nextSignature = signature(state.savedRoutes);
  if (nextSignature === routesSignature) return;
  routesSignature = nextSignature;

  const host = $("saved-routes");
  clear(host);
  $("routes-count").textContent = String(state.savedRoutes.length);
  if (!state.savedRoutes.length) {
    host.appendChild(el("div", { className: "empty", text: "No saved routes yet." }));
    return;
  }
  for (const route of state.savedRoutes) {
    const load = el("button", { className: "btn tiny", text: "Load", attrs: { type: "button" } });
    load.addEventListener("click", () => {
      setState({
        route: route.points.map((point) => ({ ...point })),
        routeOptions: { ...state.routeOptions, ...(route.options || {}) },
      });
      $("input-speed").value = String(state.routeOptions.speedMps);
      $("input-rate").value = String(state.routeOptions.updateRateHz);
      studioMap.fitRoute(state.route);
      persistWorkspace();
      toast("Route loaded", `${route.name} — ${route.points.length} waypoints`, { kind: "ok" });
    });

    const send = el("button", { className: "btn tiny ghost", text: "→ Send", attrs: { type: "button" } });
    send.addEventListener("click", () => {
      setState({ route: route.points.map((point) => ({ ...point })) });
      setState({ view: "console" });
    });

    const remove = el("button", { className: "btn tiny danger", text: "✕", attrs: { type: "button", title: "Delete" } });
    remove.addEventListener("click", async () => {
      const ok = await confirmAction({
        title: "Delete saved route",
        message: `Remove “${route.name}” from the workspace?`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      setState({ savedRoutes: state.savedRoutes.filter((item) => item.id !== route.id) });
      persistWorkspace();
    });

    host.appendChild(
      el("div", { className: "list-row" }, [
        el("div", { className: "grow" }, [
          el("div", { className: "name", text: route.name }),
          el("div", {
            className: "meta",
            text: `${route.points.length} waypoints · ${fmtDistance(route.lengthM || routeLengthM(route.points))} · ${fmtClock(
              route.durationSeconds || routeLengthM(route.points) / (route.options?.speedMps || 8)
            )}`,
          }),
        ]),
        load,
        send,
        remove,
      ])
    );
  }
}

/* -------------------------------------------------------------- route metrics */

function renderMetrics(metrics) {
  $("metric-waypoints").textContent = String(metrics.waypointCount);
  $("metric-distance").innerHTML = `${fmtDistance(metrics.routeLengthM)}`;
  $("metric-duration").textContent = fmtClock(metrics.estimatedDurationSeconds);
  $("metric-updates").textContent = String(metrics.playbackPointCount);
}

function localMetrics(points) {
  if (!points.length) {
    return { waypointCount: 0, routeLengthM: 0, estimatedDurationSeconds: 0, playbackPointCount: 0, source: "local" };
  }
  const options = routeOptions();
  const playback = points.length > 1 ? waypointsForPlayback(points) : points;
  const length = routeLengthM(points);
  return {
    waypointCount: points.length,
    routeLengthM: length,
    estimatedDurationSeconds: points.length > 1 ? length / Math.max(options.speedMps, 0.01) : 0,
    playbackPointCount: playback.length,
    source: "local",
  };
}

async function refreshMetrics() {
  const points = state.route.map((point) => ({ lat: point.lat, lon: point.lon, ...(point.altitude !== undefined ? { altitude: point.altitude } : {}) }));
  renderMetrics(localMetrics(points));
  if (!bridgeAvailable || points.length < 2) return;
  if (analysing) return;
  const requestSignature = signature({ points, options: routeOptions() });
  if (requestSignature === analysedSignature) return;
  analysing = true;
  try {
    const report = await api.analyzeRoute({ points, options: routeOptions() });
    analysedSignature = requestSignature;
    renderMetrics({ ...report, source: "bridge" });
  } catch (error) {
    // The local numbers are already on screen and are arithmetic, not a guess.
    consoleLog.write("warn", `Route analysis fell back to local maths: ${error.message}`);
  } finally {
    analysing = false;
  }
}

const scheduleMetrics = debounce(() => {
  refreshMetrics().catch(() => {});
}, 180);

/* -------------------------------------------------------------------- search */

async function runSearch() {
  const query = $("input-search").value.trim();
  if (query.length < 3) {
    setHint("search-status", "Type at least three characters.", "bad");
    return;
  }
  setHint("search-status", "Searching OpenStreetMap Nominatim…");
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "6");
    url.searchParams.set("q", query);
    const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Nominatim answered ${response.status}.`);
    const results = await response.json();
    if (!results.length) {
      setHint("search-status", "No place matched that search.", "warn");
      return;
    }
    setHint("search-status", `${results.length} result(s). Click one to move the target pin.`, "ok");
    renderSearchResults(results);
  } catch (error) {
    setHint("search-status", `Search failed: ${error.message}`, "bad");
    consoleLog.write("warn", `Geocoding failed: ${error.message}`);
  }
}

function renderSearchResults(results) {
  if (!searchHost) {
    searchHost = el("div", { className: "list", attrs: { style: "max-height:210px; margin-top:9px;" } });
    $("search-status").parentElement.appendChild(searchHost);
  }
  clear(searchHost);
  for (const result of results) {
    const lat = Number(result.lat);
    const lon = Number(result.lon);
    const row = el("div", { className: "list-row", attrs: { style: "cursor:pointer;" } }, [
      el("div", { className: "grow" }, [
        el("div", { className: "name", text: result.display_name || result.name || "Unnamed place" }),
        el("div", { className: "meta", text: `${fmtCoordPair(lat, lon)} · ${result.type || "place"}` }),
      ]),
    ]);
    row.addEventListener("click", () => {
      applyTarget(lat, lon, { pan: true, source: "search result" });
      setHint("coord-status", "Target set from the search result.", "ok");
      clear(searchHost);
      setHint("search-status", "Target moved. Search again for another place.", "ok");
    });
    searchHost.appendChild(row);
  }
}

/* ------------------------------------------------------------ GPX and saving */

function routeName() {
  const first = state.route[0];
  if (!first) return "Location Studio route";
  return `${state.route.length} waypoints from ${fmtCoord(first.lat, 4)},${fmtCoord(first.lon, 4)}`;
}

async function importGpx() {
  if (!bridgeAvailable) {
    toast("Import unavailable", "GPX import needs the desktop app.", { kind: "error" });
    return;
  }
  try {
    const result = await api.importGpx();
    if (result.canceled) return;
    const parsed = result.parsed;
    const options =
      parsed.geometry === "waypoints"
        ? { ...state.routeOptions, interpolate: false }
        : { ...state.routeOptions };
    setState({ route: parsed.points.map((point) => ({ ...point })), routeOptions: options });
    $("input-speed").value = String(state.routeOptions.speedMps);
    $("input-rate").value = String(state.routeOptions.updateRateHz);
    studioMap.fitRoute(state.route);
    persistWorkspace();
    renderWaypoints();
    scheduleMetrics();
    toast("GPX imported", `${parsed.source}: ${parsed.points.length} points (${parsed.geometry}).`, { kind: "ok" });
    consoleLog.write("info", `Imported ${parsed.source} with ${parsed.points.length} GPX points.`);
  } catch (error) {
    reportError(error, "GPX import");
  }
}

async function exportGpx() {
  if (!bridgeAvailable) {
    toast("Export unavailable", "GPX export needs the desktop app.", { kind: "error" });
    return;
  }
  const points = state.route.length
    ? state.route.map((point) => ({ lat: point.lat, lon: point.lon, ...(point.altitude !== undefined ? { altitude: point.altitude } : {}) }))
    : [{ lat: state.target.lat, lon: state.target.lon, ...(state.target.altitude !== undefined ? { altitude: state.target.altitude } : {}) }];
  try {
    const result = await api.exportGpx({
      points,
      name: routeName(),
      options: routeOptions(),
      speedMps: state.routeOptions.speedMps,
      ...(state.target.altitude !== undefined ? { altitude: state.target.altitude } : {}),
    });
    if (result.canceled) return;
    toast("GPX exported", `${result.pointCount} points · ${result.bytes} bytes\n${result.filePath}`, { kind: "ok" });
    consoleLog.write("info", `Exported GPX with ${result.pointCount} points to ${result.filePath}.`);
  } catch (error) {
    reportError(error, "GPX export");
  }
}

async function saveLocation() {
  const check = readTargetInputs();
  if (!check.ok) {
    setHint("coord-status", check.problems[0], "bad");
    return;
  }
  const suggested = `${fmtCoord(check.target.lat, 4)}, ${fmtCoord(check.target.lon, 4)}`;
  const name = await promptText({
    title: "Save location",
    label: "NAME",
    value: suggested,
    confirmLabel: "Save location",
    hint: "Stored in the local workspace file on this PC.",
  });
  if (!name) return;
  setState({
    savedLocations: [
      ...state.savedLocations,
      {
        id: newId("loc"),
        name,
        lat: check.target.lat,
        lon: check.target.lon,
        ...(check.target.altitude !== undefined ? { altitude: check.target.altitude } : {}),
        savedAt: new Date().toISOString(),
      },
    ],
  });
  persistWorkspace();
  toast("Location saved", name, { kind: "ok" });
}

async function saveRoute() {
  if (state.route.length < 2) {
    toast("Nothing to save", "A route needs at least two waypoints.", { kind: "warn" });
    return;
  }
  const metrics = localMetrics(state.route);
  const name = await promptText({
    title: "Save route",
    label: "ROUTE NAME",
    value: routeName(),
    confirmLabel: "Save route",
    hint: `${metrics.waypointCount} waypoints · ${fmtDistance(metrics.routeLengthM)} · ${fmtClock(metrics.estimatedDurationSeconds)} at ${state.routeOptions.speedMps} m/s`,
  });
  if (!name) return;
  setState({
    savedRoutes: [
      ...state.savedRoutes,
      {
        id: newId("route"),
        name,
        points: state.route.map((point) => ({ ...point })),
        options: routeOptions(),
        lengthM: metrics.routeLengthM,
        durationSeconds: metrics.estimatedDurationSeconds,
        savedAt: new Date().toISOString(),
      },
    ],
  });
  persistWorkspace();
  toast("Route saved", `${name} — ${state.route.length} waypoints`, { kind: "ok" });
}

/* ---------------------------------------------------------------------- init */

function setMapMode() {
  const editing = state.routeEditing;
  $("toggle-route-edit").checked = editing;
  $("map-hint").textContent = editing
    ? "Route editing — click the map to append a waypoint"
    : "Click to move the target pin";
}

export function initMapStudio() {
  if (initialised) return;
  initialised = true;

  studioMap.init("map", {
    lat: state.settings.mapCenter?.lat ?? state.target.lat,
    lon: state.settings.mapCenter?.lon ?? state.target.lon,
    zoom: state.settings.mapCenter?.zoom ?? 12,
  });
  if (state.settings.tileStyle === "osm") studioMap.setTileStyle("osm");

  studioMap.onTargetChange = (lat, lon) => {
    applyTarget(lat, lon, { altitude: state.target.altitude, source: "map drag" });
    setHint("coord-status", "Target moved by dragging the pin.", "ok");
  };

  studioMap.onMapClick = (lat, lon) => {
    if (state.routeEditing) {
      addWaypoint(lat, lon, undefined);
      return;
    }
    applyTarget(lat, lon, { altitude: state.target.altitude, source: "map click" });
    setHint("coord-status", "Target moved from the map.", "ok");
  };

  $("map-center").addEventListener("click", () => {
    studioMap.map.setView([state.target.lat, state.target.lon], Math.max(studioMap.map.getZoom(), 13));
  });
  $("map-fit-route").addEventListener("click", () => {
    if (state.route.length < 2) {
      toast("Nothing to fit", "Add at least two waypoints first.", { kind: "warn" });
      return;
    }
    studioMap.fitRoute(state.route);
  });

  $("btn-apply-coords").addEventListener("click", () => {
    const check = readTargetInputs();
    if (!check.ok) {
      setHint("coord-status", check.problems.join(" "), "bad");
      return;
    }
    applyTarget(check.target.lat, check.target.lon, {
      altitude: check.target.altitude,
      pan: true,
      source: "typed coordinates",
    });
    setHint("coord-status", "Coordinates validated and applied.", "ok");
  });

  for (const id of ["input-lat", "input-lon", "input-alt"]) {
    $(id).addEventListener("keydown", (event) => {
      if (event.key === "Enter") $("btn-apply-coords").click();
    });
  }

  $("btn-save-location").addEventListener("click", () => {
    saveLocation().catch((error) => reportError(error, "Saving location"));
  });

  $("btn-search").addEventListener("click", () => {
    runSearch().catch(() => {});
  });
  $("input-search").addEventListener("keydown", (event) => {
    if (event.key === "Enter") runSearch().catch(() => {});
  });

  $("toggle-route-edit").addEventListener("change", (event) => {
    setState({ routeEditing: event.target.checked });
    setMapMode();
  });

  $("input-speed").addEventListener("change", () => {
    const value = Number($("input-speed").value);
    if (!Number.isFinite(value) || value < 0.1 || value > 400) {
      setHint("coord-status", "Route speed must be between 0.1 and 400 m/s.", "bad");
      $("input-speed").value = String(state.routeOptions.speedMps);
      return;
    }
    setState({ routeOptions: { ...state.routeOptions, speedMps: value } });
    persistWorkspace();
    scheduleMetrics();
  });

  $("input-rate").addEventListener("change", () => {
    const value = Number($("input-rate").value);
    if (!Number.isFinite(value) || value < 0.5 || value > 20) {
      setHint("coord-status", "Update rate must be between 0.5 and 20 Hz.", "bad");
      $("input-rate").value = String(state.routeOptions.updateRateHz);
      return;
    }
    setState({ routeOptions: { ...state.routeOptions, updateRateHz: value } });
    persistWorkspace();
    scheduleMetrics();
  });

  $("btn-import-gpx").addEventListener("click", () => {
    importGpx().catch(() => {});
  });
  $("btn-export-gpx").addEventListener("click", () => {
    exportGpx().catch(() => {});
  });
  $("btn-save-route").addEventListener("click", () => {
    saveRoute().catch((error) => reportError(error, "Saving route"));
  });
  $("btn-clear-route").addEventListener("click", async () => {
    if (!state.route.length) return;
    const ok = await confirmAction({
      title: "Clear route",
      message: `Remove all ${state.route.length} waypoints from the route builder?`,
      confirmLabel: "Clear route",
      danger: true,
      hint: "Saved routes are not affected.",
    });
    if (!ok) return;
    setState({ route: [] });
    persistWorkspace();
  });

  applyTarget(state.target.lat, state.target.lon, {
    altitude: state.target.altitude,
    pan: false,
    source: "workspace",
    quiet: true,
  });
  setMapMode();
  renderLocations();
  renderWaypoints();
  renderSavedRoutes();
  scheduleMetrics();

  subscribe(() => {
    if (!initialised) return;
    renderLocations();
    renderWaypoints();
    renderSavedRoutes();
    setMapMode();
    scheduleMetrics();
  });

  window.addEventListener("resize", () => studioMap.map.invalidateSize());
}
