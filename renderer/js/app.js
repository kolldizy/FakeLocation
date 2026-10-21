/**
 * Renderer bootstrap.
 *
 * Responsibilities are deliberately narrow:
 *   - load the saved workspace before the views initialise;
 *   - initialise the four view modules;
 *   - own navigation, the top status chips and the periodic session poll;
 *   - keep the visible state equal to the bridge's reported state.
 *
 * No view module calls another view module; they communicate through the store.
 */

import { api, available as bridgeAvailable, ApiError } from "./api.js";
import { state, setState, subscribe, loadWorkspace, refreshSession } from "./store.js";
import { initMapStudio } from "./mapstudio.js";
import { initDeviceCenter, runDiscovery, runReadiness, refreshHealth } from "./devicecenter.js";
import { initMotionLab } from "./motionlab.js";
import { initSimConsole } from "./simconsole.js";
import { initWireless, refreshLinkStatus, renderWirelessChip } from "./wireless.js";
import { initOverview, renderOverview } from "./overview.js";
import { initSettings, renderSettings } from "./settings.js";
import { initDeviceStrip, renderDeviceStrip } from "./devicestrip.js";
import { NAVIGATE, EMERGENCY_STOP, LIMITATIONS } from "./nav.js";
import { studioMap, previewMap } from "./maps.js";
import { consoleLog, bridgeLog, toast, reportError } from "./logpanel.js";
import { showInfo, confirmAction } from "./dialog.js";
import { $, el } from "./util.js";

/** Nav order, keyboard index and panel title for each workspace. */
const VIEWS = {
  overview: { eyebrow: "OVERVIEW / WHAT IS KNOWN", title: "Overview" },
  map: { eyebrow: "LOCATION / PICK, CHECK, SIMULATE", title: "Location" },
  motion: { eyebrow: "ROUTES / WAYPOINTS AND PLAYBACK", title: "Routes" },
  device: { eyebrow: "DEVICE / HARDWARE AND LINK TRUTH", title: "Device" },
  settings: { eyebrow: "SETTINGS / PREFERENCES AND SETUP", title: "Settings" },
};

const VIEW_ORDER = ["overview", "map", "motion", "device", "settings"];

const SESSION_POLL_MS = 4000;

let booted = false;
let pollHandle = null;
let autoReadinessRequested = false;

/* ------------------------------------------------------------------ navigation */

function switchView(view) {
  if (!VIEWS[view]) return;
  setState({ view });

  for (const button of document.querySelectorAll(".nav-item")) {
    button.classList.toggle("active", button.dataset.view === view);
  }
  for (const section of document.querySelectorAll(".view")) {
    section.classList.toggle("active", section.id === `view-${view}`);
  }
  $("view-eyebrow").textContent = VIEWS[view].eyebrow;
  $("view-title").textContent = VIEWS[view].title;

  // Leaflet measures its container, so a hidden map must be re-measured on show.
  requestAnimationFrame(() => {
    if (view === "map") studioMap.invalidate();
    if (view === "motion") previewMap.invalidate();
  });

  // Location and Device both act on device truth, so the first visit to either pays for
  // a scan once. Overview deliberately does not: it summarises whatever the boot scan
  // returned and only spends device traffic when its own button is pressed.
  if ((view === "map" || view === "device") && bridgeAvailable) {
    ensurePrerequisites();
  }
  // The link panels can be opened before anything was probed. Reading the retained
  // status costs no device traffic, so it is safe to do on entry; the probe itself
  // stays behind its button because it floods the network for several seconds.
  if (view === "device" && bridgeAvailable && !state.wireless) {
    refreshLinkStatus({ silent: true }).catch(() => {});
  }
  renderOverview();
  renderSettings();
}

/** Lazily run discovery + readiness the first time a device view is opened. */
async function ensurePrerequisites() {
  if (autoReadinessRequested) return;
  autoReadinessRequested = true;
  try {
    const selected = state.devices.find((device) => device.deviceId === state.selectedDeviceId);
    // A cheap scan (usbmuxd only) cannot report the model, the iOS version or the
    // pairing state. If that is all we have for the selected device, spend the deep
    // scan now so the card is not left half-unknown.
    if (!state.devices.length || (selected && !selected.identity)) await runDiscovery({ deep: true });
    if (state.selectedDeviceId && !state.readiness) await runReadiness({ silent: true });
  } catch (error) {
    consoleLog.write("warn", `Automatic prerequisite check failed: ${error.message}`);
  }
}

