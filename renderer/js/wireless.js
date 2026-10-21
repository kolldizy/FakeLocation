/**
 * Wireless Link — which transport this PC can really reach an iPhone on.
 *
 * Every row here comes from a probe that completed or a connect that answered:
 *   - a usbmuxd entry with connection type Network is a mux fact;
 *   - an mDNS answer is only an advertisement;
 *   - only a completed lockdown handshake, tunnel or developer-service lookup is
 *     reported as reachability.
 *
 * The distinction matters because the three are easy to confuse and a wrong one reads
 * as "connected". A device that was merely advertised is never drawn as a device that
 * was reached, and nothing in this panel starts a location override — that stays in
 * the Simulation Console, so a preview can never be mistaken for a device operation.
 */

import { api, available as bridgeAvailable } from "./api.js";
import { state, setState, subscribe } from "./store.js";
import { bridgeLog, consoleLog, toast, reportError } from "./logpanel.js";
import { showInfo, confirmAction } from "./dialog.js";
import { runReadiness } from "./devicecenter.js";
import { $, el, clear, fmtTimestamp } from "./util.js";

/** The transports `wireless.connect` accepts. Mirrors the bridge's allowlist exactly. */
const CONNECTABLE = new Set(["usb", "wifi-mux", "rsd-lan"]);

const TRANSPORT_TITLE = {
  usb: "USB cable",
  "wifi-mux": "Wi-Fi · network entry in the Apple Mobile Device Service",
  "rsd-lan": "Wi-Fi · RemoteServiceDiscovery answered on the LAN",
  "wifi-lockdown": "Wi-Fi · lockdown over TCP 62078",
};

const MOBDEV2_NOTE =
  "lockdownd finished a handshake over the network with no usbmuxd entry involved. This build does not open a developer tunnel through that path, so it is recorded as an observation and never offered as a link.";

/**
 * Capability words the bridge emits. "possible-unverified" deliberately has no green
 * badge: it means the prerequisites were measured, not that a device accepted a tunnel.
 */
const CAPABILITY_BADGES = {
  "possible-unverified": { className: "tag amber", label: "PREREQUISITES MET / NOT CHECKED" },
  "not-possible": { className: "tag red", label: "NOT POSSIBLE" },
  unknown: { className: "tag grey", label: "UNKNOWN" },
};

const DEFAULT_SUMMARY =
  'Nothing here is filled in until a probe answers. Press “Discover devices” to ask usbmuxd, the local multicast DNS browser and lockdownd what they actually see.';

let initialised = false;
let probing = false;
let connecting = false;
let probeSignature = "";
let linkSignature = "";
let issueSignature = "";
/** Why the last probe request itself failed; kept so a failed probe stays visible. */
let probeFailure = "";

/* ------------------------------------------------------------------ accessors */

function probeReport() {
  return state.wireless;
}

function candidateFor(deviceId) {
  const probe = probeReport();
  if (!probe || !deviceId) return null;
  return (probe.candidates || []).find((entry) => entry.deviceId === deviceId) || null;
}

function linkSummary() {
  return state.wirelessLink;
}

function selectedTransport() {
  return linkSummary()?.selected?.transport || null;
}

function triMark(value) {
  return value === true ? "✓" : value === false ? "✕" : "?";
}

function dataOk(value) {
  return String(value === true ? true : value === false ? false : null);
}

/* ---------------------------------------------------------------- link status */

function renderMetrics() {
  const probe = probeReport();
  const tunnel = state.wirelessTunnel;

  if (!probe) {
    $("link-usb").textContent = "—";
    $("link-wifi").textContent = "—";
    $("link-tunnel").textContent = "—";
    return;
  }
  const usb = probe.transports?.usb || {};
  const wifi = probe.transports?.["wifi-mux"] || {};
  const rsd = probe.transports?.["rsd-lan"] || {};
  $("link-usb").textContent = `${usb.deviceCount ?? 0} entry`;
  $("link-wifi").textContent = `${wifi.deviceCount ?? 0} entry · ${rsd.deviceCount ?? 0} RSD`;
  $("link-tunnel").textContent = tunnel?.open
    ? `${tunnel.transport || "unknown link"}${tunnel.wireless ? " · wireless" : " · cable"}`
    : tunnel
      ? "not open"
      : "—";
}

