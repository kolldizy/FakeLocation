/**
 * Device Center — what is actually connected, and what this build can really do.
 *
 * Every value rendered here comes from one of three places:
 *   1. usbmuxd / lockdownd through the bridge (`devices.discover`);
 *   2. the bridge's own health report (`bridge.health`);
 *   3. the capability matrix, which separates hardware-verified behaviour from
 *      documented-but-untested and unsupported operations.
 *
 * Nothing is inferred: a stage that was not measured stays "NOT CHECKED".
 */

import { api, available as bridgeAvailable } from "./api.js";
import { state, setState, subscribe, persistWorkspace } from "./store.js";
import { bridgeLog, consoleLog, toast, reportError } from "./logpanel.js";
import { showInfo, confirmAction } from "./dialog.js";
import { $, el, clear, fmtTimestamp, mergeStages } from "./util.js";

const STATUS_BADGES = {
  verified_hardware: { className: "tag green", label: "VERIFIED / HARDWARE" },
  documented: { className: "tag amber", label: "DOCUMENTED / NOT TESTED" },
  unknown: { className: "tag grey", label: "UNKNOWN" },
  unsupported: { className: "tag red", label: "UNSUPPORTED" },
};

const STAGES = [
  { key: "usbDetected", label: "USB" },
  { key: "paired", label: "PAIRED" },
  { key: "wirelessReachable", label: "WI-FI" },
  { key: "developerModeEnabled", label: "DEV MODE" },
  { key: "developerServiceAvailable", label: "DEV SERVICE" },
  { key: "tunnelOverWireless", label: "WI-FI TUNNEL" },
  { key: "simulationReady", label: "SIM READY" },
];

let initialised = false;
let scanning = false;
let rescanQueued = false;
let rescanQueuedDeep = false;
let deviceSignature = "";
let matrixSignature = "";
let readinessSignature = "";
let bridgeLogBound = false;

/* ------------------------------------------------------------------- helpers */

function chipFor(value, label) {
  if (value === true) return el("span", { className: "chip ok", text: label });
  if (value === false) return el("span", { className: "chip bad", text: label });
  return el("span", { className: "chip", text: `${label} · ?` });
}

function deviceTitle(device) {
  const identity = device.identity || {};
  return identity.deviceName || (device.connectionType === "USB" ? "iPhone" : "Apple device");
}

function deviceSubtitle(device) {
  const identity = device.identity || {};
  const parts = [];
  if (identity.modelName) parts.push(identity.modelName);
  else if (identity.productType) parts.push(identity.productType);
  if (identity.productVersion) parts.push(`iOS ${identity.productVersion}`);
  if (identity.buildVersion) parts.push(`build ${identity.buildVersion}`);
  parts.push(`${device.connectionType || "unknown link"} · ${device.deviceId}`);
  return parts.join(" · ");
}

/**
 * The mediums this process has actually reached the device on. `proven` is a record of
 * handshakes, `selected` is an explicit choice, and the two are reported apart so a
 * scan that merely saw a network entry cannot read as "the session is wireless".
 */
function linkLine(device) {
  const link = device.link;
  if (!link) return null;
  const proven = link.proven?.transports || [];
  const parts = [proven.length ? `reached on ${proven.join(", ")}` : "reached on nothing yet"];
  parts.push(link.selected ? `using ${link.selected.transport}` : "no transport chosen, so a cable wins");
  if (link.activeSession?.open) {
    parts.push(`session open on ${link.activeSession.transport || "an unreported transport"}${link.activeSession.wireless ? " · wireless" : " · cable"}`);
  }
  return el("div", { className: "hint", attrs: { style: "margin-top:4px;" }, text: `Link: ${parts.join(" · ")}.` });
}

/* ------------------------------------------------------------------- devices */

