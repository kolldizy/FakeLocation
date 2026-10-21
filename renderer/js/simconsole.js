/**
 * Simulation Console — the only place that reports real device state.
 *
 * The banner, transport tag and acknowledgement tag are rendered exclusively from
 * the session snapshot the bridge returns. If the bridge has not confirmed a step,
 * the console says so; there is no optimistic "active" state anywhere in this file.
 */

import { api, available as bridgeAvailable } from "./api.js";
import { state, setState, subscribe, refreshSession, persistWorkspace } from "./store.js";
import { consoleLog, toast, reportError } from "./logpanel.js";
import { confirmAction } from "./dialog.js";
import { runDiscovery } from "./devicecenter.js";
import { $, el, clear, fmtCoordPair, fmtClock, fmtDistance, fmtTimestamp } from "./util.js";

const LIVE_STATES = ["preparing", "active", "paused", "stopping"];
const LIVE_OVERRIDE_STATES = ["preparing", "active", "paused", "completed"];

let initialised = false;
let readinessSignature = "";
let historySignature = "";
let eventsBound = false;
let ticker = null;
let lastSnapshotAt = 0;

/* --------------------------------------------------------------- presentation */

function bannerText(session) {
  if (!session) {
    return { state: "idle", title: "Idle", sub: "No location simulation has been started." };
  }
  const device = session.deviceId;
  switch (session.state) {
    case "preparing":
      return { state: "preparing", title: "Preparing the developer session", sub: `Contacting ${device} and opening the location service…` };
    case "active":
      return {
        state: "active",
        title: session.mode === "route" ? "Route playback active" : "Fixed location active",
        sub: `The device is reporting the simulated position (${session.publishedPointCount} update(s) published).`,
      };
    case "paused":
      return {
        state: "paused",
        title: "Paused",
        sub: "Publishing stopped. The iPhone keeps reporting the last published coordinate until you resume or stop.",
      };
    case "completed":
      return {
        state: "completed",
        title: "Route completed",
        sub: "The last coordinate is still applied on the device. Press Stop to hand control back to the real GPS.",
      };
    case "stopping":
      return { state: "stopping", title: "Stopping", sub: "Sending the clear command and closing the developer session…" };
    case "stopped":
      return { state: "stopped", title: "Stopped", sub: "The override was cleared; the iPhone is on its own positioning again." };
    case "failed":
      return {
        state: "failed",
        title: "Simulation failed",
        sub: session.error?.message || "The bridge reported a failure without details.",
      };
    case "disconnected":
      return {
        state: "disconnected",
        title: "Device disconnected",
        sub: session.error?.message || "The iPhone is no longer attached; the developer session ended.",
      };
    default:
      return { state: "idle", title: String(session.state), sub: "Unrecognised session state reported by the bridge." };
  }
}

function renderSession() {
  const session = state.session;
  const banner = $("console-banner");
  const text = bannerText(session);
  banner.setAttribute("data-state", text.state);
  $("console-state-title").textContent = text.title;
  $("console-state-sub").textContent = text.sub;
  $("console-spinner").hidden = !["preparing", "stopping"].includes(text.state);

  const transport = $("console-transport-tag");
  if (session?.transport) {
    const dvt = session.transport === "dvt-rsd";
    transport.className = dvt ? "tag cyan" : "tag amber";
    transport.textContent = dvt ? "DVT / RSD TUNNEL" : "LOCKDOWN (LEGACY iOS)";
  } else {
    transport.className = "tag grey";
    transport.textContent = "NO TRANSPORT";
  }

  const ack = $("console-ack-tag");
  if (session) {
    ack.className = session.deviceAcknowledged ? "tag green" : "tag amber";
    ack.textContent = session.deviceAcknowledged ? "DEVICE ACKNOWLEDGED" : "NO PER-WRITE ACK";
  } else {
    ack.className = "tag grey";
    ack.textContent = "NO ACKNOWLEDGEMENT";
  }

  $("console-published").textContent = String(session?.publishedPointCount ?? 0);
  $("console-elapsed").textContent = fmtClock(session?.elapsedSeconds ?? 0);
  $("console-current").textContent = session?.current ? fmtCoordPair(session.current.lat, session.current.lon) : "—";
  $("console-length").innerHTML = fmtDistance(session?.routeLengthM ?? 0);
  updateProgressBar(session);

  $("btn-console-stop").disabled = !session || ["stopped", "failed", "disconnected"].includes(session.state);
  $("btn-console-pause").disabled = session?.state !== "active" || session?.mode !== "route";
  $("btn-console-resume").disabled = session?.state !== "paused";

  lastSnapshotAt = Date.now();
}