function transportRow(key, entry) {
  const available = entry?.available;
  const body = [
    el("div", { className: "label", text: `${TRANSPORT_TITLE[key] || key} — ${entry?.deviceCount ?? 0} device(s)` }),
    entry?.note ? el("div", { className: "detail", text: entry.note }) : null,
    entry?.error ? el("div", { className: "detail", text: `Discovery of this transport failed: ${entry.error}` }) : null,
    available === false && entry?.prerequisite ? el("div", { className: "remedy", text: entry.prerequisite }) : null,
  ];
  return el("div", { className: "check", attrs: { "data-ok": dataOk(available) } }, [
    el("span", { className: "mark", text: triMark(available) }),
    el("div", { className: "body" }, body.filter(Boolean)),
  ]);
}

function renderTransports() {
  const host = $("wireless-transports");
  const probe = probeReport();
  const signature = JSON.stringify(probe?.transports ?? null);
  if (signature === probeSignature && probe) return;
  probeSignature = signature;

  clear(host);
  if (!probe) {
    const failed = Boolean(probeFailure);
    host.appendChild(
      el("div", {
        className: "empty",
        text: failed
          ? "The probe request itself failed, so no transport has been measured and nothing below is a network result."
          : "No probe has run, so no transport has been measured.",
      })
    );
    $("wireless-summary").textContent = failed ? `The probe did not finish: ${probeFailure}` : DEFAULT_SUMMARY;
    const tag = $("wireless-probed-tag");
    tag.className = failed ? "tag red" : "tag grey";
    tag.textContent = failed ? "PROBE FAILED" : "NOT PROBED";
    return;
  }
  for (const key of ["usb", "wifi-mux", "rsd-lan"]) host.appendChild(transportRow(key, probe.transports?.[key]));

  const verdict = probe.verdict || {};
  const parts = [verdict.summary || ""];
  if (probe.probedAt) parts.push(`Probed ${fmtTimestamp(probe.probedAt)} (${probe.durationMs ?? 0} ms).`);
  $("wireless-summary").textContent = parts.filter(Boolean).join(" ");

  const ready = (verdict.wirelessHandshakeReady || []).length;
  const tag = $("wireless-probed-tag");
  if (ready) {
    tag.className = "tag amber";
    tag.textContent = "WI-FI HANDSHAKE OK / SERVICE NOT CHECKED";
  } else if (verdict.wirelessSeen) {
    tag.className = "tag cyan";
    tag.textContent = "SEEN, NOT REACHED";
  } else {
    tag.className = "tag red";
    tag.textContent = "NO WIRELESS PATH";
  }
}

/* ------------------------------------------------------------------ candidates */

function seenChips(candidate) {
  const seen = new Set(candidate.seenOn || []);
  const reached = new Set(candidate.reachableOver || []);
  const keys = [...new Set([...seen, ...reached, ...(candidate.reachableOver || [])])];
  return keys.map((key) => {
    const reachedOver = reached.has(key);
    const label = key === "wifi-lockdown" ? "LOCKDOWN TCP" : key === "rsd-lan" ? "RSD ADVERTISED" : key === "usb" ? "USB" : "NETWORK ENTRY";
    const className = reachedOver ? "chip ok" : seen.has(key) ? "chip warn" : "chip";
    return el("span", { className, text: reachedOver ? `${label} · REACHED` : `${label} · SEEN ONLY` });
  });
}

function candidateMeta(candidate) {
  const identity = candidate.identity || {};
  const parts = [];
  if (identity.productVersion) parts.push(`iOS ${identity.productVersion}`);
  else if (candidate.seenOn?.includes("rsd-lan")) parts.push("iOS version from the advertisement, not the device");
  if (candidate.modelName) parts.push(candidate.modelName);
  else if (identity.productType) parts.push(identity.productType);
  if (identity.buildVersion) parts.push(`build ${identity.buildVersion}`);
  const mode = identity.developerModeEnabled;
  parts.push(mode === true ? "Developer Mode on" : mode === false ? "Developer Mode off" : "Developer Mode not read");
  parts.push(candidate.deviceId);
  return parts.join(" · ");
}

function connectButton(candidate, transport) {
  const isWireless = transport !== "usb";
  const button = el("button", {
    className: "btn tiny",
    text: isWireless ? `Connect ${transport}` : "Connect USB",
    attrs: { type: "button", title: TRANSPORT_TITLE[transport] },
  });
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    connectTransport(candidate.deviceId, transport).catch(() => {});
  });
  return button;
}