function deviceCard(device) {
  const selected = device.deviceId === state.selectedDeviceId;

  const select = el("button", {
    className: selected ? "btn tiny primary" : "btn tiny",
    text: selected ? "Selected" : "Use this device",
    attrs: { type: "button" },
  });
  select.addEventListener("click", async (event) => {
    event.stopPropagation();
    setState({ selectedDeviceId: device.deviceId, readiness: null });
    persistWorkspace();
    consoleLog.write("info", `Selected device ${device.deviceId}.`);
    await runReadiness({ silent: true, deviceId: device.deviceId });
  });

  const pair = el("button", { className: "btn tiny ghost", text: "Pair device", attrs: { type: "button" } });
  pair.addEventListener("click", async (event) => {
    event.stopPropagation();
    await runPair(device.deviceId);
  });

  const card = el("div", { className: `list-row${selected ? " selected" : ""}` }, [
    el("div", { className: "device-card" }, [
      el("div", { className: "device-glyph", text: "▣" }),
      el("div", { className: "grow" }, [
        el("div", { className: "name", text: deviceTitle(device) }),
        el("div", { className: "meta", text: deviceSubtitle(device) }),
        el("div", { className: "stage-row" }, STAGES.map((stage) => chipFor(device.stages?.[stage.key], stage.label))),
        device.transport
          ? el("div", {
              className: "hint",
              attrs: { style: "margin-top:9px;" },
              text: `Transport: ${device.transport.planned} — ${device.transport.rationale}`,
            })
          : null,
        linkLine(device),
      ]),
    ]),
    el("div", { className: "btn-row" }, [select, pair]),
  ]);

  if (device.issues?.length) {
    const issues = el("div", { attrs: { style: "width:100%;" } });
    for (const issue of device.issues) {
      issues.appendChild(
        el("div", { className: `banner-note ${issue.severity === "error" ? "danger" : issue.severity === "warning" ? "warn" : ""}` }, [
          el("span", { className: "icon", text: issue.severity === "error" ? "⚠" : "ⓘ" }),
          el("div", { className: "body" }, [
            el("strong", { text: issue.message }),
            issue.detail ? el("p", { text: issue.detail }) : null,
            issue.remedy ? el("p", { text: `Fix: ${issue.remedy}` }) : null,
          ]),
        ])
      );
    }
    card.appendChild(issues);
  }

  card.addEventListener("click", () => {
    if (state.selectedDeviceId === device.deviceId) return;
    setState({ selectedDeviceId: device.deviceId, readiness: null });
    persistWorkspace();
    renderDevices();
  });

  return card;
}

function renderDevices() {
  const nextSignature = JSON.stringify({
    devices: state.devices,
    selected: state.selectedDeviceId,
    scanned: Boolean(state.discovery),
  });
  if (nextSignature === deviceSignature) return;
  deviceSignature = nextSignature;

  const host = $("device-list");
  clear(host);
  if (!state.devices.length) {
    // "No scan yet" and "scan found nothing" are different facts and are worded
    // differently: the second one is an observation about the cable or the driver.
    host.appendChild(
      el("div", {
        className: "empty",
        text: state.discovery
          ? "No iPhone is attached. Connect one with a data-capable cable, unlock it and tap Trust, then scan again."
          : "No scan has been run yet.",
      })
    );
    return;
  }
  for (const device of state.devices) host.appendChild(deviceCard(device));
}

