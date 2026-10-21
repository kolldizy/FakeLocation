/**
 * Location — the destination, the saved places and the waypoint list.
 *
 * Everything in this view is design-time data. Nothing here touches the iPhone; the
 * device-facing operations live in the control dock beside this map and in Routes.
 *
 * Route metrics are requested from the bridge (`route.analyze`) so the numbers the
 * user sees are the same numbers the device playback will use. A local calculation
 * is used as a fallback when the bridge is unavailable, and is labelled as such.
 */

import { api, available as bridgeAvailable } from "./api.js";
import { state, setState, subscribe, newId, persistWorkspace } from "./store.js";
import { studioMap, previewMap } from "./maps.js";
import { promptText, confirmAction } from "./dialog.js";
import { consoleLog, toast, reportError } from "./logpanel.js";
import { navigate } from "./nav.js";
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
  withWaypointMoved,
  withWaypointRemoved,
  withWaypointReordered,
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

/** Shared with Routes: clicking that map while editing appends through this function. */
export function addWaypoint(lat, lon, altitude) {
  const point = { lat, lon, ...(altitude === undefined || altitude === null ? {} : { altitude }) };
  setState({ route: [...state.route, point], selectedWaypoint: state.route.length });
  persistWorkspace();
  setHint("coord-status", `Waypoint ${state.route.length} added at ${fmtCoordPair(lat, lon)}.`, "ok");
}

/** The Editing switch and the two map buttons set the same flag; this is the only writer. */
export function setEditing(editing) {
  setState({ routeEditing: Boolean(editing) });
}

/**
 * Move one waypoint.
 *
 * Dragging a marker is the only way to edit a coordinate in place, and it has to write
 * back through here so the list, the metrics, the polyline and the preview all follow
 * the same state object rather than a copy.
 */
export function updateWaypoint(index, lat, lon) {
  const current = state.route[index];
  if (!current) return;
  if (current.lat === lat && current.lon === lon) return;
  const next = withWaypointMoved(state.route, index, lat, lon);
  setState({ route: next, selectedWaypoint: index });
  persistWorkspace();
  setHint("coord-status", `Waypoint ${index + 1} moved to ${fmtCoordPair(lat, lon)}.`, "ok");
}

/** Selecting is a shared act: the marker ring, the list row and the map centre agree on it. */
export function selectWaypoint(index, { focus = true } = {}) {
  const clamped = index >= 0 && index < state.route.length ? index : -1;
  setState({ selectedWaypoint: clamped });
  if (clamped < 0 || !focus) return;
  const point = state.route[clamped];
  studioMap.focusWaypoint(point);
  // Routes shows the same route on its own map. Moving that view too costs no device
  // traffic and keeps the two surfaces describing one plan, but only when it exists.
  if (previewMap.map) previewMap.focusWaypoint(point);
}

/** The ⊙ tool does the same act as clicking a row: find the waypoint the user picked. */
export function selectedWaypointPoint() {
  if (state.selectedWaypoint < 0 || state.selectedWaypoint >= state.route.length) return null;
  return state.route[state.selectedWaypoint];
}

function focusSelectedOnStudioMap() {
  const point = selectedWaypointPoint();
  if (!point) {
    toast("No waypoint selected", "Click a numbered marker or a row in the Waypoints list first.", { kind: "warn" });
    return;
  }
  studioMap.focusWaypoint(point);
}

function removeWaypoint(index) {
  const route = withWaypointRemoved(state.route, index);
  if (route.length === state.route.length) return;
  setState({ route, selectedWaypoint: -1 });
  persistWorkspace();
  setHint("coord-status", `Waypoint ${index + 1} removed. ${route.length} left.`, "ok");
}

function moveWaypoint(index, direction) {
  const next = withWaypointReordered(state.route, index, direction);
  if (next === state.route) return;
  setState({ route: next, selectedWaypoint: index + direction });
  persistWorkspace();
}

function waypointRow(point, index) {
  const selected = state.selectedWaypoint === index;

  const up = el("button", { className: "btn tiny ghost", text: "↑", attrs: { type: "button", title: "Move earlier" } });
  up.disabled = index === 0;
  up.addEventListener("click", (event) => {
    event.stopPropagation();
    moveWaypoint(index, -1);
  });

  const down = el("button", { className: "btn tiny ghost", text: "↓", attrs: { type: "button", title: "Move later" } });
  down.disabled = index === state.route.length - 1;
  down.addEventListener("click", (event) => {
    event.stopPropagation();
    moveWaypoint(index, 1);
  });

  const remove = el("button", { className: "btn tiny danger", text: "✕", attrs: { type: "button", title: "Remove this waypoint" } });
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    removeWaypoint(index);
  });

  const row = el("div", { className: `list-row selectable${selected ? " selected" : ""}`, attrs: { role: "button", tabindex: "0" } }, [
    el("div", {
      className: "wp-number",
      text: String(index + 1),
      attrs: { title: "Route order" },
    }),
    el("div", { className: "grow" }, [
      el("div", { className: "name", text: fmtCoordPair(point.lat, point.lon) }),
      el("div", {
        className: "meta",
        text: point.altitude !== undefined ? `altitude ${point.altitude} m (metadata only)` : "no altitude recorded",
      }),
    ]),
    remove,
    up,
    down,
  ]);

  // The row is the keyboard-reachable way to find a waypoint on the map.
  row.addEventListener("click", () => selectWaypoint(index));
  row.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    selectWaypoint(index);
  });

  return row;
}