function candidateRow(candidate) {
  const selected = candidate.deviceId === state.selectedDeviceId;
  const select = el("button", {
    className: selected ? "btn tiny primary" : "btn tiny ghost",
    text: selected ? "Selected" : "Use this device",
    attrs: { type: "button" },
  });
  select.addEventListener("click", (event) => {
    event.stopPropagation();
    setState({ selectedDeviceId: candidate.deviceId, readiness: null });
    refreshLinkStatus().catch(() => {});
    consoleLog.write("info", `Selected ${candidate.deviceId} from the wireless probe.`);
  });

  const buttons = [select];
  for (const transport of candidate.seenOn || []) {
    if (CONNECTABLE.has(transport)) buttons.push(connectButton(candidate, transport));
  }
  // A cable-visible device can always be reached over USB even when this probe only
  // listed it as a network device, so the wired fallback is offered explicitly.
  if (probeReport()?.transports?.usb?.devices?.some((device) => device.deviceId === candidate.deviceId)) {
    buttons.push(connectButton(candidate, "usb"));
  }

  const capability = candidate.capability || {};
  const badge = CAPABILITY_BADGES[capability.status] || CAPABILITY_BADGES.unknown;
  const tunnel = candidate.tunnel || {};
  const reached = candidate.reachableOver || [];

  const row = el("div", { className: `list-row${selected ? " selected" : ""}` }, [
    el("div", { className: "device-card" }, [
      el("div", { className: "device-glyph", text: "≋" }),
      el("div", { className: "grow" }, [
        el("div", { className: "name", text: candidate.displayName || candidate.modelName || "iPhone" }),
        el("div", { className: "meta", text: candidateMeta(candidate) }),
        el("div", { className: "stage-row" }, seenChips(candidate)),
        el("div", { className: "hint", attrs: { style: "margin-top:9px;" }, text: `Tunnel: ${tunnel.reason || "not assessed."}` }),
        el("div", { className: "hint", attrs: { style: "margin-top:4px;" } }, [
          el("span", { className: badge.className, text: badge.label }),
          el("span", { text: ` ${capability.reason || ""}` }),
        ]),
        capability.remedy ? el("div", { className: "hint warn", text: `Fix: ${capability.remedy}` }) : null,
        reached.includes("wifi-lockdown") ? el("div", { className: "hint", text: MOBDEV2_NOTE }) : null,
        ...(candidate.probes || [])
          .filter((entry) => entry.ok !== true)
          .map((entry) =>
            el("div", {
              className: "hint",
              text: `${TRANSPORT_TITLE[entry.transport] || entry.transport}: ${entry.detail}${entry.remedy ? ` Fix: ${entry.remedy}` : ""}`,
            })
          ),
      ]),
    ]),
    el("div", { className: "btn-row" }, buttons),
  ]);

  row.addEventListener("click", () => {
    if (state.selectedDeviceId === candidate.deviceId) return;
    setState({ selectedDeviceId: candidate.deviceId, readiness: null });
    refreshLinkStatus().catch(() => {});
  });
  return row;
}

function renderCandidates() {
  const probe = probeReport();
  const host = $("wireless-candidates");
  const candidates = probe?.candidates || [];
  const signature = JSON.stringify({ candidates, selected: state.selectedDeviceId, usb: probe?.transports?.usb?.devices });
  if (signature === linkSignature) return;
  linkSignature = signature;

  clear(host);
  $("wireless-candidate-count").textContent = `${candidates.length} SEEN`;
  if (!probe) {
    host.appendChild(el("div", { className: "empty", text: "No wireless probe has been run in this session." }));
    return;
  }
  if (!candidates.length) {
    host.appendChild(
      el("div", {
        className: "empty",
        text:
          "The probe finished and no iPhone was listed as a network device or an RSD advertisement. That is an " +
          "observation about the network, not a connection failure: wireless has to be enabled once per device.",
      })
    );
    return;
  }
  for (const candidate of candidates) host.appendChild(candidateRow(candidate));
}

/* ------------------------------------------------------------- capability panel */

function capabilityRow(label, value, detail, remedy) {
  return el("div", { className: "check", attrs: { "data-ok": dataOk(value) } }, [
    el("span", { className: "mark", text: triMark(value) }),
    el("div", { className: "body" }, [
      el("div", { className: "label", text: label }),
      detail ? el("div", { className: "detail", text: detail }) : null,
      remedy ? el("div", { className: "remedy", text: `Fix: ${remedy}` }) : null,
    ]),
  ]);
}

