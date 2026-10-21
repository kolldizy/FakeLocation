/**
 * Overview — a reading of what is already known, never a new source of truth.
 *
 * Every line here is lifted from the store: the device list the bridge returned, the
 * link report a handshake produced, the probe verdict, the readiness check, the current
 * session. Nothing in this view starts or stops a device operation except the two
 * buttons it delegates — "Re-scan now" calls the same discovery the Device workspace
 * runs, and "Stop & restore GPS" asks the shell to do exactly what the header button
 * does. A row that has not been measured says so instead of showing a plausible default.
 */

import { state, refreshSession } from "./store.js";
import { runDiscovery, runReadiness, refreshHealth } from "./devicecenter.js";
import { available as bridgeAvailable } from "./api.js";
import { consoleLog, toast } from "./logpanel.js";
import { navigate, requestEmergencyStop } from "./nav.js";
import { $, el, clear, fmtCoordPair, fmtClock, fmtDistance, fmtTimestamp, routeLengthM } from "./util.js";

const LIVE_STATES = ["preparing", "active", "paused", "completed", "stopping"];

function currentDevice() {
  if (!state.devices.length) return null;
  return state.devices.find((device) => device.deviceId === state.selectedDeviceId) || state.devices[0];
}

function setRow(id, text, toneName = "") {
  const node = $(id);
  node.textContent = text;
  node.className = toneName ? `v ${toneName}` : "v";
}

/**
 * What is standing between this PC and a location simulation, in the order the
 * pipeline is actually verified. An unmeasured stage is reported as unmeasured —
 * the list never claims a prerequisite is satisfied because it was not contradicted.
 */
function blockers() {
  const device = currentDevice();
  const readiness = state.readiness;
  const stages = device?.stages || {};
  const items = [];

  if (!bridgeAvailable) items.push("This window is running outside the desktop shell, so no device operation exists.");
  else if (state.bridge?.state !== "ready") items.push(`The Python device bridge is ${state.bridge?.state || "not running"}.`);
  if (!device) items.push("No iPhone is visible to the Apple Mobile Device Service — connect a data cable and unlock the phone.");
  if (device && stages.paired === false) items.push("The iPhone has not trusted this computer: tap Trust on the phone, then re-scan.");
  else if (device && stages.paired !== true) items.push("Pairing has not been confirmed for this device.");
  if (stages.developerModeEnabled === false) items.push("Developer Mode is off on the iPhone (Settings → Privacy & Security → Developer Mode).");
  else if (device && stages.developerModeEnabled !== true) items.push("Developer Mode has not been read for this device.");
  if (stages.developerServiceAvailable === false) items.push("The developer location service did not answer, so no override can be published.");
  if (!readiness) items.push("The readiness check has not run; it is the only thing that turns these stages into facts.");
  else if (readiness.ready === false) {
    const failed = (readiness.checks || []).filter((check) => check.ok === false);
    for (const check of failed) items.push(`${check.label}: ${check.remedy || check.detail || "not satisfied"}`);
  }
  return items;
}