function updateProgressBar(session) {
  let ratio = 0;
  if (session?.mode === "route" && session.totalPoints > 1) {
    ratio = (session.publishedIndex + 1) / session.totalPoints;
  } else if (session?.mode === "fixed" && session.state !== "stopped" && session.state !== "idle") {
    ratio = 1;
  }
  $("console-progress-bar").style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
}

function renderReadiness() {
  const report = state.readiness;
  const signature = JSON.stringify(report);
  if (signature === readinessSignature) return;
  readinessSignature = signature;

  const host = $("console-readiness");
  clear(host);
  const device = state.devices.find((entry) => entry.deviceId === state.selectedDeviceId);
  $("console-device-label").textContent = device
    ? `${device.identity?.deviceName || device.deviceId} · ${device.identity?.modelName || device.identity?.productType || "unknown model"}`
    : "NO DEVICE SELECTED";

  if (!report) {
    host.appendChild(
      el("div", { className: "empty", text: "Run the readiness check for the selected device." })
    );
    updateStartButtons();
    return;
  }

  for (const check of report.checks || []) {
    const mark = check.ok === true ? "✓" : check.ok === false ? "✕" : "?";
    host.appendChild(
      el("div", { className: "check", attrs: { "data-ok": String(check.ok) } }, [
        el("span", { className: "mark", text: mark }),
        el("div", { className: "body" }, [
          el("div", { className: "label", text: check.label }),
          check.detail ? el("div", { className: "detail", text: check.detail }) : null,
        ]),
      ])
    );
  }
  host.appendChild(el("div", { className: "hint", text: report.summary }));
  updateStartButtons();
}

function updateStartButtons() {
  const session = state.session;
  const live = Boolean(session) && LIVE_STATES.includes(session.state);
  const blocked = state.readiness && state.readiness.ready === false;
  const hasDevice = Boolean(state.selectedDeviceId);

  $("btn-console-start-point").disabled = !hasDevice || live || Boolean(blocked);
  $("btn-console-start-route").disabled = !hasDevice || live || Boolean(blocked) || state.route.length < 2;

  const hint = $("console-start-hint");
  if (!hasDevice) {
    hint.textContent = "Select an iPhone in the Device workspace first. Nothing is sent to a device you have not chosen.";
    hint.className = "hint";
  } else if (blocked) {
    hint.textContent = `Blocked: ${state.readiness.summary}`;
    hint.className = "hint bad";
  } else if (!state.readiness) {
    hint.textContent =
      "The readiness check has not passed for this device. Starting now is allowed, but the bridge will report the real error if a prerequisite is missing.";
    hint.className = "hint warn";
  } else {
    hint.textContent =
      "The bridge applies the first coordinate before the session is reported as active, so a success here always means the device accepted it.";
    hint.className = "hint";
  }
}

function renderHistory() {
  const signature = JSON.stringify(state.history);
  if (signature === historySignature) return;
  historySignature = signature;

  const host = $("history-list");
  clear(host);
  if (!state.history.length) {
    host.appendChild(el("div", { className: "empty", text: "No sessions yet." }));
    return;
  }
  for (const entry of [...state.history].reverse()) {
    host.appendChild(
      el("div", { className: "list-row" }, [
        el("div", { className: "grow" }, [
          el("div", { className: "name", text: `${entry.mode === "route" ? "Route" : "Fixed point"} · ${entry.state}` }),
          el("div", {
            className: "meta",
            text: `${fmtTimestamp(entry.startedAt)} · ${fmtClock(entry.elapsedSeconds)} · ${entry.publishedPointCount} update(s)${
              entry.error ? ` · ${entry.error.message}` : ""
            }`,
          }),
        ]),
      ])
    );
  }
}

/* ------------------------------------------------------------------ operations */

async function startPoint() {
  const deviceId = state.selectedDeviceId;
  if (!deviceId) return;
  const coordinate = {
    lat: state.target.lat,
    lon: state.target.lon,
    ...(state.target.altitude !== undefined ? { altitude: state.target.altitude } : {}),
  };
  $("btn-console-start-point").disabled = true;
  consoleLog.write("info", `Starting fixed simulation on ${deviceId} at ${fmtCoordPair(coordinate.lat, coordinate.lon)}…`);
  try {
    const snapshot = await api.startSimulation({ deviceId, coordinate });
    setState({ session: snapshot });
    consoleLog.write("ok", `Session ${snapshot.sessionId} active via ${snapshot.transport}.`);
    toast("Simulation active", "The device acknowledged the coordinate.", { kind: "ok" });
    // The bridge records "this device accepted a simulated location"; reflect it on
    // the device card without making the user run another scan by hand.
    await runDiscovery({ deep: false });
  } catch (error) {
    reportError(error, "Starting the simulation");
  } finally {
    renderSession();
    updateStartButtons();
  }
}

