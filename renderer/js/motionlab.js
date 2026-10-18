/**
 * Motion Lab — host-side preview and the hand-off to the real device.
 *
 * The preview animation is generated entirely in this window and is labelled as
 * such everywhere it appears. It never reports device state. The "Send to device"
 * panel is the only part of this view that talks to the iPhone, and its banner is
 * rendered from the bridge's reported session alone.
 */

import { api, available as bridgeAvailable } from "./api.js";
import { state, setState, subscribe, refreshSession } from "./store.js";
import { previewMap } from "./maps.js";
import { runDiscovery } from "./devicecenter.js";
import { consoleLog, toast, reportError } from "./logpanel.js";
import { $, el, clear, fmtCoord, fmtCoordPair, fmtClock, fmtDistance, densify, cumulativeLengths, clamp, haversineM } from "./util.js";

const PREVIEW_MAX_TRAIL_MS = 240;

const preview = {
  points: [],
  lengths: [],
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

/* --------------------------------------------------------------- path helpers */

function illustrativePath(target) {
  // A small diamond so the preview has something to animate before a route exists.
  const metres = 140;
  const dLat = metres / 111320;
  const dLon = metres / (111320 * Math.max(0.2, Math.cos((target.lat * Math.PI) / 180)));
  return [
    { lat: target.lat, lon: target.lon },
    { lat: target.lat + dLat, lon: target.lon },
    { lat: target.lat + dLat, lon: target.lon + dLon },
    { lat: target.lat, lon: target.lon + dLon },
    { lat: target.lat, lon: target.lon },
  ];
}

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

function updateMetrics() {
  const total = preview.total;
  const progress = total > 0 ? clamp(preview.distance / total, 0, 1) : 0;
  const elapsed = preview.speed > 0 ? preview.distance / preview.speed : 0;
  const remaining = preview.speed > 0 ? Math.max(0, total - preview.distance) / preview.speed : 0;
  $("preview-progress").innerHTML = `${(progress * 100).toFixed(0)}<small>%</small>`;
  $("preview-elapsed").textContent = fmtClock(elapsed);
  $("preview-remaining").textContent = fmtClock(remaining);
  $("preview-speed").innerHTML = `${preview.speed.toFixed(1)} <small>m/s</small>`;
  $("preview-progress-bar").style.width = `${(progress * 100).toFixed(2)}%`;
}

function rebuildPreview() {
  const waypoints = state.route.length >= 2 ? state.route : illustrativePath(state.target);
  preview.speed = Math.max(0.1, state.routeOptions.speedMps || 8);
  preview.points = densify(waypoints, 3);
  preview.lengths = cumulativeLengths(preview.points);
  preview.total = preview.lengths[preview.lengths.length - 1] || 0;
  preview.distance = 0;
  preview.completed = false;

  previewMap.setRoute(waypoints);
  previewMap.clearTrail();
  previewMap.setMarker(preview.points[0] || null);
  previewMap.fit(waypoints);
  previewMap.invalidate();

  $("preview-note").textContent =
    state.route.length >= 2
      ? `Preview follows the ${state.route.length} route waypoints, densified for smooth animation. The device receives ${state.routeOptions.updateRateHz} updates/s at ${state.routeOptions.speedMps} m/s.`
      : "With fewer than two waypoints the preview generates an illustrative diamond around the target pin. Add waypoints in Map Studio for a real route.";
  setPreviewState("idle", "IDLE");
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
      setPreviewState("completed", "COMPLETED");
      $("btn-preview-play").textContent = "▶ Replay";
      $("btn-preview-pause").disabled = true;
      $("btn-preview-pause").textContent = "Ⅱ Pause";
      preview.paused = false;
      return;
    }
  }

  preview.handle = requestAnimationFrame(frame);
}

function playPreview() {
  if (preview.completed || !preview.points.length) {
    const wasCompleted = preview.completed;
    rebuildPreview();
    if (wasCompleted) previewMap.fit(preview.points);
  }
  preview.playing = true;
  preview.paused = false;
  preview.lastFrame = 0;
  setPreviewState("active", "PREVIEW RUNNING");
  $("btn-preview-play").textContent = "▶ Running";
  $("btn-preview-pause").disabled = false;
  $("btn-preview-pause").textContent = "Ⅱ Pause";
  if (preview.handle === null) preview.handle = requestAnimationFrame(frame);
}

function pausePreview() {
  if (!preview.playing) return;
  preview.paused = !preview.paused;
  if (preview.paused) {
    setPreviewState("paused", "PREVIEW PAUSED");
    $("btn-preview-pause").textContent = "▶ Continue";
  } else {
    setPreviewState("active", "PREVIEW RUNNING");
    $("btn-preview-pause").textContent = "Ⅱ Pause";
    preview.lastFrame = 0;
  }
}

function resetPreview() {
  preview.playing = false;
  preview.paused = false;
  stopFrameLoop();
  rebuildPreview();
  $("btn-preview-play").textContent = "▶ Start";
  $("btn-preview-pause").disabled = true;
  $("btn-preview-pause").textContent = "Ⅱ Pause";
}

/* -------------------------------------------------------------------- timeline */

function renderTimeline() {
  const nextSignature = JSON.stringify({ route: state.route, speed: state.routeOptions.speedMps });
  if (nextSignature === timelineSignature) return;
  timelineSignature = nextSignature;

  const host = $("timeline-list");
  clear(host);
  $("timeline-count").textContent = `${state.route.length} WAYPOINT${state.route.length === 1 ? "" : "S"}`;

  if (!state.route.length) {
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
      : "No simulation is running. Select a device in Device Center first.";
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
  $("btn-send-route").disabled = busy || state.route.length < 2 || !deviceIdForActions();
  $("btn-send-point").disabled = busy || !deviceIdForActions();
  $("btn-device-stop").disabled = !session || ["stopped", "failed", "disconnected"].includes(session.state);
}

function setSendStatus(text, kind = "") {
  const node = $("motion-send-status");
  node.textContent = text;
  node.className = `hint${kind ? ` ${kind}` : ""}`;
}

async function sendRoute() {
  const deviceId = deviceIdForActions();
  if (!deviceId) {
    toast("No device selected", "Open Device Center and pick an iPhone first.", { kind: "warn" });
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
  const deviceId = deviceIdForActions();
  if (!deviceId) {
    toast("No device selected", "Open Device Center and pick an iPhone first.", { kind: "warn" });
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
  rebuildPreview();
  renderTimeline();
  renderDeviceBanner();
  setSendStatus(
    bridgeAvailable
      ? "Select a device in Device Center or the Simulation Console first."
      : "This window is running outside the desktop shell, so device operations are unavailable."
  );

  subscribe(() => {
    if (!initialised) return;
    renderTimeline();
    renderDeviceBanner();
  });

  window.addEventListener("resize", () => previewMap.invalidate());
}