export async function runDiscovery({ deep }) {
  if (!bridgeAvailable) {
    toast("Discovery unavailable", "Device discovery needs the desktop app and the Python bridge.", { kind: "error" });
    return;
  }
  if (scanning) {
    // A scan is already running. Rather than dropping the request (which would leave
    // the list stale), remember it and run exactly one more scan when it finishes.
    rescanQueued = true;
    rescanQueuedDeep = rescanQueuedDeep || deep;
    return;
  }
  scanning = true;
  $("btn-refresh-devices").disabled = true;
  $("btn-discover-deep").disabled = true;
  $("discovery-status").textContent = deep
    ? "Deep scan: enumerating usbmuxd and reading each device over lockdown…"
    : "Scanning usbmuxd…";

  try {
    const report = await api.discoverDevices({ probeIdentity: deep });
    const devices = report.devices || [];
    // A cheap scan skips lockdown, so it cannot report identity, pairing or
    // Developer Mode. Keep what the last deep scan observed for the same device
    // instead of dropping those stages back to "not checked".
    const merged = devices.map((device) => {
      if (device.identity || deep) return device;
      const previous = state.devices.find((entry) => entry.deviceId === device.deviceId);
      if (!previous) return device;
      return {
        ...device,
        identity: previous.identity,
        transport: device.transport || previous.transport,
        // The bridge reports `null` for stages a cheap scan cannot see (pairing,
        // Developer Mode) and for stages it has no observation about at all. A fresh
        // non-null value is newer and wins; `null` falls back to what was seen before.
        // `usbDetected` is not forced: the scan states the medium it actually saw.
        stages: mergeStages(previous.stages, device.stages),
        issues: device.issues.length ? device.issues : previous.issues,
      };
    });
    setState({ devices: merged, discovery: report });
    if (!state.selectedDeviceId && devices.length) {
      setState({ selectedDeviceId: devices[0].deviceId });
      persistWorkspace();
    }
    const usbmux = report.usbmux || {};
    const parts = [`${devices.length} device(s) in ${report.durationMs ?? 0} ms`];
    if (usbmux.address) parts.push(`usbmuxd ${usbmux.address}`);
    if (report.errors?.length) parts.push(report.errors.join(" "));
    $("discovery-status").textContent = parts.join(" · ");
    bridgeLog.write("device", `Discovery found ${devices.length} device(s). Scanned at ${fmtTimestamp(report.scannedAt)}.`);
    consoleLog.write("device", `Discovery: ${devices.length} device(s).`);
    if (deep) await loadCapabilities();
  } catch (error) {
    $("discovery-status").textContent = error.message;
    reportError(error, "Discovery");
  } finally {
    scanning = false;
    $("btn-refresh-devices").disabled = false;
    $("btn-discover-deep").disabled = false;
    if (rescanQueued) {
      const deep = rescanQueuedDeep;
      rescanQueued = false;
      rescanQueuedDeep = false;
      void runDiscovery({ deep });
    }
  }
}

/* -------------------------------------------------------------------- pairing */

async function runPair(deviceId) {
  if (!bridgeAvailable) return;
  const confirmed = await confirmAction({
    title: "Pair with this iPhone",
    message:
      "Pairing asks the iPhone to trust this computer. Unlock the phone first — a “Trust This Computer?” prompt appears on the device and must be accepted there.",
    confirmLabel: "Start pairing",
    hint: "Location Studio only reads the pairing record; it never changes device settings.",
  });
  if (!confirmed) return;

  toast("Pairing", "Waiting for the iPhone to confirm. Unlock it and tap Trust.", { kind: "warn", sticky: true });
  bridgeLog.write("info", `Pairing started for ${deviceId}.`);
  try {
    const result = await api.pairDevice({ deviceId, timeoutSeconds: 60 });
    bridgeLog.write("ok", `Pairing confirmed. ${result.identity?.deviceName || deviceId}`);
    toast("Pairing confirmed", "The iPhone accepted this computer.", { kind: "ok" });
    await runDiscovery({ deep: true });
  } catch (error) {
    reportError(error, "Pairing");
  }
}

/* ------------------------------------------------------------------ readiness */

function checkRow(check, index) {
  const mark = check.ok === true ? "✓" : check.ok === false ? "✕" : "?";
  return el("div", { className: "check", attrs: { "data-ok": String(check.ok) } }, [
    el("span", { className: "mark", text: mark }),
    el("div", { className: "body" }, [
      el("div", { className: "label", text: check.label || `Check ${index + 1}` }),
      check.detail ? el("div", { className: "detail", text: check.detail }) : null,
      check.remedy ? el("div", { className: "remedy", text: `Fix: ${check.remedy}` }) : null,
    ]),
  ]);
}