function renderCapability() {
  const host = $("wireless-capability");
  const deviceId = state.selectedDeviceId;
  const candidate = candidateFor(deviceId);
  const link = linkSummary();
  const tunnel = state.wirelessTunnel;
  const readiness = state.readiness;
  const session = state.session;

  clear(host);
  const active = Boolean(link?.activeSession?.open);
  const wirelessSession = Boolean(active && tunnel?.wireless);

  // 1. Was any wireless transport actually reached?
  const reached = candidate?.reachableOver || [];
  host.appendChild(
    capabilityRow(
      "Wireless handshake",
      reached.some((t) => t !== "usb") ? true : candidate ? false : null,
      reached.length
        ? `Reached on: ${reached.map((t) => TRANSPORT_TITLE[t] || t).join(", ")}.`
        : candidate
          ? "This iPhone was seen but no wireless handshake completed."
          : "No wireless probe result for the selected device.",
      candidate && !reached.length ? candidate.capability?.remedy : null
    )
  );

  // 2. Developer tunnel — only what the running session reports about itself.
  const tunnelCheck = (readiness?.checks || []).find((check) => check.id === "tunnel");
  const pinnedToThisDevice = readiness?.deviceId === deviceId;
  host.appendChild(
    capabilityRow(
      "Developer tunnel",
      active ? (wirelessSession ? true : false) : pinnedToThisDevice ? tunnelCheck?.ok ?? null : null,
      active
        ? wirelessSession
          ? `Open over ${link.activeSession.transport || tunnel?.transport || "an unreported transport"}, cable-free.`
          : `Open, but on ${link.activeSession.transport || tunnel?.transport || "the cable"} — not a wireless session.`
        : pinnedToThisDevice && tunnelCheck
          ? `${tunnelCheck.detail || tunnelCheck.label} Checked over ${readiness.transportLabel || readiness.transport || "an unreported transport"}.`
          : "No developer session is open for this device.",
      (active && !wirelessSession
        ? "Disconnect the link, unplug the cable and connect the wireless transport again."
        : tunnelCheck?.remedy) || null
    )
  );

  // 3. Developer service — the readiness check is the only thing that queries it.
  const serviceCheck = (readiness?.checks || []).find((check) => check.id === "developer_service");
  host.appendChild(
    capabilityRow(
      "Developer service (DVT)",
      pinnedToThisDevice ? serviceCheck?.ok ?? null : null,
      pinnedToThisDevice
        ? serviceCheck
          ? `${serviceCheck.detail || serviceCheck.label} Measured on ${readiness.transportLabel || readiness.transport || "an unnamed transport"}.`
          : "The last readiness check for this device did not report a developer-service step."
        : readiness
          ? `The last readiness check was for ${readiness.deviceId}, not this device.`
          : "Readiness has not been checked for this device over any transport.",
      serviceCheck?.remedy || null
    )
  );

  // 4. Location simulation — stated only from a session the bridge reported.
  const overridden = session?.deviceId === deviceId ? session.locationOverrideActive : null;
  host.appendChild(
    capabilityRow(
      "Location override on the iPhone",
      overridden,
      session?.deviceId !== deviceId
        ? "No simulation session belongs to this device, so nothing has been changed on its GPS."
        : session.state === "active" || session.state === "completed"
          ? `Session ${session.sessionId} reports the device acknowledged ${session.publishedPointCount ?? 0} update(s) over ${session.transport}.`
          : `Session is ${session.state}${session.error?.message ? `: ${session.error.message}` : "."}`,
      null
    )
  );

  const tag = $("wireless-capability-tag");
  const status = candidate?.capability?.status;
  if (wirelessSession && serviceCheck?.ok === true) {
    tag.className = "tag green";
    tag.textContent = "SERVICE ANSWERED WIRELESSLY";
  } else if (status === "not-possible") {
    tag.className = "tag red";
    tag.textContent = "NOT POSSIBLE";
  } else if (status === "possible-unverified") {
    tag.className = "tag amber";
    tag.textContent = "PREREQUISITES MET / NOT CHECKED";
  } else if (active) {
    tag.className = "tag cyan";
    tag.textContent = "LINK OPEN / SERVICE UNCHECKED";
  } else {
    tag.className = "tag grey";
    tag.textContent = "UNKNOWN";
  }

  $("btn-wireless-readiness").disabled = !bridgeAvailable || !deviceId || (!reached.length && !active);
  $("btn-wireless-disconnect").disabled = !bridgeAvailable || !active;
  $("wireless-action-note").textContent = !deviceId
    ? "Select an iPhone above first. The readiness check is always aimed at one named device and one named transport."
    : reached.length || active
      ? `The readiness check pins itself to ${selectedTransport() || reached[0] || "the transport this device was reached on"}, so a pass cannot quietly come from a cable.`
      : "Nothing was reached wirelessly for this device, so there is no transport to check. The setup steps on the right are the next action.";
}

