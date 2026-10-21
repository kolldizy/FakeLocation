/**
 * Routes — the waypoint preview and the hand-off to the real device.
 *
 * The preview animation is generated entirely in this window and is labelled as such
 * everywhere it appears. It never reports device state. The two buttons under "IPHONE"
 * are the only part of this view that talks to the phone, and the banner above them is
 * rendered from the bridge's reported session alone.
 */

import { api, available as bridgeAvailable } from "./api.js";
import { state, setState, subscribe, refreshSession } from "./store.js";
import { previewMap } from "./maps.js";
import { runDiscovery } from "./devicecenter.js";
import { addWaypoint, updateWaypoint, selectWaypoint, selectedWaypointPoint } from "./mapstudio.js";
import { consoleLog, toast, reportError } from "./logpanel.js";
import { $, el, clear, fmtCoord, fmtCoordPair, fmtClock, fmtDistance, densify, cumulativeLengths, clamp, haversineM, waypointIndexAtDistance } from "./util.js";

const PREVIEW_MAX_TRAIL_MS = 240;

const preview = {
  points: [],
  lengths: [],
  /** The waypoints this path was built from, kept so "next waypoint" is truthful. */
  waypoints: [],
  total: 0,
  distance: 0,
  speed: 8,
  multiplier: 1,
  playing: false,
  paused: false,
  completed: false,
  handle: null,
  lastFrame: 0,
  lastTrail: 0,
};

let initialised = false;
let timelineSignature = "";
/** Signature of the path the preview map currently draws. */
let builtSignature = "";

/** Everything the drawn path and the animation depend on. */
function geometrySignature() {
  return JSON.stringify({
    route: state.route,
    selected: state.selectedWaypoint,
    target: state.target,
    speed: state.routeOptions.speedMps,
    rate: state.routeOptions.updateRateHz,
  });
}

/* --------------------------------------------------------------- path helpers */

function positionAt(distance) {
  const { points, lengths, total } = preview;
  if (!points.length) return null;
  if (distance <= 0) return points[0];
  if (distance >= total) return points[points.length - 1];

  let low = 0;
  let high = lengths.length - 1;
  while (low < high - 1) {
    const middle = Math.floor((low + high) / 2);
    if (lengths[middle] <= distance) low = middle;
    else high = middle;
  }
  const start = points[low];
  const end = points[Math.min(low + 1, points.length - 1)];
  const segment = lengths[Math.min(low + 1, lengths.length - 1)] - lengths[low];
  const fraction = segment > 0 ? clamp((distance - lengths[low]) / segment, 0, 1) : 0;
  return { lat: start.lat + (end.lat - start.lat) * fraction, lon: start.lon + (end.lon - start.lon) * fraction };
}

/* ------------------------------------------------------------- preview engine */

function setPreviewState(kind, label) {
  const tag = $("preview-state");
  tag.className = kind === "active" ? "tag green" : kind === "paused" ? "tag amber" : kind === "completed" ? "tag cyan" : "tag violet";
  tag.textContent = label;
}

/** What clicking this map will do — the same promise the editing switch makes. */
function renderEditingHint() {
  const host = $("preview-hint");
  if (!host) return;
  host.textContent = state.routeEditing
    ? "EDITING · A CLICK HERE APPENDS A WAYPOINT"
    : "MAP PREVIEW ONLY · CLICKS PAN, NOTHING HERE TOUCHES THE IPHONE";
  host.className = state.routeEditing ? "chip warn" : "chip";
}

/**
 * The next waypoint the animation has still to pass.
 *
 * Counted against the waypoints the user entered, not the densified frames, so the
 * number matches the list in the dock.
 */
function renderNextWaypoint() {
  const host = $("preview-next");
  const waypoints = preview.waypoints;
  if (!host) return;
  // This cell answers a question about the user's waypoints, so with no route it shows
  // a dash rather than a "2/5" read off a path that does not exist.
  if (state.route.length < 2 || waypoints.length < 2) {
    host.textContent = "—";
    return;
  }
  const lengths = cumulativeLengths(waypoints);
  const total = lengths[lengths.length - 1] || 0;
  if (preview.distance >= total) {
    host.textContent = `LAST · ${waypoints.length}`;
    return;
  }
  const index = waypointIndexAtDistance(waypoints, preview.distance);
  host.textContent = `${index + 2}/${waypoints.length}`;
}