/* ------------------------------------------------------------------ status UI */

function deviceChip() {
  const selected = state.devices.find((device) => device.deviceId === state.selectedDeviceId);
  const chip = $("rail-device-chip");
  const note = $("rail-device-note");

  if (!selected) {
    chip.className = "chip";
    chip.innerHTML = '<span class="dot"></span> NO DEVICE';
    note.textContent = state.devices.length
      ? `${state.devices.length} Apple device(s) reported by usbmuxd, none selected.`
      : "No iPhone has been reported by usbmuxd yet.";
    return;
  }

  const identity = selected.identity || {};
  const ready = state.readiness?.ready === true;
  const blocked = state.readiness?.ready === false;
  chip.className = ready ? "chip ok" : blocked ? "chip bad" : "chip warn";
  chip.innerHTML = `<span class="dot"></span> ${ready ? "DEVICE READY" : blocked ? "NOT READY" : "SELECTED"}`;

  const parts = [identity.deviceName || selected.deviceId];
  if (identity.productVersion) parts.push(`iOS ${identity.productVersion}`);
  parts.push(selected.connectionType || "unknown link");
  if (selected.stages?.paired === true) parts.push("paired");
  else if (selected.stages?.paired === false) parts.push("not paired");
  if (selected.stages?.developerModeEnabled === false) parts.push("Developer Mode off");
  note.textContent = parts.join(" · ");
}

function renderChips() {
  const session = state.session;
  const simChip = $("chip-simulation");
  const overrideChip = $("chip-override");

  const stateLabels = {
    preparing: { className: "chip warn", text: "SIMULATION PREPARING" },
    active: { className: "chip live", text: "SIMULATION ACTIVE" },
    paused: { className: "chip warn", text: "SIMULATION PAUSED" },
    completed: { className: "chip ok", text: "ROUTE COMPLETED — OVERRIDE STILL APPLIED" },
    stopping: { className: "chip warn", text: "STOPPING…" },
    stopped: { className: "chip", text: "SIMULATION STOPPED" },
    failed: { className: "chip bad", text: "SIMULATION FAILED" },
    disconnected: { className: "chip bad", text: "DEVICE DISCONNECTED" },
  };

  if (!session) {
    simChip.className = "chip";
    simChip.innerHTML = '<span class="dot"></span> NO SIMULATION';
    overrideChip.className = "chip";
    overrideChip.innerHTML = '<span class="dot"></span> DEVICE GPS: NORMAL';
  } else {
    const label = stateLabels[session.state] || { className: "chip", text: `SESSION ${String(session.state).toUpperCase()}` };
    simChip.className = label.className;
    simChip.innerHTML = `<span class="dot"></span> ${label.text}`;

    if (session.locationOverrideActive === true) {
      overrideChip.className = "chip bad";
      overrideChip.innerHTML = '<span class="dot"></span> DEVICE GPS: OVERRIDDEN';
    } else if (session.locationOverrideActive === false) {
      overrideChip.className = "chip ok";
      overrideChip.innerHTML = '<span class="dot"></span> DEVICE GPS: RESTORED';
    } else {
      overrideChip.className = "chip warn";
      overrideChip.innerHTML = '<span class="dot"></span> DEVICE GPS: UNCONFIRMED';
    }
  }

  const badge = $("nav-console-badge");
  badge.hidden = !(session && ["failed", "disconnected"].includes(session.state));

  $("btn-emergency-stop").disabled = !session || ["stopped", "failed", "disconnected", "idle"].includes(session.state);
}