async function startRoute() {
  const deviceId = state.selectedDeviceId;
  if (!deviceId) return;
  if (state.route.length < 2) {
    toast("Route too short", "Add at least two waypoints in the Routes workspace.", { kind: "warn" });
    return;
  }
  const points = state.route.map((point) => ({
    lat: point.lat,
    lon: point.lon,
    ...(point.altitude !== undefined ? { altitude: point.altitude } : {}),
  }));
  $("btn-console-start-route").disabled = true;
  consoleLog.write("info", `Starting route playback on ${deviceId}: ${points.length} waypoints at ${state.routeOptions.speedMps} m/s.`);
  try {
    const snapshot = await api.startRouteSimulation({
      deviceId,
      points,
      options: { ...state.routeOptions },
    });
    setState({ session: snapshot });
    consoleLog.write(
      "ok",
      `Session ${snapshot.sessionId} active: ${snapshot.totalPoints} device updates over ${fmtDistance(snapshot.routeLengthM)}.`
    );
    toast("Route playback active", `${snapshot.totalPoints} updates queued.`, { kind: "ok" });
    await runDiscovery({ deep: false });
  } catch (error) {
    reportError(error, "Starting route playback");
  } finally {
    renderSession();
    updateStartButtons();
  }
}

async function stopSimulation() {
  const session = state.session;
  const live = session && LIVE_OVERRIDE_STATES.includes(session.state);
  if (live) {
    const confirmed = await confirmAction({
      title: "Stop and restore real GPS",
      message: "Stop the simulation and return the iPhone to its own positioning?",
      confirmLabel: "Stop & restore GPS",
      danger: true,
      hint: "The bridge sends the clear command and closes the developer session.",
    });
    if (!confirmed) return;
  }
  $("btn-console-stop").disabled = true;
  consoleLog.write("info", "Stopping the simulation and clearing the location override…");
  try {
    const snapshot = await api.stopSimulation(session?.deviceId ? { deviceId: session.deviceId } : {});
    setState({ session: snapshot });
    if (snapshot.error) {
      consoleLog.write("warn", `Stop reported an issue: ${snapshot.error.message}`);
      toast("Stop reported an issue", snapshot.error.message, { kind: "warn", sticky: true });
    } else {
      consoleLog.write("ok", "Override cleared; the device is back on its real GPS.");
      toast("Stopped", "The location override was cleared.", { kind: "ok" });
    }
  } catch (error) {
    reportError(error, "Stopping the simulation");
  } finally {
    renderSession();
    updateStartButtons();
    refreshSession().catch(() => {});
  }
}

async function pauseSimulation() {
  try {
    const snapshot = await api.pauseSimulation(state.session?.deviceId ? { deviceId: state.session.deviceId } : {});
    setState({ session: snapshot });
    consoleLog.write("warn", "Pause requested: no further coordinates are published until resume.");
  } catch (error) {
    reportError(error, "Pausing the simulation");
  } finally {
    renderSession();
    updateStartButtons();
  }
}

async function resumeSimulation() {
  try {
    const snapshot = await api.resumeSimulation(state.session?.deviceId ? { deviceId: state.session.deviceId } : {});
    setState({ session: snapshot });
    consoleLog.write("info", "Resumed: publishing continues from the paused point.");
  } catch (error) {
    reportError(error, "Resuming the simulation");
  } finally {
    renderSession();
    updateStartButtons();
  }
}

async function refreshState({ silent = false } = {}) {
  try {
    const status = await refreshSession();
    if (!silent && !status.session) consoleLog.write("info", "The bridge reports no session.");
  } catch (error) {
    if (!silent) reportError(error, "Refreshing the session state");
  } finally {
    renderSession();
    updateStartButtons();
  }
}