/* ------------------------------------------------------------------ diagnostics */

function renderDiagnostics() {
  const probe = probeReport();
  const host = probe?.host;
  const link = linkSummary();
  const tunnel = state.wirelessTunnel;

  if (!host) {
    $("kv-wireless-mdns").textContent = "—";
    $("kv-wireless-records").textContent = "—";
    $("kv-wireless-remote").textContent = "—";
    $("kv-wireless-ads").textContent = "—";
  } else {
    const mdns = host.mdns || {};
    $("kv-wireless-mdns").textContent =
      mdns.blocked === true
        ? "blocked — every interface refused UDP 5353"
        : mdns.usable
          ? `usable — ${mdns.queriesSent} query sent, ${mdns.sendErrors} refused`
          : mdns.usable === false
            ? `unusable — ${mdns.detail || "no mDNS socket"}`
            : "not measured";
    const records = host.pairRecords || {};
    $("kv-wireless-records").textContent =
      records.lockdownRecords === null && records.remotePairingRecords === null
        ? `not countable — ${records.note || "folders unreadable"}`
        : `${records.lockdownRecords ?? "?"} lockdown · ${records.remotePairingRecords ?? "?"} RemotePairing`;
    $("kv-wireless-remote").textContent = `${host.remotePairingIdentifiers ?? 0} device(s) have a RemotePairing record`;
    $("kv-wireless-ads").textContent = `${probe.mobdev2?.advertisements ?? "?"} _apple-mobdev2 · ${probe.remotepairing?.advertisements ?? "?"} _remotepairing`;
  }

  $("kv-wireless-selected").textContent = link?.selected
    ? `${link.selected.label} (${link.selected.transport})${link.selected.address ? ` at ${link.selected.address}` : ""}`
    : link?.proven?.transports?.length
      ? `nothing chosen — proven on ${link.proven.transports.join(", ")}`
      : "nothing chosen and nothing proven";
  $("kv-wireless-session").textContent = tunnel?.open
    ? `${tunnel.kind} tunnel for ${tunnel.deviceId} over ${tunnel.transport || "an unreported transport"} · ${tunnel.wireless ? "wireless" : "cable"}`
    : link?.activeSession?.open
      ? `session open over ${link.activeSession.transport || "unknown"}`
      : "no developer session";
}

function renderIssues() {
  const issues = probeReport()?.issues || [];
  const signature = JSON.stringify({ issues, session: state.session?.state, tunnel: state.wirelessTunnel?.open });
  if (signature === issueSignature) return;
  issueSignature = signature;

  const host = $("wireless-issues");
  clear(host);
  if (!issues.length) {
    host.appendChild(
      el("div", {
        className: "empty",
        text: probeReport()
          ? "The probe raised no blocking issue. That means the host could send discovery traffic; it does not mean a phone answered."
          : "No probe has run yet.",
      })
    );
    return;
  }
  for (const issue of issues) {
    host.appendChild(
      el("div", {
        className: `banner-note ${issue.severity === "error" ? "danger" : issue.severity === "warning" ? "warn" : ""}`,
      }, [
        el("span", { className: "icon", text: issue.severity === "error" ? "⚠" : "ⓘ" }),
        el("div", { className: "body" }, [
          el("strong", { text: issue.message }),
          issue.detail ? el("p", { text: issue.detail }) : null,
          issue.remedy ? el("p", { text: `Fix: ${issue.remedy}` }) : null,
          el("p", { text: `Code: ${issue.code}` }),
        ]),
      ])
    );
  }
}

/* -------------------------------------------------------------------- rail chip */