function renderBoard() {
  const device = currentDevice();
  const identity = device?.identity || {};
  const stages = device?.stages || {};
  const link = state.wirelessLink;
  const probe = state.wireless;
  const session = state.session;

  if (!device) {
    setRow("ov-device", state.devices.length
      ? `${state.devices.length} device(s) reported, none selected.`
      : "No iPhone has been reported by the Apple Mobile Device Service.", "warn");
  } else {
    const name = identity.deviceName || identity.productType || device.deviceId;
    const iOS = identity.productVersion ? `iOS ${identity.productVersion}` : "iOS version not read";
    const trusted = stages.paired === true ? "trusted" : stages.paired === false ? "not trusted" : "pairing unknown";
    setRow("ov-device", `${name} · ${iOS} · ${trusted} · ${device.connectionType || "link type not read"}`,
      stages.paired === true ? "ok" : "warn");
  }

  if (link?.activeSession?.open) {
    setRow("ov-transport", `Session open over ${link.activeSession.transport}${
      link.activeSession.wireless ? " with the cable free" : " on the cable"}.`, "ok");
  } else if (link?.selected?.transport) {
    setRow("ov-transport", `${link.selected.transport} was reached, but no developer session is open.`, "warn");
  } else if (device?.connectionType) {
    setRow("ov-transport", `Only the usbmuxd entry is known (${device.connectionType}); no transport has been handshaked.`, "warn");
  } else {
    setRow("ov-transport", "Nothing has been reached in this session.", "neutral");
  }

  const health = state.health;
  if (!bridgeAvailable) setRow("ov-bridge", "No desktop bridge in this window.", "bad");
  else if (state.bridge?.state !== "ready") setRow("ov-bridge", `Bridge ${state.bridge?.state || "unknown"}${state.bridge?.detail ? ` — ${state.bridge.detail}` : ""}`, "bad");
  else if (!health) setRow("ov-bridge", "Bridge is ready; its environment has not been read yet.", "warn");
  else {
    const pmd = health.pymobiledevice3?.available ? `pymobiledevice3 ${health.pymobiledevice3.version}` : "pymobiledevice3 missing";
    const mux = health.usbmux?.available ? "usbmuxd answering" : "usbmuxd unavailable";
    setRow("ov-bridge", `Ready · ${pmd} · ${mux}`, health.usbmux?.available ? "ok" : "bad");
  }

  if (!session) setRow("ov-session", "No session has been started, so the iPhone still reports its real GPS.", "neutral");
  else {
    const override = session.locationOverrideActive === true ? "override active"
      : session.locationOverrideActive === false ? "override cleared"
      : "override not confirmed";
    setRow("ov-session", `${String(session.state).toUpperCase()} · ${session.publishedPointCount ?? 0} update(s) published · ${fmtClock(session.elapsedSeconds ?? 0)} elapsed · ${override}`,
      session.state === "active" ? "live" : LIVE_STATES.includes(session.state) ? "warn" : session.state === "completed" ? "warn" : "neutral");
  }

  const target = state.target;
  setRow("ov-target", `${fmtCoordPair(target.lat, target.lon)}${
    target.altitude === undefined || target.altitude === null ? "" : ` · ${target.altitude} m altitude`
  }`);

  const route = state.route;
  setRow(
    "ov-route",
    route.length
      ? `${route.length} waypoint(s) · ${fmtDistance(routeLengthM(route))} · ${state.routeOptions.speedMps} m/s`
      : "No waypoints. The Location workspace can still simulate the destination on its own.",
    route.length >= 2 ? "ok" : "warn"
  );

  setRow("ov-wireless", probe
    ? `${probe.verdict?.summary || "The probe returned no summary."} Probed ${fmtTimestamp(probe.probedAt)}.`
    : "Not probed in this session — run “Discover devices” in Device.", probe?.verdict?.wirelessHandshakeReady?.length ? "ok" : "neutral");

  const missing = blockers();
  if (!missing.length) setRow("ov-blockers", "Nothing is missing: the readiness check confirmed every prerequisite.", "ok");
  else if (!state.readiness && !currentDevice()) setRow("ov-blockers", missing[0], "neutral");
  else setRow("ov-blockers", missing.join("  ·  "), "warn");
}

/**
 * The tail of the operation log.
 *
 * The lines are the ones logpanel was actually given, read from its ring buffer, so
 * this panel cannot show a message the Device workspace does not have.
 */
function renderLog() {
  const host = $("overview-log");
  const lines = consoleLog.recent(9).reverse();
  clear(host);
  if (!lines.length) {
    host.appendChild(
      el("div", { className: "log-line info" }, [
        el("span", { className: "t", text: "--:--:--" }),
        el("span", { className: "m", text: "Nothing has been logged yet." }),
      ])
    );
    return;
  }
  for (const line of lines) {
    host.appendChild(
      el("div", { className: `log-line ${line.level}` }, [
        el("span", { className: "t", text: line.at }),
        el("span", { className: "m", text: line.text }),
      ])
    );
  }
}

function renderActions() {
  const session = state.session;
  $("btn-overview-stop").disabled = !session || ["stopped", "failed", "disconnected", "idle"].includes(session.state);
}

function render() {
  renderBoard();
  renderLog();
  renderActions();
}

async function rescan() {
  if (!bridgeAvailable) {
    toast("No bridge", "This window is running outside the desktop shell.", { kind: "error" });
    return;
  }
  $("btn-overview-refresh").disabled = true;
  try {
    await refreshHealth().catch(() => {});
    await runDiscovery({ deep: true });
    if (state.selectedDeviceId) await runReadiness({ silent: true });
    await refreshSession().catch(() => {});
    consoleLog.write("ok", "Overview re-scan finished.");
  } catch (error) {
    consoleLog.write("warn", `Overview re-scan could not finish: ${error.message}`);
  } finally {
    $("btn-overview-refresh").disabled = false;
  }
}

export function initOverview() {
  $("ov-go-location").addEventListener("click", () => navigate("map"));
  $("ov-go-device").addEventListener("click", () => navigate("device"));
  $("btn-overview-refresh").addEventListener("click", () => {
    rescan().catch(() => {});
  });
  $("btn-overview-stop").addEventListener("click", () => requestEmergencyStop());
  render();
}

export { render as renderOverview };