function renderReadiness() {
  const report = state.readiness;
  const nextSignature = JSON.stringify(report);
  if (nextSignature === readinessSignature) return;
  readinessSignature = nextSignature;

  const host = $("readiness-list");
  const tag = $("readiness-tag");
  clear(host);

  if (!report) {
    tag.className = "tag grey";
    tag.textContent = "NOT RUN";
    host.appendChild(
      el("div", {
        className: "empty",
        text: "Run the readiness check to verify USB, pairing, Developer Mode and the developer service.",
      })
    );
    $("readiness-summary").textContent = "";
    return;
  }

  tag.className = report.ready ? "tag green" : "tag red";
  tag.textContent = report.ready ? "READY" : "NOT READY";
  for (const [index, check] of (report.checks || []).entries()) host.appendChild(checkRow(check, index));
  const medium = report.transport
    ? `Checked over ${report.transportLabel || report.transport}${report.wireless ? " with the cable free" : ""}.`
    : "The bridge did not name the transport this check ran over.";
  $("readiness-summary").textContent = `${report.summary} ${medium} Checked ${fmtTimestamp(report.checkedAt)}.`;
}

/**
 * Fold the facts a readiness check measured into the device list: the stage flags
 * it verified and the identity it read over lockdown. Both come from the bridge, so
 * the card shows measurements instead of waiting for another scan to catch up.
 */
function applyMeasuredFacts(report) {
  const stages = report?.stages || {};
  const identity = report?.identity || null;
  if (!report?.deviceId || (!identity && !Object.keys(stages).length)) return;
  const devices = state.devices.map((device) =>
    device.deviceId === report.deviceId
      ? { ...device, identity: identity || device.identity, stages: mergeStages(device.stages, stages) }
      : device
  );
  setState({ devices });
}

export async function runReadiness({ silent = false, deviceId = null, transport = null } = {}) {
  const target = deviceId || state.selectedDeviceId;
  if (!target) {
    if (!silent) toast("No device selected", "Choose a device in the list first.", { kind: "warn" });
    return;
  }
  if (!bridgeAvailable) {
    if (!silent) toast("Readiness unavailable", "This needs the desktop app and the Python bridge.", { kind: "error" });
    return;
  }
  $("btn-readiness").disabled = true;
  $("readiness-tag").textContent = transport ? `RUNNING · ${String(transport).toUpperCase()}…` : "RUNNING…";
  $("readiness-tag").className = "tag cyan";
  try {
    const request = { deviceId: target, openTunnel: true };
    // Pinning is what makes a wireless pass mean wireless. When a cable and a network
    // entry both exist, usbmuxd answers on the cable, so an unpinned check can go green
    // over a medium nobody asked about.
    if (transport) request.transport = transport;
    const report = await api.checkReadiness(request);
    setState({ readiness: report, readyDeviceId: report.ready ? target : state.readyDeviceId });
    readinessSignature = ""; // the report changed identity, so redraw
    renderReadiness();
    bridgeLog.write(
      report.ready ? "ok" : "warn",
      `Readiness for ${target}${report.transport ? ` over ${report.transport}` : ""}: ${report.summary}`
    );
    applyMeasuredFacts(report);
    if (!silent) {
      toast(report.ready ? "Device ready" : "Not ready yet", report.summary, { kind: report.ready ? "ok" : "warn", sticky: !report.ready });
    }
  } catch (error) {
    setState({ readiness: null });
    readinessSignature = "";
    renderReadiness();
    reportError(error, "Readiness check");
  } finally {
    $("btn-readiness").disabled = false;
  }
}

/* ----------------------------------------------------------------- capabilities */

function renderMatrix() {
  const rows = state.capabilities;
  const nextSignature = JSON.stringify(rows);
  if (nextSignature === matrixSignature) return;
  matrixSignature = nextSignature;

  const host = $("capability-matrix");
  clear(host);
  host.appendChild(
    el("div", { className: "matrix-row head" }, [
      el("span", { text: "CAPABILITY" }),
      el("span", { text: "STATUS" }),
      el("span", { text: "EVIDENCE" }),
    ])
  );

  if (!rows || !rows.length) {
    host.appendChild(
      el("div", { className: "matrix-row" }, [
        el("span", { className: "cap-name", text: "Not loaded yet" }),
        el("span", {}, [el("span", { className: "tag grey", text: "UNKNOWN" })]),
        el("span", { className: "cap-note", text: "Run a deep scan or press “Load matrix” to read the bridge's capability report." }),
      ])
    );
    return;
  }

  for (const entry of rows) {
    const badge = STATUS_BADGES[entry.status] || STATUS_BADGES.unknown;
    host.appendChild(
      el("div", { className: "matrix-row" }, [
        el("span", { className: "cap-name", text: entry.name }),
        el("span", {}, [el("span", { className: badge.className, text: badge.label })]),
        el("span", { className: "cap-note" }, [
          el("span", { text: entry.evidence || "No evidence recorded." }),
          entry.notes ? el("em", { text: ` — ${entry.notes}` }) : null,
        ]),
      ])
    );
  }
}

