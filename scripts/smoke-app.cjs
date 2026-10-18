/**
 * End-to-end smoke test for the desktop app, run under Electron:
 *
 *     npx electron scripts/smoke-app.cjs
 *
 * It boots the *real* stack — app:// protocol handler, preload bridge, the IPC
 * trust boundary, the Python device bridge and usbmuxd — in a hidden window, then
 * drives it from the renderer and asserts what the UI may and may not claim.
 *
 * It works identically with or without an iPhone attached: the assertions are
 * about honesty and wiring, not about a specific device being present.
 *
 * Exit code 0 = every check passed. Use `--report <path>` to write the JSON.
 */

const { app, BrowserWindow, ipcMain, protocol } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..");
const RENDERER_ROOT = path.join(PROJECT_ROOT, "renderer");

const { APP_ORIGIN, APP_SCHEME_PRIVILEGES, createProtocolHandler } = require(path.join(PROJECT_ROOT, "electron", "app-protocol.cjs"));
const { registerIpc } = require(path.join(PROJECT_ROOT, "electron", "ipc.cjs"));
const { BridgeClient } = require(path.join(PROJECT_ROOT, "electron", "bridge-client.cjs"));
const { WorkspaceStore } = require(path.join(PROJECT_ROOT, "electron", "store.cjs"));

const GLOBAL_TIMEOUT_MS = 180_000;
const reportPath = (() => {
  const index = process.argv.indexOf("--report");
  return index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : null;
})();

const results = [];
const consoleMessages = [];
const logLines = [];

function record(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function log(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  logLines.push(line);
  process.stderr.write(line + "\n");
}

// Renderer files are served from a scratch user-data directory, so the smoke
// test can never overwrite the real workspace document.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "location-studio-smoke-"));
app.setPath("userData", scratch);
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES]);

const bridge = new BridgeClient({ projectRoot: PROJECT_ROOT, log });
const store = new WorkspaceStore(app.getPath("userData"));
let window = null;

// Mirror main.cjs: bridge status changes, bridge stderr and device events are
// pushed to the renderer on the same channels the real app uses. The UI logic
// under test (health refresh, automatic discovery after the handshake, the
// bridge log panel) only runs when these events actually arrive.
function sendToWindow(channel, payload) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}
bridge.on("bridge-status", (status) => {
  log("info", `bridge status: ${status.state} (${status.detail})`);
  sendToWindow("bridge:status", status);
});
bridge.on("bridge-log", (line) => {
  log("info", `bridge: ${line}`);
  sendToWindow("bridge:log", line);
});
bridge.on("event", (payload) => {
  log("info", `bridge event: ${payload.event}`);
  sendToWindow("bridge:event", payload);
});