function updateMetrics() {
  const total = preview.total;
  const progress = total > 0 ? clamp(preview.distance / total, 0, 1) : 0;
  const elapsed = preview.speed > 0 ? preview.distance / preview.speed : 0;
  const remaining = preview.speed > 0 ? Math.max(0, total - preview.distance) / preview.speed : 0;
  $("preview-progress").innerHTML = `${(progress * 100).toFixed(0)}<small>%</small>`;
  $("preview-elapsed").textContent = fmtClock(elapsed);
  $("preview-remaining").textContent = fmtClock(remaining);
  $("preview-progress-bar").style.width = `${(progress * 100).toFixed(2)}%`;
  renderNextWaypoint();
}

/**
 * Play, pause, reset, the state tag and the note, all derived from two facts: how many
 * waypoints exist and whether an animation is running.
 *
 * A route with fewer than two waypoints cannot play, so the Play button is disabled and
 * the tag says NO ROUTE. The preview used to animate a generated diamond instead.
 */
function renderPlaybackControls() {
  const playable = state.route.length >= 2;
  const play = $("btn-preview-play");
  const pause = $("btn-preview-pause");
  const reset = $("btn-preview-reset");

  play.disabled = !playable || (preview.playing && !preview.paused);
  play.textContent = preview.completed
    ? "▶ Replay"
    : preview.playing && !preview.paused
      ? "▶ Running"
      : preview.paused
        ? "▶ Continue"
        : "▶ Play";
  pause.disabled = !preview.playing;
  pause.textContent = preview.paused ? "▶ Continue" : "Ⅱ Pause";
  reset.disabled = !preview.playing && !preview.completed && preview.distance === 0;

  if (!playable) setPreviewState("idle", "NO ROUTE");
  else if (preview.playing) setPreviewState(preview.paused ? "paused" : "active", preview.paused ? "PREVIEW PAUSED" : "PREVIEW RUNNING");
  else if (preview.completed) setPreviewState("completed", "COMPLETED");
  else setPreviewState("idle", "IDLE");

  $("preview-speed").innerHTML = preview.playing && !preview.paused
    ? `${preview.speed.toFixed(1)} <small>m/s</small>`
    : `0.0 <small>m/s</small>`;

  $("preview-note").textContent = playable
    ? `Preview follows the ${state.route.length} waypoints, densified for smooth animation. The device would receive ${state.routeOptions.updateRateHz} updates/s at ${state.routeOptions.speedMps} m/s — nothing is sent until you press “▶ Device route”.`
    : state.route.length === 1
      ? "One waypoint is a position, not a route. Add a second one: turn on Edit Route and click this map, or press + Add target pin."
      : "No waypoints yet, so there is nothing to preview. Turn on Edit Route and click this map, or press + Add target pin in the Waypoints panel.";
}

function rebuildPreview({ refit = false, keepProgress = false } = {}) {
  const fraction = keepProgress && preview.total > 0 ? clamp(preview.distance / preview.total, 0, 1) : 0;
  // The path is the waypoint list. Nothing is invented when the list is short: an empty
  // plan has to look empty, which is what this view used to get wrong.
  const waypoints = state.route.length >= 2 ? state.route.map((point) => ({ ...point })) : [];

  preview.speed = Math.max(0.1, state.routeOptions.speedMps || 8);
  preview.waypoints = waypoints;
  preview.points = waypoints.length ? densify(waypoints, 3) : [];
  preview.lengths = cumulativeLengths(preview.points);
  preview.total = preview.lengths[preview.lengths.length - 1] || 0;
  preview.distance = preview.total * fraction;
  preview.completed = false;

  previewMap.setRoute(state.route, { selected: state.selectedWaypoint });
  previewMap.clearTrail();
  const position = positionAt(preview.distance);
  if (position) previewMap.setMarker(position);
  if (refit) previewMap.fit(state.route);
  previewMap.invalidate();

  renderPlaybackControls();
  updateMetrics();
}

function stopFrameLoop() {
  if (preview.handle !== null) {
    cancelAnimationFrame(preview.handle);
    preview.handle = null;
  }
}