export function renderWirelessChip() {
  const chip = $("rail-wireless-chip");
  const note = $("rail-wireless-note");
  const probe = probeReport();
  const link = linkSummary();
  const tunnel = state.wirelessTunnel;

  if (!bridgeAvailable) {
    chip.className = "chip bad";
    chip.innerHTML = '<span class="dot"></span> BRIDGE MISSING';
    note.textContent = "Wireless reachability needs the desktop app and the Python bridge.";
    return;
  }
  if (!probe) {
    chip.className = "chip";
    chip.innerHTML = '<span class="dot"></span> NOT PROBED';
    note.textContent = "Wireless reachability has not been tested in this session.";
    return;
  }
  const active = Boolean(link?.activeSession?.open);
  if (active && tunnel?.wireless) {
    chip.className = "chip ok";
    chip.innerHTML = '<span class="dot"></span> WI-FI LINK OPEN';
  } else if (active) {
    chip.className = "chip warn";
    chip.innerHTML = '<span class="dot"></span> LINK OPEN · CABLE';
  } else if ((probe.verdict?.wirelessHandshakeReady || []).length) {
    chip.className = "chip warn";
    chip.innerHTML = '<span class="dot"></span> WI-FI REACHED';
  } else if (probe.verdict?.wirelessSeen) {
    chip.className = "chip warn";
    chip.innerHTML = '<span class="dot"></span> SEEN ONLY';
  } else {
    chip.className = "chip bad";
    chip.innerHTML = '<span class="dot"></span> NO WI-FI PATH';
  }
  note.textContent = `${probe.verdict?.summary || ""} Probed ${fmtTimestamp(probe.probedAt)}.`;
}

/* --------------------------------------------------------------------- actions */

export async function refreshLinkStatus({ silent = false } = {}) {
  if (!bridgeAvailable) return null;
  try {
    const status = await api.getWirelessStatus(state.selectedDeviceId ? { deviceId: state.selectedDeviceId } : {});
    setState({
      wirelessTunnel: status.tunnel,
      wirelessLink: status.link,
      // A status call carries the last probe too, so a panel opened after a restart of
      // the bridge can still show what was measured — but only what the bridge retained.
      ...(status.lastProbe && !state.wireless ? { wireless: { ...status.lastProbe, transports: status.lastProbe.transports || {} } } : {}),
    });
    return status;
  } catch (error) {
    if (!silent) reportError(error, "Reading the wireless link status");
    return null;
  }
}