function renderWaypoints() {
  const nextSignature = signature({ route: state.route, selected: state.selectedWaypoint });
  if (nextSignature === routeSignature) return;
  routeSignature = nextSignature;

  const host = $("waypoint-list");
  clear(host);
  $("route-count").textContent = `${state.route.length} WAYPOINT${state.route.length === 1 ? "" : "S"}`;
  if (!state.route.length) {
    host.appendChild(
      el("div", { className: "empty", html: "<b>No waypoints yet.</b> Press <b>+ Add target pin</b>, or turn on <b>Edit Route</b> and click either map." })
    );
    studioMap.redrawRoute(state.route, -1);
    return;
  }
  state.route.forEach((point, index) => host.appendChild(waypointRow(point, index)));
  studioMap.redrawRoute(state.route, state.selectedWaypoint);
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

    // Loading a saved route is still a design-time act: the phone is only asked to
    // follow it after the user presses the labelled button in the Routes toolbar.
    const send = el("button", { className: "btn tiny ghost", text: "→ Send", attrs: { type: "button", title: "Put this route in the editor and open Routes" } });
    send.addEventListener("click", () => {
      setState({
        route: route.points.map((point) => ({ ...point })),
        routeOptions: { ...state.routeOptions, ...(route.options || {}) },
      });
      persistWorkspace();
      navigate("motion");
      toast("Route ready", `${route.name} is loaded. Press “▶ Device route” to start it on the iPhone.`, { kind: "ok" });
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
    setState({ route: parsed.points.map((point) => ({ ...point })), routeOptions: options, selectedWaypoint: -1 });
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
  const editing = Boolean(state.routeEditing);

  const switchInput = $("toggle-route-edit");
  if (switchInput.checked !== editing) switchInput.checked = editing;

  for (const id of ["btn-edit-route-map", "btn-edit-route-preview"]) {
    const button = $(id);
    if (!button) continue;
    button.setAttribute("aria-pressed", String(editing));
    button.classList.toggle("active", editing);
  }

  // Both maps need to say, before the click happens, what the click will do.
  $("map-hint").textContent = editing
    ? "EDIT ROUTE ON · A CLICK HERE APPENDS A WAYPOINT"
    : "EDIT ROUTE OFF · A CLICK HERE MOVES THE TARGET PIN";
  $("map-hint").className = editing ? "chip warn" : "chip";

  const help = $("waypoint-help");
  if (help) {
    help.textContent = editing
      ? "Editing is on: a click on either map appends a waypoint at the clicked coordinates. Drag a numbered marker to move one; its number is its place in the route."
      : "Editing is off: map clicks pan or move the target pin. Turn on Edit Route to place waypoints by clicking.";
  }

  studioMap.setEditStyle(editing);
  if (previewMap.map) previewMap.setEditStyle(editing);
}

export function initMapStudio() {
  if (initialised) return;
  initialised = true;

  studioMap.init("map", {
    lat: state.settings.mapCenter?.lat ?? state.target.lat,
    lon: state.settings.mapCenter?.lon ?? state.target.lon,
    zoom: state.settings.mapCenter?.zoom ?? 12,
  });
  studioMap.setTileStyle(state.settings.tileStyle === "osm" ? "osm" : "dark");

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

  // Dragging a marker is the in-place coordinate editor. Writing through the store is
  // what makes the list, the metrics, the polyline and the Routes preview follow it.
  studioMap.onWaypointDrag = (index, lat, lon) => updateWaypoint(index, lat, lon);
  studioMap.onWaypointSelect = (index) => selectWaypoint(index, { focus: false });

  $("map-center").addEventListener("click", () => {
    studioMap.map.setView([state.target.lat, state.target.lon], Math.max(studioMap.map.getZoom(), 13));
  });
  $("map-focus-selected").addEventListener("click", () => focusSelectedOnStudioMap());
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

  $("toggle-route-edit").addEventListener("change", (event) => setEditing(event.target.checked));
  for (const id of ["btn-edit-route-map", "btn-edit-route-preview"]) {
    $(id).addEventListener("click", () => setEditing(!state.routeEditing));
  }

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
    setState({ route: [], selectedWaypoint: -1 });
    persistWorkspace();
  });

  // Appending the destination is the keyboard-reachable alternative to clicking a map;
  // the button sits beside the waypoint list, but the waypoint state is owned here.
  $("btn-add-waypoint").addEventListener("click", () => {
    addWaypoint(state.target.lat, state.target.lon, state.target.altitude);
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
}