function frame(now) {
  preview.handle = null;
  if (!preview.playing) return;
  if (!preview.lastFrame) preview.lastFrame = now;
  const deltaSeconds = Math.min(0.25, Math.max(0, (now - preview.lastFrame) / 1000));
  preview.lastFrame = now;

  if (!preview.paused) {
    preview.distance = Math.min(preview.total, preview.distance + deltaSeconds * preview.multiplier * preview.speed);
    const position = positionAt(preview.distance);
    if (position) previewMap.setMarker(position);
    if (now - preview.lastTrail > PREVIEW_MAX_TRAIL_MS && position) {
      preview.lastTrail = now;
      previewMap.pushTrail(position);
    }
    updateMetrics();
    if (preview.distance >= preview.total && preview.total > 0) {
      preview.playing = false;
      preview.completed = true;
      renderPlaybackControls();
      return;
    }
  }

  preview.handle = requestAnimationFrame(frame);
}

function playPreview() {
  if (state.route.length < 2) return;
  // A finished or empty run replays from the top, framing the whole route again.
  if (preview.completed || !preview.points.length) rebuildPreview({ refit: preview.completed });
  preview.playing = true;
  preview.paused = false;
  preview.completed = false;
  preview.lastFrame = 0;
  renderPlaybackControls();
  if (preview.handle === null) preview.handle = requestAnimationFrame(frame);
}

function pausePreview() {
  if (!preview.playing) return;
  preview.paused = !preview.paused;
  if (!preview.paused) preview.lastFrame = 0;
  renderPlaybackControls();
}

function resetPreview() {
  preview.playing = false;
  preview.paused = false;
  preview.completed = false;
  stopFrameLoop();
  rebuildPreview({ refit: state.route.length >= 2 });
}

/* -------------------------------------------------------------------- timeline */

function renderTimeline() {
  const nextSignature = JSON.stringify({ route: state.route, speed: state.routeOptions.speedMps });
  if (nextSignature === timelineSignature) return;
  timelineSignature = nextSignature;

  const host = $("timeline-list");
  clear(host);

  if (!state.route.length) {
    $("timeline-count").textContent = "DISTANCE + ETA";
    host.appendChild(el("div", { className: "empty", text: "No waypoints yet." }));
    return;
  }

  let travelled = 0;
  state.route.forEach((point, index) => {
    if (index > 0) travelled += haversineM(state.route[index - 1], point);
    const eta = state.routeOptions.speedMps > 0 ? travelled / state.routeOptions.speedMps : 0;
    host.appendChild(
      el("div", { className: "list-row" }, [
        el("div", { className: "grow" }, [
          el("div", { className: "name", text: `${String(index + 1).padStart(2, "0")} · ${fmtCoordPair(point.lat, point.lon)}` }),
          el("div", {
            className: "meta",
            text: `+${fmtDistance(travelled)} · ETA ${fmtClock(eta)}${point.altitude !== undefined ? ` · alt ${point.altitude} m` : ""}`,
          }),
        ]),
      ])
    );
  });

  const last = state.route[state.route.length - 1];
  const eta = state.routeOptions.speedMps > 0 ? travelled / state.routeOptions.speedMps : 0;
  $("timeline-count").textContent = `${state.route.length} STOPS · ${fmtDistance(travelled)}`;
  host.appendChild(
    el("div", { className: "hint", attrs: { style: "padding:2px 2px 0;" }, text: `Route end: ${fmtCoord(last.lat, 5)}, ${fmtCoord(last.lon, 5)} — total ${fmtDistance(travelled)} in ${fmtClock(eta)}.` })
  );
}

/* ------------------------------------------------------------- device hand-off */

function sessionIsLive(session) {
  return Boolean(session) && ["preparing", "active", "paused"].includes(session.state);
}

function deviceIdForActions() {
  return state.selectedDeviceId;
}

/**
 * A readiness report that came back negative is a fact about the selected device, not a
 * suggestion. Until it is re-run and passes, the two iPhone buttons stay disabled —
 * coordinates are never sent to a device the bridge has said is not ready.
 */
function readinessBlocked() {
  const report = state.readiness;
  if (!report || report.ready !== false) return false;
  return !report.deviceId || report.deviceId === state.selectedDeviceId;
}