function renderBridgeChip() {
  const status = state.bridge || {};
  const chip = $("rail-bridge-chip");
  const note = $("rail-bridge-note");
  const health = state.health;

  const map = {
    ready: { className: "chip ok", text: "READY" },
    starting: { className: "chip warn", text: "STARTING" },
    crashed: { className: "chip bad", text: "CRASHED" },
    stopped: { className: "chip", text: "STOPPED" },
  };
  const label = map[status.state] || { className: "chip", text: String(status.state || "UNKNOWN").toUpperCase() };
  chip.className = label.className;
  chip.innerHTML = `<span class="dot"></span> ${label.text}`;

  if (status.state !== "ready") {
    note.textContent = status.detail || "The device bridge is not running.";
    return;
  }
  if (!health) {
    note.textContent = "Checking the bridge environment…";
    return;
  }
  const pmd = health.pymobiledevice3?.available ? `pymobiledevice3 ${health.pymobiledevice3.version}` : "pymobiledevice3 missing";
  const usbmux = health.usbmux?.available ? "usbmuxd up" : "usbmuxd unavailable";
  note.textContent = `${pmd} · ${usbmux}${health.platform ? ` · ${health.platform.system}` : ""}`;
}

/* ------------------------------------------------------------------ operations */

async function restartBridge() {
  const confirmed = await confirmAction({
    title: "Restart the device bridge",
    message: "Restart the Python bridge process? Any running simulation will be stopped and the iPhone returned to its real GPS.",
    confirmLabel: "Restart bridge",
    danger: true,
  });
  if (!confirmed) return;
  bridgeLog.write("info", "Restart requested from the UI.");
  try {
    const result = await api.restartBridge();
    setState({ bridge: result.status, health: null, readiness: null });
    toast("Bridge restarting", "Waiting for the new process to complete its handshake…", { kind: "warn" });
    await refreshHealth().catch(() => {});
    await refreshSession().catch(() => {});
    autoReadinessRequested = false;
  } catch (error) {
    reportError(error, "Restarting the bridge");
  }
}

async function emergencyStop() {
  const confirmed = await confirmAction({
    title: "Stop and restore real GPS",
    message: "Send the clear command and close the developer session on the iPhone?",
    confirmLabel: "Stop & restore GPS",
    danger: true,
    hint: "This is the same operation as Stop in the Location workspace.",
  });
  if (!confirmed) return;
  try {
    await api.shutdownSimulation();
    await refreshSession().catch(() => {});
    toast("Stop sent", "The location override was cleared and the tunnel closed.", { kind: "ok" });
  } catch (error) {
    reportError(error, "Stopping the simulation");
  } finally {
    renderChips();
  }
}

function showLimitations() {
  const bullets = [
    "Find My device tracking, and anything else that resolves the device through Apple's servers, still shows the physical location.",
    "Carrier-assisted positioning and emergency services are not affected.",
    "Apps that verify integrity or use their own location attestation may ignore the override.",
    "Altitude is never sent: the developer selector accepts latitude and longitude only.",
    "The override lives as long as the developer session. Unplugging the cable — or losing the Wi-Fi link, the phone sleeping, or the Apple Mobile Device Service stopping — ends it and the iPhone immediately returns to its real GPS.",
    "Wireless needs its own one-time setup: a USB pairing record does not switch Wi-Fi communication on, and the phone has to be on the same, non-isolated network as this PC.",
  ];

  showInfo({
    title: "What this override does and does not affect",
    children: [
      el("p", {
        attrs: { style: "margin-top:0" },
        text:
          "Apple's developer location channel changes the position CoreLocation reports to apps. That covers most apps that ask the system for a location, including Maps, and it is the same mechanism Xcode uses.",
      }),
      el("p", { text: "It does not change everything:" }),
      el(
        "ul",
        { attrs: { style: "line-height:1.85; font-size:12px; padding-left:18px;" } },
        bullets.map((text) => el("li", { text }))
      ),
      el("p", {
        text:
          "Location Studio only ever applies a location you chose, on a device you selected, and always offers an explicit stop.",
      }),
    ],
  }).catch(() => {});
}

/* ------------------------------------------------------------------ bootstrap */

