/**
 * Settings — the preferences and the one-time setup, kept out of the working views.
 *
 * Two kinds of thing live here and they are deliberately kept apart:
 *   - choices this app owns (basemap), written to the workspace file;
 *   - facts this app can only observe (is the Apple Mobile Device Service up, has the
 *     iPhone trusted this PC, is Developer Mode on). The wireless checklist marks a row
 *     from the evidence a scan or a probe actually returned and leaves it open when
 *     nothing measured it — a manual step on the phone is never shown as done because
 *     it was not contradicted.
 */

import { state, setState, persistWorkspace } from "./store.js";
import { consoleLog } from "./logpanel.js";
import { requestLimitations } from "./nav.js";
import { $, el, fmtTimestamp } from "./util.js";

/** Evidence lines are appended once per row and then only re-worded. */
const verdictNodes = new Map();

function setVerdict(row, index, text) {
  let node = verdictNodes.get(index);
  if (!node) {
    node = el("div", { className: "detail" });
    (row.querySelector(".body") || row).appendChild(node);
    verdictNodes.set(index, node);
  }
  node.textContent = text;
}

function markRow(row, value, text) {
  if (!row) return;
  row.dataset.ok = String(value === true ? true : value === false ? false : null);
  setVerdict(row, Number(row.dataset.setupIndex), text);
}

function currentDevice() {
  if (!state.devices.length) return null;
  return state.devices.find((device) => device.deviceId === state.selectedDeviceId) || state.devices[0];
}

function renderChecklist() {
  const rows = [...$("wireless-setup-checks").children];
  rows.forEach((row, index) => {
    row.dataset.setupIndex = String(index);
    row.dataset.ok = "null";
  });

  const device = currentDevice();
  const stages = device?.stages || {};
  const probe = state.wireless;
  const health = state.health;
  const transports = probe?.transports || {};
  const wifiMux = transports["wifi-mux"] || {};
  const rsd = transports["rsd-lan"] || {};
  const usb = transports["usb"] || {};

  markRow(rows[0], device ? stages.paired === true : null,
    device
      ? stages.paired === true
        ? `Measured: this PC holds a pairing the iPhone accepted (${device.deviceId.slice(0, 8)}…).`
        : stages.paired === false
          ? "Measured: the iPhone does not have a usable pairing record for this PC."
          : "Not measured: run a deep scan or the readiness check in Device."
      : "Not measured: no iPhone has been reported yet.");

  const sawNetwork = Boolean(wifiMux.available || rsd.available);
  markRow(rows[1], probe ? (sawNetwork ? true : usb.available && device ? false : null) : null,
    !probe
      ? "Not measured: no probe has run in this session."
      : sawNetwork
        ? "Measured: an iPhone answered on the network path, so Wi-Fi syncing is enabled."
        : usb.available
          ? "Measured: a USB iPhone is attached and nothing answered over Wi-Fi, so wireless is still off."
          : "Measured: nothing was seen on USB or Wi-Fi, so this cannot be judged yet.");

  markRow(rows[2], probe ? (sawNetwork ? true : null) : null,
    !probe
      ? "Not measured: multicast DNS is only judged by a probe that browses the network."
      : sawNetwork
        ? "Measured: a device was discovered on this network, so broadcasts reach this PC."
        : "Not measured: nothing was broadcast to this PC, which is what an isolated network looks like but is not proof of one.");

  markRow(rows[3], health ? Boolean(health.usbmux?.available) : null,
    !health
      ? "Not measured: the bridge environment has not been read."
      : health.usbmux?.available
        ? "Measured: the Apple Mobile Device Service answered on 127.0.0.1:27015."
        : `Measured: usbmuxd did not answer${health.usbmux?.error ? ` — ${health.usbmux.error}` : ""}.`);

  markRow(rows[4], device ? stages.developerModeEnabled : null,
    device
      ? stages.developerModeEnabled === true
        ? "Measured: Developer Mode is on."
        : stages.developerModeEnabled === false
          ? "Measured: Developer Mode is off. The iPhone has to be restarted by you; this app never changes it."
          : "Not measured: lockdown has not answered for this device."
      : "Not measured: no device selected.");

  const version = device?.identity?.productVersion;
  const minor = version ? Number(String(version).split(".")[1] ?? "") : NaN;
  const needsBootstrap = Number.isFinite(minor) && String(version).startsWith("17.") && minor <= 3;
  markRow(rows[5], !version ? null : needsBootstrap ? (wifiMux.available ? true : null) : true,
    !version
      ? "Not measured: the iOS version has not been read from the device."
      : needsBootstrap
        ? `iOS ${version} needs a RemotePairing record created once on the cable.`
        : `Not required: iOS ${version} reaches the developer service through the CoreDevice proxy.`);

  const checked = probe ? `Last probe ${fmtTimestamp(probe.probedAt)}.` : "No probe has run in this session.";
  $("settings-setup-note").textContent =
    `${device ? `Judged against ${device.identity?.deviceName || device.deviceId.slice(0, 8) + "…"}.` : "Judged against no device in particular: none is selected."} ${checked}`;
}

function renderInfo() {
  const info = state.appInfo || {};
  $("settings-workspace-file").textContent = info.workspaceFile || "The workspace path has not been reported by the shell yet.";
  $("settings-app-version").textContent = info.appVersion
    ? `${info.appVersion} · Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node}`
    : "—";
  $("settings-platform").textContent = info.platform
    ? `${info.platform}${info.arch ? ` · ${info.arch}` : ""} (reported by the Electron main process)`
    : "—";

  const select = $("select-tile-style");
  const wanted = state.settings.tileStyle === "osm" ? "osm" : "dark";
  if (select.value !== wanted) select.value = wanted;
}

function render() {
  renderInfo();
  renderChecklist();
}

export function initSettings() {
  $("select-tile-style").addEventListener("change", (event) => {
    const style = event.target.value === "osm" ? "osm" : "dark";
    setState({ settings: { ...state.settings, tileStyle: style } });
    persistWorkspace();
    consoleLog.write("info", `Basemap set to ${style === "osm" ? "OpenStreetMap" : "dark grey Esri"}; both maps pick it up on the next frame.`);
  });
  $("btn-show-limitations").addEventListener("click", () => requestLimitations());
  render();
}

export { render as renderSettings };