async function captureScreenshot() {
  const deviceId = state.selectedDeviceId;
  if (!deviceId) {
    toast("No device selected", "Select an iPhone in the Device workspace first.", { kind: "warn" });
    return;
  }
  const host = $("screenshot-host");
  clear(host);
  host.appendChild(el("div", { className: "hint", text: "Requesting the device screen…" }));
  try {
    const shot = await api.captureDeviceScreenshot({ deviceId });
    clear(host);
    const image = el("img", { attrs: { alt: "Screenshot captured from the iPhone", src: shot.dataUrl } });
    host.appendChild(el("div", { className: "shot-frame" }, [image]));
    host.appendChild(
      el("div", {
        className: "hint",
        text: `Captured ${fmtTimestamp(shot.capturedAt)} · ${(shot.byteLength / 1024).toFixed(0)} KB · ${shot.mimeType}`,
      })
    );
    consoleLog.write("ok", `Captured a ${(shot.byteLength / 1024).toFixed(0)} KB screenshot from the device.`);
  } catch (error) {
    clear(host);
    host.appendChild(el("div", { className: "banner-note warn" }, [
      el("span", { className: "icon", text: "ⓘ" }),
      el("div", { className: "body" }, [
        el("strong", { text: "The screenshot could not be captured" }),
        el("p", { text: `${error.message}${error.details ? ` — ${error.details}` : ""}` }),
        error.remedy ? el("p", { text: `Fix: ${error.remedy}` }) : null,
      ]),
    ]));
    consoleLog.write("error", `Screenshot failed: ${error.message}`);
  }
}

/* --------------------------------------------------------------------- ticker */

function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    const session = state.session;
    if (!session || !LIVE_OVERRIDE_STATES.includes(session.state)) return;
    if (session.state === "active" || session.state === "paused") {
      const drift = session.state === "active" ? (Date.now() - lastSnapshotAt) / 1000 : 0;
      $("console-elapsed").textContent = fmtClock((session.elapsedSeconds || 0) + drift);
    }
  }, 1000);
}

/* ------------------------------------------------------------------------ init */

function bindEvents() {
  if (eventsBound || !bridgeAvailable) return;
  eventsBound = true;

  api.onBridgeEvent(({ event, data }) => {
    if (event === "simulation.state") {
      setState({ session: data });
      consoleLog.write("device", `Simulation ${data.state}: ${data.reason || "state change"}.`);
      renderSession();
      updateStartButtons();
      refreshSession().catch(() => {});
      return;
    }
    if (event === "simulation.progress" && data) {
      setState({ session: { ...(state.session || {}), ...data } });
      $("console-published").textContent = String(data.publishedPointCount ?? 0);
      $("console-elapsed").textContent = fmtClock(data.elapsedSeconds ?? 0);
      if (data.current) $("console-current").textContent = fmtCoordPair(data.current.lat, data.current.lon);
      if (typeof data.progress === "number") $("console-progress-bar").style.width = `${data.progress * 100}%`;
      lastSnapshotAt = Date.now();
      return;
    }
    if (event === "devices.presence") {
      const count = data?.devices?.length ?? 0;
      consoleLog.write("device", `USB presence changed: ${count} device(s) attached.`);
      return;
    }
    if (event === "device.pairing.started") {
      consoleLog.write("device", `Pairing started for ${data?.deviceId}.`);
      return;
    }
    if (event === "device.pairing.completed") {
      consoleLog.write("ok", `Pairing completed for ${data?.deviceId}.`);
    }
  });

  api.onBridgeStatus((status) => {
    const previous = state.bridge;
    setState({ bridge: status });
    if (previous?.state !== status.state) {
      consoleLog.write(status.state === "ready" ? "ok" : "warn", `Bridge ${status.state}: ${status.detail || ""}`.trim());
    }
  });
}

export function initSimConsole() {
  if (initialised) return;
  initialised = true;

  $("btn-console-start-point").addEventListener("click", () => {
    startPoint().catch(() => {});
  });
  $("btn-console-start-route").addEventListener("click", () => {
    startRoute().catch(() => {});
  });
  $("btn-console-stop").addEventListener("click", () => {
    stopSimulation().catch(() => {});
  });
  $("btn-console-pause").addEventListener("click", () => {
    pauseSimulation().catch(() => {});
  });
  $("btn-console-resume").addEventListener("click", () => {
    resumeSimulation().catch(() => {});
  });
  $("btn-console-refresh").addEventListener("click", () => {
    refreshState().catch(() => {});
  });
  $("btn-screenshot").addEventListener("click", () => {
    captureScreenshot().catch(() => {});
  });
  $("btn-clear-console-log").addEventListener("click", () => consoleLog.clear());
  $("toggle-route-loop").addEventListener("change", (event) => {
    setState({ routeOptions: { ...state.routeOptions, loop: event.target.checked } });
    persistWorkspace();
    consoleLog.write("info", event.target.checked ? "Route playback will loop until stopped." : "Route playback will stop at the last waypoint.");
  });

  $("toggle-route-loop").checked = Boolean(state.routeOptions.loop);
  bindEvents();
  renderSession();
  renderReadiness();
  renderHistory();
  updateStartButtons();
  startTicker();

  subscribe(() => {
    if (!initialised) return;
    renderSession();
    renderReadiness();
    renderHistory();
    updateStartButtons();
  });
}