function startSessionPoll() {
  if (pollHandle) return;
  pollHandle = setInterval(async () => {
    if (document.hidden) return;
    if (state.bridge?.state !== "ready") return;
    try {
      await refreshSession();
    } catch {
      /* the bridge status chip already reports the failure */
    }
  }, SESSION_POLL_MS);
}

function bindGlobalEvents() {
  for (const button of document.querySelectorAll(".nav-item")) {
    button.addEventListener("click", () => switchView(button.dataset.view));
  }

  // A view asks for these instead of reaching into the shell (see nav.js).
  document.addEventListener(NAVIGATE, (event) => switchView(event.detail?.view));
  document.addEventListener(EMERGENCY_STOP, () => {
    emergencyStop().catch(() => {});
  });
  document.addEventListener(LIMITATIONS, () => showLimitations());

  $("btn-restart-bridge").addEventListener("click", () => {
    restartBridge().catch(() => {});
  });
  $("btn-emergency-stop").addEventListener("click", () => {
    emergencyStop().catch(() => {});
  });

  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const index = Number(event.key);
    if (Number.isInteger(index) && index >= 1 && index <= VIEW_ORDER.length) switchView(VIEW_ORDER[index - 1]);
  });

  if (bridgeAvailable) {
    api.onBridgeEvent(({ event }) => {
      if (event === "ui.openLimitations") showLimitations();
    });
    api.onBridgeStatus((status) => {
      setState({ bridge: status });
      if (status.state === "ready") {
        if (!state.health) refreshHealth().catch(() => {});
        // The boot-time status read usually races the handshake, so the scan in
        // boot() never runs on a cold start. Run the same cheap scan when "ready"
        // arrives later, so the left rail reflects an attached iPhone without the
        // user having to open Device Center first.
        if (!state.discovery) runDiscovery({ deep: false }).catch(() => {});
      }
    });
  }
}

async function boot() {
  if (booted) return;
  booted = true;

  if (!bridgeAvailable) {
    consoleLog.write("error", "The preload bridge is missing; device features are unavailable.");
    toast("Running without the desktop bridge", "Device operations are disabled in this window.", { kind: "error", sticky: true });
  }

  await loadWorkspace();

  initMapStudio();
  initDeviceCenter();
  initMotionLab();
  initWireless();
  initSimConsole();
  initOverview();
  initSettings();
  initDeviceStrip();
  bindGlobalEvents();

  subscribe(() => {
    deviceChip();
    renderChips();
    renderBridgeChip();
    renderWirelessChip();
    renderDeviceStrip();
    renderOverview();
    renderSettings();
  });
  deviceChip();
  renderChips();
  renderBridgeChip();
  renderWirelessChip();
  renderDeviceStrip();

  // Always open on Overview. `state.view` is not part of the workspace document, so
  // honouring it would only ever replay the previous run's last click.
  switchView("overview");

  if (bridgeAvailable) {
    try {
      const info = await api.getAppInfo();
      setState({ appInfo: info, bridge: info.bridgeStatus || state.bridge });
      consoleLog.write("info", `Location Studio ${info.appVersion} · Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node}.`);
      consoleLog.write("info", `Workspace file: ${info.workspaceFile}`);
    } catch (error) {
      reportError(error, "Reading application information");
    }

    try {
      const status = await api.getBridgeStatus();
      setState({ bridge: status });
      if (status.state === "ready") {
        await refreshHealth().catch(() => {});
        await runDiscovery({ deep: false }).catch(() => {});
      } else {
        bridgeLog.write("warn", `Bridge not ready: ${status.detail || "no detail reported"}.`);
      }
    } catch (error) {
      if (!(error instanceof ApiError)) console.error(error);
      bridgeLog.write("error", `Could not read the bridge status: ${error.message}`);
    }

    await refreshSession().catch(() => {});
    startSessionPoll();
  }

  window.addEventListener("beforeunload", () => {
    if (pollHandle) clearInterval(pollHandle);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    boot().catch((error) => {
      console.error(error);
      toast("Startup failed", error.message, { kind: "error", sticky: true });
    });
  });
} else {
  boot().catch((error) => {
    console.error(error);
    toast("Startup failed", error.message, { kind: "error", sticky: true });
  });
}
