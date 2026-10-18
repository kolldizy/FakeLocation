/**
 * Electron main process for Location Studio.
 *
 * Layering:  renderer (no Node)  ->  preload (fixed allowlist)  ->  main (validation)
 *            ->  Python bridge (device protocol)  ->  iPhone over USB.
 *
 * The renderer has no filesystem, no shell and no child-process access.
 */

const { app, BrowserWindow, ipcMain, Menu, protocol, shell } = require("electron");
const path = require("node:path");

const { BridgeClient } = require("./bridge-client.cjs");
const { WorkspaceStore } = require("./store.cjs");
const { registerIpc } = require("./ipc.cjs");
const { APP_ORIGIN, APP_SCHEME_PRIVILEGES, createProtocolHandler } = require("./app-protocol.cjs");

const PROJECT_ROOT = path.join(__dirname, "..");
const RENDERER_ROOT = path.join(PROJECT_ROOT, "renderer");
const isDevelopment = !app.isPackaged;

// Python cannot import from inside an asar archive, so the bridge package is
// shipped unpacked (see `asarUnpack` in package.json) and pointed at directly.
const BRIDGE_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "app.asar.unpacked", "bridge")
  : path.join(PROJECT_ROOT, "bridge");

/**
 * The renderer is served over a custom standard scheme rather than `file://`.
 *
 * Why: ES modules, `'self'` in a Content-Security-Policy and fetch() all need a
 * real, stable origin. `file://` gives neither, which is why `loadFile()` plus
 * `<script type="module">` silently fails.
 *
 * The scheme must be registered as standard + secure *before* the app is ready,
 * which is the only point where Electron accepts these privilege flags.
 */
protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES]);

let mainWindow = null;
const logLines = [];
// Packaged builds are quiet by default; set LOCATION_STUDIO_VERBOSE=1 to get the
// same log stream as a development run (useful when reporting a problem).
const verboseLogging = isDevelopment || process.env.LOCATION_STUDIO_VERBOSE === "1";

function log(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  logLines.push(line);
  if (logLines.length > 400) logLines.shift();
  if (level === "error" || verboseLogging) {
    process.stderr.write(line + "\n");
  }
}

const bridge = new BridgeClient({ projectRoot: PROJECT_ROOT, bridgeRoot: BRIDGE_ROOT, log });
const store = new WorkspaceStore(app.getPath("userData"));

bridge.on("bridge-status", (status) => {
  log("info", `bridge status: ${status.state} (${status.detail})`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("bridge:status", status);
  }
});

bridge.on("event", (payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("bridge:event", payload);
  }
});

bridge.on("bridge-log", (line) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("bridge:log", line);
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: "#070a10",
    show: false,
    title: "Location Studio — Cyber Motion",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
    },
  });

  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // A renderer that fails to load or logs an error must be visible in the
  // terminal log, not only in DevTools.
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    log("error", `renderer failed to load ${validatedURL} (${errorCode}): ${errorDescription}`);
  });
  mainWindow.webContents.on("did-finish-load", () => {
    log("info", `renderer loaded: ${mainWindow.webContents.getURL()}`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    log("error", `renderer process gone: ${details.reason} (exit code ${details.exitCode})`);
  });
  mainWindow.webContents.on("console-message", (details, legacyLevel, legacyMessage) => {
    // Electron 33+ passes a details object; older versions passed (event, level, message).
    const level = typeof details?.level === "string"
      ? details.level
      : ["verbose", "info", "warning", "error"][legacyLevel ?? 1] ?? "info";
    const message = typeof details?.message === "string" ? details.message : legacyMessage;
    if (!message || (level !== "error" && level !== "warning")) return;
    log(level === "error" ? "error" : "warn", `renderer: ${message}`);
  });

  // External links always go through the OS browser, never an in-app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) {
      event.preventDefault();
      if (/^https:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // The renderer must never be able to attach a Node-capable preload elsewhere.
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }],
    },
    {
      label: "Device",
      submenu: [
        {
          label: "Stop simulation and restore real GPS",
          accelerator: "CmdOrCtrl+Shift+S",
          click: async () => {
            try {
              await bridge.request("simulation.stop", {});
            } catch (error) {
              log("warn", `stop from menu failed: ${error.message}`);
            }
          },
        },
        { type: "separator" },
        {
          label: "Restart bridge",
          click: async () => {
            try {
              await bridge.restart();
            } catch (error) {
              log("error", `bridge restart failed: ${error.message}`);
            }
          },
        },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Why Safari, Maps and Find My may not change",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("bridge:event", { event: "ui.openLimitations", data: {} });
            }
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Single instance: two bridges fighting over one iPhone would be confusing.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    protocol.handle("app", createProtocolHandler({ rendererRoot: RENDERER_ROOT, isDevelopment, log }));
    buildMenu();
    registerIpc({ ipcMain, bridge, store, getWindow: () => mainWindow });
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // Start the bridge eagerly so Device Center has real status on first paint.
    bridge.ensureStarted().catch((error) => log("warn", `bridge start deferred: ${error.message}`));
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Never leave the phone pinned to a fake location after the app closes.
let shuttingDown = false;
app.on("before-quit", (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  event.preventDefault();
  bridge
    .stop()
    .catch((error) => log("warn", `bridge stop failed: ${error.message}`))
    .finally(() => app.exit(0));
});

process.on("uncaughtException", (error) => {
  log("error", `uncaught exception: ${error.stack || error.message}`);
});
process.on("unhandledRejection", (reason) => {
  log("error", `unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});

module.exports = { log };