function waitFor(predicate, { timeoutMs = 20_000, intervalMs = 120, label = "condition" } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      try {
        if (await predicate()) return resolve(true);
      } catch (error) {
        return reject(error);
      }
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** Evaluate an expression inside the renderer and return its value. */
function inRenderer(expression) {
  return window.webContents.executeJavaScript(expression, true);
}

function buildChecks() {
  return async () => {
    // ---------------------------------------------------------------- boot
    const shell = await inRenderer(`(() => {
      const views = [...document.querySelectorAll("section.view")].map((node) => node.id);
      return {
        views,
        activeView: document.querySelector("section.view.active")?.id || null,
        navItems: document.querySelectorAll(".nav-item").length,
        hasApi: typeof window.locationStudio === "object",
        apiKeys: Object.keys(window.locationStudio || {}).length,
        hasGenericInvoke: "invoke" in (window.locationStudio || {}),
        title: document.title,
        inspector: document.getElementById("view-title")?.textContent || "",
      };
    })()`);

    record(
      "renderer: four workspace views are present",
      ["view-map", "view-device", "view-motion", "view-console"].every((id) => shell.views.includes(id)),
      `views: ${shell.views.join(", ")}`
    );
    record("renderer: map studio is the active view on boot", shell.activeView === "view-map", `active: ${shell.activeView}`);
    record("renderer: navigation rail is built", shell.navItems === 4, `${shell.navItems} nav item(s)`);
    record(
      "preload: allowlisted API is exposed (no generic invoke)",
      shell.hasApi && shell.apiKeys >= 20 && shell.hasGenericInvoke === false,
      `${shell.apiKeys} API entries; generic invoke escape hatch present: ${shell.hasGenericInvoke}`
    );

    // ------------------------------------------------------- bridge + IPC
    const appInfo = await inRenderer("window.locationStudio.getAppInfo()");
    record(
      "ipc: app info round-trip (against an isolated workspace)",
      appInfo.ok === true && typeof appInfo.data?.appVersion === "string" && String(appInfo.data?.workspaceFile).startsWith(scratch),
      `appVersion ${appInfo.data?.appVersion}, workspace ${appInfo.data?.workspaceFile}`
    );

    // main.cjs starts the bridge eagerly; the harness mirrors that.
    bridge.ensureStarted().catch((error) => log("warn", `bridge start failed: ${error.message}`));
    await waitFor(async () => (await inRenderer("window.locationStudio.getBridgeStatus()")).data?.state === "ready", {
      label: "bridge handshake",
      timeoutMs: 90_000,
    });
    const bridgeStatus = await inRenderer("window.locationStudio.getBridgeStatus()");
    record("bridge: handshake completed", bridgeStatus.ok === true && bridgeStatus.data?.state === "ready", bridgeStatus.data?.detail || "");

    const health = await inRenderer("window.locationStudio.getBridgeHealth()");
    record(
      "bridge: health reports a real interpreter and library",
      health.ok === true && health.data?.pymobiledevice3?.available === true && Boolean(health.data?.python?.version),
      `python ${health.data?.python?.version}, pymobiledevice3 ${health.data?.pymobiledevice3?.version}`
    );
    record(
      "bridge: usbmuxd state is reported, not assumed",
      typeof health.data?.usbmux?.available === "boolean",
      health.data?.usbmux?.available
        ? `usbmuxd at ${health.data.usbmux.address} reports ${health.data.usbmux.deviceCount} device(s)`
        : `usbmuxd unavailable: ${health.data?.usbmux?.error}`
    );

    // ------------------------------------------------------------ left rail
    // The rail is the first thing the user sees. main.cjs starts the bridge
    // asynchronously, so the boot-time status read usually races the handshake:
    // the rail must still pick up an attached device without any click.
    const attachedCount = health.data?.usbmux?.deviceCount ?? 0;
    if (attachedCount > 0) {
      await waitFor(
        async () => !/NO DEVICE/.test(await inRenderer(`document.getElementById("rail-device-chip").textContent`)),
        { label: "left rail to reflect the attached device", timeoutMs: 30_000 }
      );
      const rail = await inRenderer(`(() => ({
        chip: document.getElementById("rail-device-chip").textContent.trim(),
        note: document.getElementById("rail-device-note").textContent.trim(),
      }))()`);
      record(
        "ui: the left rail picks up the attached device on its own (no click)",
        /DEVICE READY|SELECTED/.test(rail.chip),
        `${rail.chip} — ${rail.note}`
      );
    }

    // ------------------------------------------------------------- devices
    const discovery = await inRenderer("window.locationStudio.discoverDevices({ probeIdentity: true })");
    const devices = discovery.data?.devices ?? [];
    const stagesHonest = devices.every(
      (device) =>
        device.stages?.usbDetected === true &&
        [true, false, null].includes(device.stages?.paired) &&
        [true, false, null].includes(device.stages?.developerModeEnabled)
    );
    record(
      "devices: discovery answers with observed devices only",
      discovery.ok === true && Array.isArray(devices) && stagesHonest,
      `${devices.length} device(s) reported`
    );
    record(
      "devices: an empty scan explains itself instead of pretending to be ready",
      devices.length > 0 || (discovery.data?.errors?.length ?? 0) > 0,
      devices.length > 0 ? "device present" : (discovery.data?.errors?.[0] || "no explanation attached")
    );

    const capabilities = await inRenderer("window.locationStudio.getCapabilities({})");
    const rows = capabilities.data?.capabilities ?? [];
    const vocabulary = new Set(["verified_hardware", "documented", "unknown", "unsupported"]);
    const labelled = rows.every((row) => vocabulary.has(row.status) && Boolean(row.evidence));
    record(
      "capabilities: every row carries a status from the agreed vocabulary",
      capabilities.ok === true && rows.length >= 10 && labelled,
      `${rows.length} rows: ${["verified_hardware", "documented", "unknown", "unsupported"].map((s) => `${s}=${rows.filter((r) => r.status === s).length}`).join(", ")}`
    );

    // -------------------------------------------------------------- basemap
    // The map must show real imagery. A key-gated provider still answers 200
    // with a decodable "API KEY REQUIRED" watermark, so decoded <img> pixels
    // alone prove nothing; the endpoint itself is also probed for real bytes.
    await waitFor(
      async () => inRenderer(`[...document.querySelectorAll("img.leaflet-tile")].some((img) => img.naturalWidth > 0)`),
      { label: "basemap tiles to decode", timeoutMs: 45_000 }
    );
    const basemap = await inRenderer(`(() => {
      const images = [...document.querySelectorAll("img.leaflet-tile")];
      const decoded = images.filter((img) => img.naturalWidth > 0);
      return {
        total: images.length,
        decoded: decoded.length,
        samples: decoded.slice(0, 4).map((img) => img.currentSrc || img.src),
      };
    })()`);
    const TILE_HOSTS = ["services.arcgisonline.com", "tile.openstreetmap.org"];
    const hostOf = (url) => {
      try {
        return new URL(url).host;
      } catch {
        return "";
      }
    };
    const hostAllowed = (host) => TILE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    const tileHosts = [...new Set(basemap.samples.map(hostOf))];
    record(
      "map: basemap renders decoded tiles from a key-free tile provider",
      basemap.decoded > 0 && tileHosts.every(hostAllowed),
      `${basemap.decoded}/${basemap.total} tiles decoded; hosts: ${tileHosts.join(", ") || "none"}`
    );

    // Cold probe of the dark basemap endpoint (the same Esri URL template
    // renderer/js/maps.js configures). A watermark placeholder is ~2.5 KB of
    // flat artwork; real imagery is several times larger.
    const darkProbeUrl =
      "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/10/340/512";
    let probeVerdict = { ok: false, detail: "the endpoint probe did not run" };
    try {
      const response = await fetch(darkProbeUrl);
      const bytes = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get("content-type") || "";
      probeVerdict = {
        ok: response.status === 200 && contentType.startsWith("image/") && bytes.length >= 5120,
        detail: `${response.status} ${contentType}, ${bytes.length} bytes (a key-gated watermark tile is ~2.5 KB)`,
      };
    } catch (error) {
      probeVerdict = { ok: false, detail: `probe fetch failed: ${error.message}` };
    }
    record("map: the dark basemap endpoint serves real imagery, not a key-gated placeholder", probeVerdict.ok, probeVerdict.detail);

    // -------------------------------------------------------------- routing
    const analysis = await inRenderer(`window.locationStudio.analyzeRoute({
      points: [
        { lat: 48.8557, lon: 2.2981 },
        { lat: 48.8561, lon: 2.2985 },
        { lat: 48.8570, lon: 2.2999 }
      ],
      options: { speedMps: 12, updateRateHz: 5, interpolate: true, loop: false }
    })`);
    record(
      "route: analysis returns geometry and duration from the bridge",
      analysis.ok === true && analysis.data?.routeLengthM > 0 && analysis.data?.estimatedDurationSeconds > 0 && analysis.data?.playbackPointCount > 3,
      `${analysis.data?.routeLengthM} m, ${analysis.data?.playbackPointCount} points, ${analysis.data?.estimatedDurationSeconds} s`
    );

    // -------------------------------------------------- refusals (honesty)
    const badCoordinate = await inRenderer(
      `window.locationStudio.startSimulation({ deviceId: "00008140-0000000000000000", coordinate: { lat: 991, lon: 0 } })`
    );
    record(
      "simulation: an out-of-range coordinate is refused before any device call",
      badCoordinate.ok === false && badCoordinate.error?.code === "INVALID_PARAMS",
      `${badCoordinate.error?.code}: ${badCoordinate.error?.message}`
    );

    const noDevice = await inRenderer(
      `window.locationStudio.startSimulation({ deviceId: "00008140-0000000000000000", coordinate: { lat: 48.85, lon: 2.29 } })`
    );
    record(
      "simulation: a start against a missing device fails honestly",
      noDevice.ok === false && Boolean(noDevice.error?.code) && noDevice.error?.code !== "INVALID_PARAMS",
      `${noDevice.error?.code}: ${noDevice.error?.message}`
    );

    const status = await inRenderer("window.locationStudio.getSimulationStatus()");
    record(
      "simulation: status reports no session when nothing is running",
      status.ok === true && status.data?.session === null && Array.isArray(status.data?.history),
      `session=${JSON.stringify(status.data?.session)}, history=${status.data?.history?.length ?? "?"}`
    );

    // -------------------------------------------------------------- the UI
    await inRenderer(`document.querySelector('.nav-item[data-view="device"]').click()`);

    // Opening Device Center starts a deep scan by itself; wait for it to settle
    // before touching the refresh control (which is disabled while scanning).
    await waitFor(
      async () => /device\(s\) in \d+ ms/.test(await inRenderer(`document.getElementById("discovery-status").textContent`)),
      { label: "device center auto-scan", timeoutMs: 60_000 }
    );
    await inRenderer(`document.getElementById("btn-refresh-devices").click()`);
    await waitFor(
      async () => {
        const snapshot = await inRenderer(
          `(() => ({ status: document.getElementById("discovery-status").textContent, busy: document.getElementById("btn-refresh-devices").disabled }))()`
        );
        return !snapshot.busy && /device\(s\) in \d+ ms/.test(snapshot.status);
      },
      { label: "explicit refresh scan", timeoutMs: 60_000 }
    );

    // The Device Center has now run its own deep scan plus the readiness check the
    // bridge folds the developer-service result into, so re-read the bridge's current
    // device state: the chips must mirror that report, not the first snapshot.
    const latestDiscovery = await inRenderer("window.locationStudio.discoverDevices({ probeIdentity: false })");
    const currentDevices = latestDiscovery.data?.devices ?? devices;

    const deviceCenter = await inRenderer(`(() => {
      const list = document.getElementById("device-list");
      const cards = [...list.querySelectorAll(".device-card")].map((card) => ({
        text: card.textContent.replace(/\\s+/g, " ").trim(),
        chips: [...card.querySelectorAll(".chip")].map((chip) => ({
          label: chip.textContent.trim(),
          ok: chip.classList.contains("ok"),
          bad: chip.classList.contains("bad"),
        })),
      }));
      const checklist = [...document.querySelectorAll("#setup-check-driver, #setup-check-cable, #setup-check-trust, #setup-check-developer-mode, #setup-check-unlocked")]
        .map((node) => [node.id, node.getAttribute("data-ok")]);
      return {
        view: document.querySelector("section.view.active")?.id || null,
        title: document.getElementById("view-title").textContent,
        cards,
        emptyText: list.querySelector(".empty")?.textContent.trim() || null,
        status: document.getElementById("discovery-status").textContent,
        checklist,
        capabilityRows: document.querySelectorAll("#capability-matrix .matrix-row").length,
      };
    })()`);

    const stageKeys = ["usbDetected", "paired", "developerModeEnabled", "developerServiceAvailable", "simulationReady"];
    // The card accumulates facts across scans: a cheap scan reports `null` for stages
    // it cannot see, and `null` must never erase what an earlier deep scan measured.
    // Mirror that rule when computing what the UI is supposed to show.
    const expectedStages = currentDevices.map((device, index) => {
      const merged = { ...(devices[index]?.stages ?? {}) };
      for (const [key, value] of Object.entries(device.stages ?? {})) {
        if (value !== null && value !== undefined) merged[key] = value;
      }
      return merged;
    });
    const chipsMatch = deviceCenter.cards.every((card, index) => {
      const stages = expectedStages[index] ?? {};
      return (
        card.chips.length === stageKeys.length &&
        card.chips.every((chip, chipIndex) => {
          const value = stages[stageKeys[chipIndex]];
          if (value === true) return chip.ok;
          if (value === false) return chip.bad;
          return !chip.ok && !chip.bad && chip.label.includes("?");
        })
      );
    });

    record("ui: navigation switches to Device Center", deviceCenter.view === "view-device", `title: ${deviceCenter.title}`);
    if (deviceCenter.cards.length) {
      record(
        "ui: each device card shows the UDID usbmuxd reported",
        deviceCenter.cards.every((card, index) => card.text.includes(currentDevices[index].deviceId)),
        `${deviceCenter.cards.length} card(s)`
      );
      record(
        "ui: stage chips mirror the bridge's stage values (no optimistic badge)",
        chipsMatch,
        deviceCenter.cards[0].chips
          .map(
            (chip, index) =>
              `${chip.label}=${chip.ok ? "ok" : chip.bad ? "bad" : "unknown"} (expected: ${String(
                expectedStages[0]?.[stageKeys[index]]
              )})`
          )
          .join(", ")
      );
      record(
        "ui: no card claims a running simulation",
        !/simulating/i.test(deviceCenter.cards.map((card) => card.text).join(" ")),
        "nothing is running, so nothing may say so"
      );
    } else {
      record(
        "ui: an empty device list is worded honestly",
        /no iphone is attached/i.test(deviceCenter.emptyText || "") &&
          !/\bready\b|\bconnected\b|\bsimulating\b/i.test(deviceCenter.emptyText || ""),
        `device list says: "${deviceCenter.emptyText}" — scan status: "${deviceCenter.status}"`
      );
    }
    record(
      "ui: the setup checklist never claims an unverified step",
      deviceCenter.checklist.every(([, value]) => value === "true" || value === "false" || value === "null") &&
        deviceCenter.checklist.some(([id, value]) => id === "setup-check-unlocked" && value === "null"),
      deviceCenter.checklist.map(([id, value]) => `${id.replace("setup-check-", "")}=${value}`).join(", ")
    );
    record(
      "ui: capability matrix rendered from the bridge report",
      deviceCenter.capabilityRows >= 2,
      `${deviceCenter.capabilityRows} row(s) in #capability-matrix`
    );

    // ------------------------------------------------------- console hygiene
    const errors = consoleMessages.filter((entry) => entry.level === "error");
    record(
      "renderer: no console errors during the whole run",
      errors.length === 0,
      errors.length ? errors.map((entry) => entry.message).join(" | ").slice(0, 400) : `${consoleMessages.length} console message(s), none at error level`
    );
  };
}

async function finish(code) {
  const summary = {
    generatedAt: new Date().toISOString(),
    platform: `${process.platform} ${os.release()}`,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    passed: results.filter((entry) => entry.ok).length,
    failed: results.filter((entry) => !entry.ok).length,
    checks: results,
    consoleMessages,
  };
  process.stdout.write(
    `\n${summary.passed}/${results.length} checks passed${summary.failed ? `, ${summary.failed} FAILED` : ""}\n`
  );
  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2), "utf8");
    process.stdout.write(`report written to ${reportPath}\n`);
  }
  try {
    await bridge.stop();
  } catch (error) {
    log("warn", `bridge stop failed: ${error.message}`);
  }
  app.exit(code);
}