async function loadCapabilities() {
  if (!bridgeAvailable) return;
  try {
    const report = await api.getCapabilities(state.selectedDeviceId ? { deviceId: state.selectedDeviceId } : {});
    setState({ capabilities: report.capabilities || [] });
    renderCapabilityProvenance(report.provenance || null);
  } catch (error) {
    consoleLog.write("warn", `Capability matrix could not be loaded: ${error.message}`);
  }
}

/**
 * Put a date and a device under every "VERIFIED / HARDWARE" badge.
 *
 * The matrix is authored, not measured: it says what this build was once shown to do. Without
 * this line a green badge in a panel that is not scanning anything reads as a claim about the
 * phone on the desk, which is exactly the kind of inference the brief forbids.
 */
function renderCapabilityProvenance(provenance) {
  const host = $("capability-provenance");
  if (!host) return;
  const attached = state.devices.length;
  if (!provenance) {
    host.textContent = `The bridge sent no provenance with these rows, so treat every hardware badge as unverified. This session has ${attached} iPhone(s) attached.`;
    return;
  }
  host.textContent =
    `“Verified on hardware” means reproduced by hand on ${provenance.verifiedOn} against ${provenance.bench}. ` +
    `${provenance.note} This session has ${attached} iPhone(s) attached, and only a deep scan measures them.`;
}

/* ------------------------------------------------------------------- bridge UI */

function renderBridge() {
  const status = state.bridge || {};
  const health = state.health;
  const tag = $("bridge-tag");
  const ok = status.state === "ready" && health;
  tag.className = ok ? "tag green" : status.state === "ready" ? "tag cyan" : status.state === "crashed" ? "tag red" : "tag grey";
  tag.textContent = String(status.state || "unknown").toUpperCase();

  $("kv-bridge-state").textContent = status.detail || "—";
  if (!health) {
    for (const id of ["kv-bridge-python", "kv-bridge-pmd", "kv-bridge-platform", "kv-bridge-usbmux", "kv-bridge-drivers"]) {
      $(id).textContent = "—";
    }
  } else {
    $("kv-bridge-python").textContent = health.python ? `${health.python.version} (${health.python.executable})` : "—";
    $("kv-bridge-pmd").textContent = health.pymobiledevice3?.available
      ? health.pymobiledevice3.version
      : `not installed — ${health.pymobiledevice3?.error || "unknown error"}`;
    // Windows 11 reports release "10" through the version APIs unless the calling
    // process declares compatibility, so the build number is shown next to it —
    // otherwise this row states a version the machine is not.
    $("kv-bridge-platform").textContent = health.platform
      ? `${health.platform.system} ${health.platform.release}${health.platform.version ? ` · build ${health.platform.version}` : ""} (${health.platform.machine})`
      : "—";
    $("kv-bridge-usbmux").textContent = health.usbmux?.available
      ? `${health.usbmux.address} · ${health.usbmux.deviceCount} device(s)`
      : `${health.usbmux?.error || "unavailable"}${health.usbmux?.remedy ? ` — ${health.usbmux.remedy}` : ""}`;
    $("kv-bridge-drivers").textContent = health.appleUsbDrivers
      ? `${health.appleUsbDrivers.ok ? "present" : "not found"} — ${health.appleUsbDrivers.note}`
      : "—";
  }
  $("kv-bridge-workspace").textContent = state.appInfo?.workspaceFile || "—";
}

