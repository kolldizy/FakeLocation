/**
 * Header device strip — the one place that answers "am I talking to a phone?".
 *
 * §4 of the brief wants connection state, transport, model, pairing and tunnel status
 * always visible, and nothing here may infer any of them:
 *   - CONNECTED requires an open developer session the bridge reported *for the device
 *     now selected*, not merely a device that appeared on USB;
 *   - model and iOS version come from an identity a handshake returned, so a cheap scan
 *     leaves them as "not read" instead of guessing from the USB descriptor;
 *   - pairing and tunnel are tri-state, and "not measured" is drawn as unknown.
 *
 * Connect is the strip's only action. It delegates to the wireless module, which still
 * confirms before opening anything, so this header never performs a device operation.
 */

import { state } from "./store.js";
import { connectSelectedDevice } from "./wireless.js";
import { $ } from "./util.js";

const TRANSPORT_TEXT = {
  usb: "USB",
  "wifi-mux": "WI-FI",
  "rsd-lan": "WI-FI",
  "wifi-lockdown": "WI-FI",
};

/** The device the rest of the app is acting on: the selection, else the only one. */
function currentDevice() {
  if (!state.devices.length) return null;
  return state.devices.find((device) => device.deviceId === state.selectedDeviceId) || state.devices[0];
}

/**
 * The link report that describes `device`.
 *
 * `state.wirelessLink` is refreshed for the selected device, so it can describe a
 * different phone than the one now shown. When it names another device, the per-device
 * link recorded at discovery is used instead — a session opened on one iPhone must not
 * light the strip up as connected while another is selected.
 */
function linkFor(device) {
  const live = state.wirelessLink;
  const liveId = live?.selected?.deviceId;
  if (!device || !liveId || liveId === device.deviceId) return live;
  return device.link || null;
}

function sessionIsLive(session) {
  return Boolean(session && ["preparing", "active", "paused", "completed"].includes(session.state));
}

function setCell(id, text, toneName) {
  const cell = $(id);
  cell.textContent = text;
  // The header can run out of room before the bridge runs out of things to say. The
  // value then ellipsizes, so the whole verdict stays reachable on hover.
  cell.title = text;
  cell.closest(".strip-item").dataset.tone = toneName;
}

function render() {
  const device = currentDevice();
  const link = linkFor(device);
  const tunnel = state.wirelessTunnel;
  const identity = device?.identity || {};
  const stages = device?.stages || {};
  const session = state.session;
  const bridgeReady = state.bridge?.state === "ready";
  const open = Boolean(link?.activeSession?.open);

  if (!device) {
    setCell("strip-state", bridgeReady ? "NO DEVICE" : "CHECKING…", "neutral");
  } else if (open) {
    setCell("strip-state", "CONNECTED", "ok");
  } else if (stages.paired === true) {
    setCell("strip-state", "PAIRED, NOT LINKED", "warn");
  } else if (stages.paired === false) {
    setCell("strip-state", "UNTRUSTED", "bad");
  } else {
    setCell("strip-state", "SEEN, NOT PAIRED", "warn");
  }

  if (!device) {
    setCell("strip-transport", "—", "neutral");
  } else if (link?.activeSession?.open) {
    setCell(
      "strip-transport",
      `${TRANSPORT_TEXT[link.activeSession.transport] || "LINK"}${link.activeSession.wireless ? " · CABLE-FREE" : " · CABLE"}`,
      link.activeSession.wireless ? "live" : "neutral"
    );
  } else if (device.connectionType) {
    setCell("strip-transport", String(device.connectionType).toUpperCase(), "warn");
  } else {
    setCell("strip-transport", "NOT READ", "neutral");
  }

  const parts = [];
  if (identity.deviceName) parts.push(identity.deviceName);
  if (identity.productVersion) parts.push(`iOS ${identity.productVersion}`);
  setCell("strip-model", parts.length ? parts.join(" · ") : "NOT READ", "neutral");

  if (!device) {
    setCell("strip-pairing", "—", "neutral");
  } else if (stages.paired === true && stages.trusted === true) {
    setCell("strip-pairing", "TRUSTED", "ok");
  } else if (stages.paired === true) {
    setCell("strip-pairing", "RECORD, TRUST UNCONFIRMED", "warn");
  } else if (stages.paired === false) {
    setCell("strip-pairing", "NOT PAIRED", "bad");
  } else {
    setCell("strip-pairing", "UNKNOWN", "neutral");
  }

  if (!device) {
    setCell("strip-tunnel", "—", "neutral");
  } else if (tunnel?.open && tunnel.deviceId === device.deviceId) {
    setCell("strip-tunnel", tunnel.wireless ? "OPEN · CABLE-FREE" : "OPEN · CABLE", "ok");
  } else if (tunnel?.open) {
    setCell("strip-tunnel", "OPEN ON ANOTHER DEVICE", "warn");
  } else {
    setCell("strip-tunnel", "CLOSED", "neutral");
  }

  const button = $("btn-strip-connect");
  button.textContent = open ? "Reconnect" : "Connect";
  button.disabled = true;
  if (!bridgeReady) {
    button.title = "The Python device bridge is not answering, so no transport can be opened.";
  } else if (!device) {
    button.title = "No iPhone has been reported by the Apple Mobile Device Service. Connect a cable, then scan in Device.";
  } else if (sessionIsLive(session) && !open) {
    button.title = "A simulation is running. Stop it in Location before changing the link it is published over.";
  } else {
    button.disabled = false;
    button.title = open
      ? "Re-run the lockdown handshake and, on iOS 17+, the developer tunnel over the transport available now."
      : "Open lockdown and, on iOS 17+, the developer tunnel over the transport this PC can actually reach.";
  }
}

export function initDeviceStrip() {
  $("btn-strip-connect").addEventListener("click", () => {
    connectSelectedDevice().catch(() => {});
  });
  render();
}

export { render as renderDeviceStrip };