app.whenReady().then(async () => {
  const guardTimer = setTimeout(() => {
    record("smoke: completed within the global timeout", false, `exceeded ${GLOBAL_TIMEOUT_MS / 1000}s`);
    finish(1);
  }, GLOBAL_TIMEOUT_MS);

  try {
    protocol.handle("app", createProtocolHandler({ rendererRoot: RENDERER_ROOT, isDevelopment: false, log }));
    registerIpc({ ipcMain, bridge, store, getWindow: () => window });

    window = new BrowserWindow({
      width: 1280,
      height: 860,
      show: false,
      webPreferences: {
        preload: path.join(PROJECT_ROOT, "electron", "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    window.webContents.on("console-message", (details, legacyLevel, legacyMessage) => {
      const level = typeof details?.level === "string" ? details.level : "info";
      const message = typeof details?.message === "string" ? details.message : legacyMessage;
      consoleMessages.push({ level, message, source: `${details?.sourceId || ""}:${details?.lineNumber ?? 0}` });
    });
    window.webContents.on("did-fail-load", (_event, code, description, url) => {
      log("error", `renderer failed to load ${url} (${code}): ${description}`);
    });

    const loaded = new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
    await window.loadURL(`${APP_ORIGIN}/index.html`);
    await loaded;
    await waitFor(async () => inRenderer("typeof window.locationStudio === 'object' && typeof window.locationStudio.getAppInfo === 'function'"), {
      label: "preload API",
    });

    await buildChecks()();
  } catch (error) {
    record("smoke: run completed without an unexpected failure", false, error.stack || error.message);
  } finally {
    clearTimeout(guardTimer);
  }

  await finish(results.every((entry) => entry.ok) ? 0 : 1);
});