function renderSetupChecklist() {
  const health = state.health;
  const selected = state.devices.find((device) => device.deviceId === state.selectedDeviceId);

  const set = (id, value) => {
    const node = $(id);
    if (node) node.setAttribute("data-ok", String(value));
  };

  set("setup-check-driver", health ? Boolean(health.appleUsbDrivers?.ok) : null);
  set("setup-check-cable", state.devices.length ? true : health ? false : null);
  set("setup-check-trust", selected ? selected.stages?.paired ?? null : null);
  set("setup-check-developer-mode", selected ? selected.stages?.developerModeEnabled ?? null : null);
  set("setup-check-unlocked", null); // not observable without user interaction
}

/* ------------------------------------------------------------------------ init */

export async function refreshHealth() {
  if (!bridgeAvailable) return;
  try {
    const health = await api.getBridgeHealth();
    setState({ health });
    renderBridge();
    renderSetupChecklist();
    if (health.notes?.length) for (const note of health.notes) bridgeLog.write("warn", note);
  } catch (error) {
    setState({ health: null });
    renderBridge();
    bridgeLog.write("error", `Bridge health failed: ${error.message}`);
  }
}

export function initDeviceCenter() {
  if (initialised) return;
  initialised = true;

  if (!bridgeLogBound) {
    bridgeLogBound = true;
    if (bridgeAvailable) {
      api.onBridgeLog((line) => {
        const level = /error|traceback|exception/i.test(line) ? "error" : /warn/i.test(line) ? "warn" : "info";
        bridgeLog.write(level, line);
      });
    }
  }

  $("btn-refresh-devices").addEventListener("click", () => {
    runDiscovery({ deep: false }).catch(() => {});
  });
  $("btn-discover-deep").addEventListener("click", () => {
    runDiscovery({ deep: true }).catch(() => {});
  });
  $("btn-readiness").addEventListener("click", () => {
    runReadiness().catch(() => {});
  });
  $("btn-health").addEventListener("click", () => {
    refreshHealth().catch(() => {});
  });
  $("btn-clear-log").addEventListener("click", () => bridgeLog.clear());
  $("btn-reveal-workspace").addEventListener("click", async () => {
    try {
      const result = await api.revealWorkspaceFile();
      consoleLog.write("info", `Workspace file: ${result.filePath}`);
    } catch (error) {
      reportError(error, "Revealing the workspace file");
    }
  });
  $("btn-open-setup").addEventListener("click", () => {
    showInfo({
      title: "Bridge setup",
      children: [
        el("p", {
          text:
            "Location Studio talks to the iPhone through a local Python bridge. The app starts it automatically; these are the steps it needs.",
        }),
        el("div", {
          className: "log",
          attrs: { style: "height:auto; max-height:290px; margin-top:10px; font-size:10.5px;" },
          text: [
            "1. Install Python 3.11 or newer for Windows (python.org).",
            "2. In the project folder run:",
            "     py -3.11 -m venv .venv",
            "     .venv\\Scripts\\python.exe -m pip install -r bridge\\requirements.txt",
            "3. Install “Apple Devices” from the Microsoft Store so the Apple Mobile",
            "   Device Service provides usbmuxd.",
            "4. Connect the iPhone with a data cable, unlock it and tap Trust.",
            "5. On the iPhone: Settings → Privacy & Security → Developer Mode → on,",
            "   then restart the phone and enter the passcode.",
            "",
            "No administrator rights are required, and the app never installs drivers,",
            "changes security settings or enables Developer Mode on your behalf.",
            "",
            "The bridge runs as a child process of this app and communicates over a",
            "newline-delimited JSON channel on stdin/stdout. The window can only call",
            "the fixed commands listed in electron/ipc.cjs — it has no shell access.",
          ].join("\n"),
        }),
        el("p", {
          attrs: { style: "margin-top:12px;" },
          text: "If the bridge reports a missing dependency, install it into the project venv and press “Re-check bridge”.",
        }),
      ],
    }).catch(() => {});
  });

  subscribe(() => {
    if (!initialised) return;
    renderDevices();
    renderReadiness();
    renderMatrix();
    renderBridge();
    renderSetupChecklist();
  });

  renderDevices();
  renderReadiness();
  renderMatrix();
  renderBridge();
  loadCapabilities().catch(() => {});
  refreshHealth().catch(() => {});
}