function renderDeviceBanner() {
  const session = state.session;
  const banner = $("motion-device-banner");
  const title = $("motion-device-title");
  const sub = $("motion-device-sub");
  const device = state.devices.find((entry) => entry.deviceId === (session?.deviceId || state.selectedDeviceId));

  if (!session) {
    banner.setAttribute("data-state", "idle");
    title.textContent = "Device simulation idle";
    sub.textContent = device
      ? `No simulation is running. Target device: ${device.identity?.deviceName || device.deviceId}.`
      : "No simulation is running. Select a device in the Device workspace first.";
  } else {
    banner.setAttribute("data-state", session.state);
    const label = session.mode === "route" ? "route playback" : "fixed coordinate";
    title.textContent = `Device simulation ${session.state} — ${label}`;
    const parts = [
      `${session.publishedPointCount} update(s) published`,
      session.current ? `target ${fmtCoordPair(session.current.lat, session.current.lon)}` : null,
      session.deviceAcknowledged ? "device acknowledged every update" : "device acknowledgement not available on this transport",
      session.error ? `error: ${session.error.message}` : null,
    ].filter(Boolean);
    sub.textContent = parts.join(" · ");
  }

  const busy = sessionIsLive(session);
  const blocked = !bridgeAvailable || readinessBlocked();
  $("btn-send-route").disabled = busy || blocked || state.route.length < 2 || !deviceIdForActions();
  $("btn-send-point").disabled = busy || blocked || !deviceIdForActions();
  $("btn-device-stop").disabled = !session || ["stopped", "failed", "disconnected"].includes(session.state);
}

function setSendStatus(text, kind = "") {
  const node = $("motion-send-status");
  node.textContent = text;
  node.className = `hint${kind ? ` ${kind}` : ""}`;
}

async function sendRoute() {
  if (!bridgeAvailable) {
    toast("No desktop bridge", "Device operations need the desktop app.", { kind: "error" });
    return;
  }
  if (readinessBlocked()) {
    toast("The last readiness check failed", "Open the Device workspace, fix the reported step and check again before sending coordinates.", { kind: "warn" });
    return;
  }
  const deviceId = deviceIdForActions();
  if (!deviceId) {
    toast("No device selected", "Open the Device workspace and pick an iPhone first.", { kind: "warn" });
    return;
  }
  if (state.route.length < 2) {
    toast("Route too short", "A device route needs at least two waypoints.", { kind: "warn" });
    return;
  }
  const points = state.route.map((point) => ({
    lat: point.lat,
    lon: point.lon,
    ...(point.altitude !== undefined ? { altitude: point.altitude } : {}),
  }));

  setSendStatus("Starting route playback on the device…");
  $("btn-send-route").disabled = true;
  try {
    const snapshot = await api.startRouteSimulation({
      deviceId,
      points,
      options: {
        speedMps: state.routeOptions.speedMps,
        updateRateHz: state.routeOptions.updateRateHz,
        interpolate: state.routeOptions.interpolate,
        loop: state.routeOptions.loop,
      },
    });
    setState({ session: snapshot });
    consoleLog.write("ok", `Route playback started on ${deviceId}: ${snapshot.totalPoints} updates queued.`);
    setSendStatus(
      snapshot.deviceAcknowledged
        ? `Device accepted the first update (${snapshot.totalPoints} updates queued).`
        : "Route started on the legacy transport; the device does not acknowledge individual writes.",
      "ok"
    );
    toast("Simulation started", `Route playback is running for ${points.length} waypoints.`, { kind: "ok" });
    await runDiscovery({ deep: false });
    await refreshSession().catch(() => {});
  } catch (error) {
    reportError(error, "Starting route playback");
    setSendStatus(error.message, "bad");
  } finally {
    renderDeviceBanner();
  }
}

async function sendPoint() {
  if (!bridgeAvailable) {
    toast("No desktop bridge", "Device operations need the desktop app.", { kind: "error" });
    return;
  }
  if (readinessBlocked()) {
    toast("The last readiness check failed", "Open the Device workspace, fix the reported step and check again before sending coordinates.", { kind: "warn" });
    return;
  }
  const deviceId = deviceIdForActions();
  if (!deviceId) {
    toast("No device selected", "Open the Device workspace and pick an iPhone first.", { kind: "warn" });
    return;
  }
  const coordinate = {
    lat: state.target.lat,
    lon: state.target.lon,
    ...(state.target.altitude !== undefined ? { altitude: state.target.altitude } : {}),
  };
  setSendStatus("Sending the target pin to the device…");
  $("btn-send-point").disabled = true;
  try {
    const snapshot = await api.startSimulation({ deviceId, coordinate });
    setState({ session: snapshot });
    consoleLog.write("ok", `Fixed coordinate applied on ${deviceId}: ${fmtCoordPair(coordinate.lat, coordinate.lon)}.`);
    setSendStatus("The device acknowledged the coordinate and is holding it.", "ok");
    toast("Location applied", "The iPhone is now reporting the target coordinate.", { kind: "ok" });
    await runDiscovery({ deep: false });
    await refreshSession().catch(() => {});
  } catch (error) {
    reportError(error, "Sending the target coordinate");
    setSendStatus(error.message, "bad");
  } finally {
    renderDeviceBanner();
  }
}