export async function runWirelessProbe({ deviceId = null, proveIdentity = true } = {}) {
  if (!bridgeAvailable) {
    toast("Wireless probe unavailable", "Device discovery needs the desktop app and the Python bridge.", { kind: "error" });
    return;
  }
  if (probing) {
    toast("Probe already running", "A probe browses the network for several seconds; wait for it to finish.", { kind: "warn" });
    return;
  }
  probing = true;
  probeFailure = "";
  $("btn-wireless-probe").disabled = true;
  $("btn-wireless-refresh").disabled = true;
  $("wireless-probed-tag").className = "tag cyan";
  $("wireless-probed-tag").textContent = "PROBING…";
  $("wireless-summary").textContent =
    "Asking usbmuxd for its entries, sending one multicast DNS query per interface, and browsing " +
    "_apple-mobdev2, _remoted and _remotepairing. This takes about ten seconds.";
  const started = Date.now();
  try {
    const params = { probeIdentity: proveIdentity };
    const target = deviceId || state.selectedDeviceId;
    if (target) params.deviceId = target;
    const report = await api.probeWireless(params);
    // The probe carries the tunnel status as it stood while it ran, so the panel can
    // show it immediately; the status refresh below confirms it.
    setState({ wireless: report, wirelessTunnel: report.tunnel || null });
    bridgeLog.write(
      report.verdict?.wirelessHandshakeReady?.length ? "ok" : "info",
      `Wireless probe: ${report.candidates?.length || 0} candidate(s), ${report.transports?.["wifi-mux"]?.deviceCount || 0} network mux entry(ies), ` +
        `${report.transports?.["rsd-lan"]?.deviceCount || 0} RSD advertisement(s) in ${report.durationMs ?? 0} ms.`
    );
    consoleLog.write("device", `Wireless probe finished in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
    await refreshLinkStatus({ silent: true });
  } catch (error) {
    // Kept because renderAll() repaints the panel right afterwards and would otherwise
    // reset the tag to "NOT PROBED", hiding the failure from the user.
    probeFailure = `${error.message}${error.details ? ` (${error.details})` : ""}`;
    reportError(error, "Wireless probe");
  } finally {
    probing = false;
    $("btn-wireless-probe").disabled = false;
    $("btn-wireless-refresh").disabled = false;
    renderAll();
  }
}

async function connectTransport(deviceId, transport) {
  if (connecting) {
    toast("Already connecting", "One link attempt at a time: it opens lockdown and, on iOS 17+, a developer tunnel.", { kind: "warn" });
    return;
  }
  if (!CONNECTABLE.has(transport)) {
    toast("Unsupported transport", `${transport} is not a transport this build can open.`, { kind: "error" });
    return;
  }
  const wireless = transport !== "usb";
  if (wireless && state.session && ["preparing", "active", "paused", "completed"].includes(state.session.state)) {
    toast("Simulation running", "Stop the location simulation before changing the link it is published over.", { kind: "warn", sticky: true });
    return;
  }
  const confirmed = await confirmAction({
    title: wireless ? `Connect over ${transport}` : "Connect over USB",
    message: wireless
      ? "Location Studio opens lockdown on the network entry and, on iOS 17 and newer, the userspace developer tunnel over it. " +
        "Unplug the cable first: while a USB entry exists, usbmuxd prefers it, so a tunnel opened now would prove nothing about Wi-Fi."
      : "Location Studio pins this attempt to the USB entry, so the cable stays the transport for the session.",
    confirmLabel: wireless ? "Open the wireless link" : "Open the USB link",
    hint: "No administrator rights are needed and nothing is written to the iPhone.",
  });
  if (!confirmed) return;

  connecting = true;
  $("wireless-probed-tag").className = "tag cyan";
  $("wireless-probed-tag").textContent = wireless ? "OPENING TUNNEL…" : "OPENING LINK…";
  toast("Connecting", `Opening ${transport} — up to two minutes while the tunnel handshake runs.`, { kind: "warn" });
  try {
    const report = await api.connectWireless({ deviceId, transport });
    consoleLog.write(
      report.ready ? "ok" : "warn",
      `Connect ${transport} on ${deviceId}: ${report.summary}`
    );
    bridgeLog.write(report.ready ? "ok" : "warn", `wireless.connect ${transport}: ${JSON.stringify(report.steps)}`);
    if (report.error) {
      setState({ wirelessLink: report.link || null, wirelessTunnel: report.tunnel || null });
      toast("Link not established", report.error.message || report.summary, { kind: "error", sticky: true });
      return;
    }
    setState({ wirelessLink: report.link || null, wirelessTunnel: report.tunnel || null, selectedDeviceId: deviceId });
    if (report.ready) {
      toast("Connected", report.summary, { kind: "ok" });
    } else {
      toast("Link open, service not confirmed", report.summary, { kind: "warn", sticky: true });
    }
  } catch (error) {
    reportError(error, `Connecting over ${transport}`);
  } finally {
    connecting = false;
    await runWirelessProbe({ deviceId, proveIdentity: true });
  }
}

/**
 * The header strip's single Connect action.
 *
 * It does not invent a transport. It uses the endpoint the bridge already selected,
 * otherwise a transport the last probe proved reachable for this device, otherwise the
 * cable entry usbmuxd reported. When none of those exist the attempt is refused with
 * the reason, because opening a link that nothing was observed on would be a guess.
 */
export async function connectSelectedDevice() {
  const deviceId = state.selectedDeviceId;
  if (!deviceId) {
    toast("No device selected", "Scan in Device and pick the iPhone this link should be opened on.", { kind: "warn" });
    return;
  }
  const device = state.devices.find((entry) => entry.deviceId === deviceId);
  const reachable = candidateFor(deviceId)?.reachableOver || [];
  const preferred =
    selectedTransport() ||
    reachable.find((transport) => CONNECTABLE.has(transport)) ||
    (device?.connectionType === "USB" ? "usb" : null);
  if (!preferred) {
    toast(
      "No transport to connect",
      "Nothing has been proved reachable for this device. Run “Discover devices” in Device first: an entry in the " +
        "Apple Mobile Device Service or a completed handshake has to answer before a link can open.",
      { kind: "error" }
    );
    return;
  }
  await connectTransport(deviceId, preferred);
}

async function disconnectLink() {
  const deviceId = state.selectedDeviceId;
  const link = linkSummary();
  const wireless = Boolean(link?.activeSession?.wireless);
  const confirmed = await confirmAction({
    title: "Close the developer link",
    message: wireless
      ? "Close the userspace tunnel that was opened over Wi-Fi? The iPhone keeps its own GPS; no location was changed by this panel."
      : "Close the developer session on this device?",
    confirmLabel: "Disconnect",
    danger: true,
    hint: "If a simulation is running, the bridge refuses this until you press Stop and the real GPS is restored.",
  });
  if (!confirmed) return;
  try {
    const result = await api.disconnectWireless(deviceId ? { deviceId } : {});
    setState({ wirelessTunnel: result.tunnel, wirelessLink: result.link });
    consoleLog.write("ok", `Link closed for ${result.deviceId || "the session device"}${result.wasWireless ? " (was wireless)" : ""}.`);
    toast("Disconnected", "The developer session is closed.", { kind: "ok" });
  } catch (error) {
    reportError(error, "Disconnecting the link");
  } finally {
    await refreshLinkStatus({ silent: true });
    renderAll();
  }
}

async function checkServiceOverLink() {
  const deviceId = state.selectedDeviceId;
  if (!deviceId) return;
  const transport = selectedTransport() || (candidateFor(deviceId)?.reachableOver || []).find((t) => CONNECTABLE.has(t));
  $("btn-wireless-readiness").disabled = true;
  try {
    await runReadiness({ deviceId, transport: transport || undefined });
  } finally {
    await refreshLinkStatus({ silent: true });
    renderAll();
  }
}

function showWirelessHelp() {
  const probe = probeReport();
  const prerequisite = (key) => probe?.transports?.[key]?.prerequisite || "";
  showInfo({
    title: "Getting an iPhone onto the Wi-Fi path",
    children: [
      el("p", {
        attrs: { style: "margin-top:0" },
        text:
          "A USB pairing does not enable wireless communication. The phone has to accept this host on the network path " +
          "as well, and that is a one-time setup per device:",
      }),
      el(
        "ol",
        { attrs: { style: "line-height:1.9; font-size:12px; padding-left:20px;" } },
        [
          "Pair once over USB and tap Trust, so this PC holds a pairing record for the iPhone.",
          "With the cable still attached, turn on “Sync with this iPhone over Wi-Fi” (Apple Devices / iTunes device options, or Settings → General → iPhone Transfer on newer iOS).",
          "Keep the iPhone and this PC on the same subnet, on a network that forwards multicast DNS. Guest Wi-Fi, client isolation and most VPN adapters block it.",
          "Keep the Apple Mobile Device Service running: a network iPhone is still enumerated through usbmuxd on Windows.",
          "Turn on Developer Mode yourself (Settings → Privacy & Security → Developer Mode) and restart the iPhone. Location Studio never changes that setting.",
          "iOS 17.0–17.3 needs one extra step: the developer tunnel can only be opened from a RemotePairing record created while the phone was on the cable. iOS 17.4 and newer use the CoreDevice proxy instead.",
        ].map((text) => el("li", { text }))
      ),
      prerequisite("wifi-mux") ? el("p", { text: `Network entry: ${prerequisite("wifi-mux")}` }) : null,
      prerequisite("rsd-lan") ? el("p", { text: `LAN tunnel: ${prerequisite("rsd-lan")}` }) : null,
      el("p", {
        text:
          "Unplug the cable before trusting a “wireless” result. usbmuxd prefers a USB entry when both exist, which is why " +
          "this panel pins every check to one transport and refuses to call a cabled session wireless.",
      }),
    ],
  }).catch(() => {});
}

/* ------------------------------------------------------------------------- init */

function renderAll() {
  renderMetrics();
  renderTransports();
  renderCandidates();
  renderCapability();
  renderDiagnostics();
  renderIssues();
  renderWirelessChip();
}

export function initWireless() {
  if (initialised) return;
  initialised = true;

  $("btn-wireless-probe").addEventListener("click", () => {
    runWirelessProbe().catch(() => {});
  });
  $("btn-wireless-refresh").addEventListener("click", () => {
    refreshLinkStatus().then(renderAll).catch(() => {});
  });
  $("btn-wireless-readiness").addEventListener("click", () => {
    checkServiceOverLink().catch(() => {});
  });
  $("btn-wireless-disconnect").addEventListener("click", () => {
    disconnectLink().catch(() => {});
  });
  $("btn-wireless-help").addEventListener("click", () => showWirelessHelp());

  if (bridgeAvailable) {
    api.onBridgeEvent(({ event, data }) => {
      if (event !== "wireless.state") return;
      if (!data || data.deviceId !== state.selectedDeviceId) return;
      setState({ wirelessLink: data.link || state.wirelessLink, wirelessTunnel: data.tunnel || state.wirelessTunnel });
      consoleLog.write(data.ready ? "ok" : "warn", `Link report for ${data.deviceId}: ${data.summary}`);
      renderAll();
    });
  }

  renderAll();
  subscribe(() => {
    if (initialised) renderAll();
  });
}