async function stopDevice() {
  const deviceId = deviceIdForActions();
  setSendStatus("Sending the clear command…");
  try {
    const snapshot = await api.stopSimulation(deviceId ? { deviceId } : {});
    setState({ session: snapshot });
    consoleLog.write("ok", "Stop sent; the device was released back to its real GPS.");
    setSendStatus("Stopped. The iPhone is back on its own positioning.", "ok");
    toast("Simulation stopped", "The location override was cleared.", { kind: "ok" });
    await refreshSession().catch(() => {});
  } catch (error) {
    reportError(error, "Stopping the device simulation");
    setSendStatus(error.message, "bad");
  } finally {
    renderDeviceBanner();
  }
}

/* ------------------------------------------------------------------------ init */

export function initMotionLab() {
  if (initialised) return;
  initialised = true;

  previewMap.init("preview-map", { lat: state.target.lat, lon: state.target.lon, zoom: 13 });
  previewMap.setTileStyle(state.settings.tileStyle === "osm" ? "osm" : "dark");

  // The editing switch and the Edit Route button beside this map set one shared flag, so
  // a click here either appends a waypoint or does nothing but pan — the hint chip says
  // which before the user commits to the click.
  previewMap.onMapClick = (lat, lon) => {
    if (!state.routeEditing) return;
    addWaypoint(lat, lon, undefined);
  };
  previewMap.onWaypointDrag = (index, lat, lon) => updateWaypoint(index, lat, lon);
  previewMap.onWaypointSelect = (index) => selectWaypoint(index, { focus: false });

  $("preview-add-centre").addEventListener("click", () => {
    const centre = previewMap.map.getCenter();
    // addWaypoint already selects the point it appends, so the new marker is the ringed one.
    addWaypoint(centre.lat, centre.lng, undefined);
  });
  $("preview-focus-selected").addEventListener("click", () => {
    const point = selectedWaypointPoint();
    if (!point) {
      toast("No waypoint selected", "Click a numbered marker or a row in the Waypoints list first.", { kind: "warn" });
      return;
    }
    previewMap.focusWaypoint(point);
  });
  $("preview-fit-route").addEventListener("click", () => {
    if (state.route.length < 2) {
      toast("Nothing to fit", "Add at least two waypoints first.", { kind: "warn" });
      return;
    }
    previewMap.fit(state.route);
  });

  $("range-speed").addEventListener("input", (event) => {
    preview.multiplier = Number(event.target.value) || 1;
    $("label-speed").textContent = `${preview.multiplier.toFixed(2)}×`;
  });

  $("btn-preview-play").addEventListener("click", playPreview);
  $("btn-preview-pause").addEventListener("click", pausePreview);
  $("btn-preview-reset").addEventListener("click", resetPreview);

  $("btn-send-route").addEventListener("click", () => {
    sendRoute().catch(() => {});
  });
  $("btn-send-point").addEventListener("click", () => {
    sendPoint().catch(() => {});
  });
  $("btn-device-stop").addEventListener("click", () => {
    stopDevice().catch(() => {});
  });

  $("label-speed").textContent = "1.00×";
  rebuildPreview({ refit: state.route.length >= 2 });
  builtSignature = geometrySignature();
  renderTimeline();
  renderDeviceBanner();
  renderEditingHint();
  setSendStatus(
    bridgeAvailable
      ? "Select a device in Device first; the two iPhone buttons stay disabled until one is ready."
      : "This window is running outside the desktop shell, so device operations are unavailable."
  );

  subscribe(() => {
    if (!initialised) return;
    renderTimeline();
    renderDeviceBanner();
    const style = state.settings.tileStyle === "osm" ? "osm" : "dark";
    if (style !== previewMap.tileStyle) previewMap.setTileStyle(style);
    renderEditingHint();
    // Waypoints are edited from the dock beside this map and by dragging either marker,
    // so the drawn path has to follow them. A run in progress keeps its place as a
    // fraction of the new path instead of snapping back to the start.
    const signature = geometrySignature();
    if (signature === builtSignature) return;
    builtSignature = signature;
    if (state.route.length < 2 && (preview.playing || preview.completed)) {
      preview.playing = false;
      preview.paused = false;
      preview.completed = false;
      stopFrameLoop();
    }
    rebuildPreview({ keepProgress: preview.playing });
  });
}
