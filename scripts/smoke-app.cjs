/**
 * End-to-end smoke test for the desktop app, run under Electron:
 *
 *     npx electron scripts/smoke-app.cjs
 *
 * It boots the *real* stack — app:// protocol handler, preload bridge, the IPC
 * trust boundary, the Python device bridge and usbmuxd — in a 1280x720 window, then
 * drives it with real mouse input and asserts what the UI may and may not claim.
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

// The wireless probe browses multicast DNS three times over and opens no tunnel, so a
// full run needs room for it. Bounded, never unbounded.
const GLOBAL_TIMEOUT_MS = 300_000;
// Real mouse input needs a window Chromium actually presents. capture-ui.cjs measured
// the same effect for pixels (a hidden window paints 0% of the map frame); the input
// pipeline gets its own honest check below, so a --hidden run reports what it used.
const SHOW_WINDOW = !process.argv.includes("--hidden");
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

/**
 * Like `waitFor`, but a missed deadline is a measured result rather than an aborted
 * run: the caller records what was last observed and how long it took.
 */
async function pollRenderer(expression, isSettled, { timeoutMs = 20_000, intervalMs = 200 } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let value = null;
  for (;;) {
    value = await inRenderer(expression);
    if (isSettled(value)) return { settled: true, value, ms: Date.now() - startedAt };
    if (Date.now() > deadline) return { settled: false, value, ms: Date.now() - startedAt };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Read as source text by `inRenderer`, so it must stay free of nested backticks.
const TILE_GRID_PROBE = `(() => {
  const host = document.getElementById("map");
  if (!host) return null;
  const frame = host.getBoundingClientRect();
  const tiles = [...host.querySelectorAll("img.leaflet-tile")];
  if (!tiles.length) return null;
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const tile of tiles) {
    const r = tile.getBoundingClientRect();
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
  }
  return {
    tiles: tiles.length,
    loaded: tiles.filter((tile) => tile.naturalWidth > 0).length,
    coversLeft: left <= frame.left + 1,
    coversRight: right >= frame.right - 1,
    coversTop: top <= frame.top + 1,
    coversBottom: bottom >= frame.bottom - 1,
    grid: Math.round(right - left) + "x" + Math.round(bottom - top) + " of frame " + Math.round(frame.width) + "x" + Math.round(frame.height),
  };
})()`;

/* ------------------------------------------------------------------- real input */

/**
 * The route editor is judged on what a mouse does, so these helpers drive Chromium's
 * real input pipeline (`webContents.sendInputEvent`) rather than dispatching a JS
 * MouseEvent — a handler that only answers synthetic events would pass a fake test.
 *
 * `inputLands` records whether the window received those events at all — measured, not
 * assumed, by the first check that uses it. If it did not, the helpers fall back to
 * dispatched events and every affected check names the mechanism in its detail, so a
 * downgraded run cannot read as a stronger result.
 */
let inputLands = null;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The harness' own memory of the pointer. Chromium keeps one pressed-button state per
 * window, and a `mouseMove` delivered while that state says "left button held" is read
 * as a map drag, not a hover: Leaflet pans the view and suppresses the click that
 * follows it. One stale `mouseDown` would therefore turn the next three map clicks into
 * nothing and move the markers off the pixels they were judged on. Every gesture updates
 * this and repairs an unbalanced pair before it can do that damage.
 */
const pointer = { x: null, y: null, down: false };
let pointerRepairs = 0;

/** Controls a gesture asked for and the running app did not paint. */
const absentControls = [];

function boxOf(id) {
  return inRenderer(`(() => {
    const node = document.getElementById(${JSON.stringify(id)});
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
}

async function rawMouse(event) {
  window.webContents.sendInputEvent(event);
  if (event.type === "mouseMove") {
    pointer.x = event.x;
    pointer.y = event.y;
  } else if (event.type === "mouseDown") {
    pointer.down = true;
  } else if (event.type === "mouseUp") {
    pointer.down = false;
  }
  await wait(24);
}

/** Release a button the previous gesture left held, so a hover is never read as a drag. */
async function repairPointer(x, y) {
  if (!pointer.down) return false;
  pointerRepairs += 1;
  await rawMouse({ type: "mouseUp", x, y, clickCount: 1, button: "left" });
  return true;
}

async function realClick(x, y) {
  if (inputLands === false) return "dispatched";
  await repairPointer(x, y);
  await rawMouse({ type: "mouseMove", x, y });
  await rawMouse({ type: "mouseDown", x, y, clickCount: 1, button: "left" });
  await rawMouse({ type: "mouseUp", x, y, clickCount: 1, button: "left" });
  return "real";
}

/**
 * What occupies the centre of a node: the node itself, or something painted over it.
 * Toasts stack in the bottom-right corner, which at 1280×720 is exactly where the dock's
 * route-file buttons are — so a real click can land on a notification instead of the
 * control. That is not a harness artefact: the app removes a toast when it is clicked and
 * after 7 s, and a user has to do the same. The harness waits it out rather than clicking
 * through it, and says how long it waited.
 */
function hitOwner(selector) {
  return inRenderer(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return "missing";
    const r = node.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const over = document.elementFromPoint(x, y);
    if (!over) return "nothing";
    if (node.contains(over)) return "self";
    if (over.closest(".toast")) return "a toast";
    if (over.closest("#modal")) return "the modal backdrop";
    return String(over.className || over.tagName);
  })()`);
}

/** Wait out whatever is painted over a control, and report how long that took. */
async function settleOver(selector) {
  const inView = () =>
    inRenderer(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return "missing";
      const r = node.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) {
        node.scrollIntoView({ block: "center", inline: "nearest" });
        return "scrolled into view";
      }
      return "on screen";
    })()`);
  // At 1280×720 the Routes dock is taller than the viewport, so a panel near its end is
  // below the fold until it is scrolled to. A user scrolls; the harness scrolls and says
  // so, instead of clicking a coordinate that belongs to nothing.
  let scroll = await inView();
  if (scroll !== "on screen") {
    await wait(150);
    scroll = await inView();
  }
  let waited = 0;
  let owner = await hitOwner(selector);
  while (owner !== "self" && owner !== "missing" && waited < 9_000) {
    await wait(250);
    waited += 250;
    owner = await hitOwner(selector);
  }
  return { owner, waited, scroll };
}

/** Label a gesture with the mechanism and any waiting it had to do first. */
function gestureLabel(mode, { owner, waited, scroll }) {
  const notes = [];
  if (scroll && scroll !== "on screen") notes.push(scroll);
  if (owner !== "self") notes.push(`still covered by ${owner}`);
  else if (waited) notes.push(`waited ${waited} ms for a covering toast to expire`);
  return notes.length ? `${mode} (${notes.join(", ")})` : mode;
}

/** Move the cursor onto a node and click it, once nothing is on top of it. */
async function clickNode(id) {
  const settled = await settleOver(`#${id}`);
  const box = await boxOf(id);
  if (!box) return noteAbsent(`#${id}`);
  return gestureLabel(await realClick(box.x, box.y), settled);
}

/**
 * Press, move, release. Returns how far it got: "done", "no-input" when the window
 * never receives real events, or "missing-endpoint" when a marker that a previous check
 * expected was not painted. The last case must not throw — one absent marker should
 * fail its own check, not the eighteen that follow it.
 */
async function realDrag(from, to, steps = 12) {
  if (inputLands === false) return "no-input";
  if (!from || !to) return "missing-endpoint";
  await repairPointer(from.x, from.y);
  await rawMouse({ type: "mouseMove", x: from.x, y: from.y });
  await rawMouse({ type: "mouseDown", x: from.x, y: from.y, clickCount: 1, button: "left" });
  for (let step = 1; step <= steps; step += 1) {
    await rawMouse({
      type: "mouseMove",
      x: Math.round(from.x + ((to.x - from.x) * step) / steps),
      y: Math.round(from.y + ((to.y - from.y) * step) / steps),
    });
  }
  await rawMouse({ type: "mouseUp", x: to.x, y: to.y, clickCount: 1, button: "left" });
  return "done";
}

function dragLabel(status) {
  return { done: "real mouse drag", "no-input": "real mouse drag (input did not land)", "missing-endpoint": "no drag: the marker was not painted" }[status] || status;
}

/**
 * Fallback used only when real input never reaches the window: the same gesture as
 * dispatched DOM events, addressed by the number painted on the marker. Leaflet's
 * marker drag needs the move/up pair on the document.
 */
async function syntheticDragPin(hostId, number, from, to) {
  return inRenderer(`(() => {
    const icons = [...document.querySelectorAll("#" + ${JSON.stringify(hostId)} + " .leaflet-marker-icon")];
    const icon = icons.find((node) => node.querySelector(".pin-waypoint span")?.textContent.trim() === ${JSON.stringify(String(number))});
    if (!icon) return "missing";
    const fire = (target, type, x, y) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
    fire(icon, "mousedown", ${from.x}, ${from.y});
    const steps = 12;
    for (let step = 1; step <= steps; step += 1) {
      fire(document, "mousemove", Math.round(${from.x} + ((${to.x} - ${from.x}) * step) / steps), Math.round(${from.y} + ((${to.y} - ${from.y}) * step) / steps));
    }
    fire(document, "mouseup", ${to.x}, ${to.y});
    return "dispatched";
  })()`);
}

/**
 * Straight-line distance between two measured screen points. A missing measurement is
 * Infinity, never 0: a check that could not find its marker has to fail, not pass.
 */
function pixelDistance(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.round(Math.hypot(a.x - b.x, a.y - b.y));
}

/** Centre of the first node matching a selector, or null when nothing matches. */
function boxOfNode(selector) {
  return inRenderer(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
}

async function clickNodeAt(selector) {
  const settled = await settleOver(selector);
  const box = await boxOfNode(selector);
  if (!box) return noteAbsent(selector);
  return gestureLabel(await realClick(box.x, box.y), settled);
}

/**
 * A control the editor is supposed to offer but does not paint is a finding, not a
 * reason to abort: the check that follows it fails on its own evidence and one summary
 * line names everything that was missing.
 */
function noteAbsent(selector) {
  absentControls.push(selector);
  return `no such control: ${selector}`;
}

/**
 * A pixel inside a map frame at fractional coordinates, together with the element that
 * really occupies it. Reporting the hit target keeps a click that landed on an overlay
 * chip from being read as a click on the map.
 */
function mapPixel(id, fx, fy) {
  return inRenderer(`(() => {
    const host = document.getElementById(${JSON.stringify(id)});
    if (!host) return null;
    const r = host.getBoundingClientRect();
    const x = Math.round(r.left + r.width * ${fx});
    const y = Math.round(r.top + r.height * ${fy});
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: hit ? String(hit.className || hit.tagName) : "nothing" };
  })()`);
}

function rowCount() {
  return inRenderer(`document.querySelectorAll("#waypoint-list .list-row").length`);
}

/**
 * Wait for a map to stop moving, and say what moved. Two different things can shift the
 * pixels under a cursor: the Leaflet view can pan inside a fixed frame (the pane moves,
 * the frame does not) and the page layout can reflow around the map (both move together).
 * A click measured before either has settled lands on a coordinate that belongs to
 * something else, so both positions are read before and after every map gesture.
 */
async function settleMap(id) {
  const read = () =>
    inRenderer(`(() => {
      const host = document.getElementById(${JSON.stringify(id)});
      const pan = host?.querySelector(".leaflet-map-pane");
      if (!pan) return null;
      const r = pan.getBoundingClientRect();
      const f = host.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), fx: Math.round(f.left), fy: Math.round(f.top) };
    })()`);
  let pos = await read();
  let moves = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await wait(140);
    const next = await read();
    if (!next || !pos) return { pos: next, moves };
    if (next.x === pos.x && next.y === pos.y) return { pos: next, moves };
    moves += 1;
    pos = next;
  }
  return { pos, moves };
}

/** How far the view panned inside its frame, and how far the frame itself moved. */
function mapShift(before, after) {
  if (!before?.pos || !after?.pos) return { panPx: null, framePx: null };
  const rel = (s) => ({ x: s.pos.x - s.pos.fx, y: s.pos.y - s.pos.fy });
  const a = rel(before);
  const b = rel(after);
  return {
    panPx: Math.round(Math.hypot(b.x - a.x, b.y - a.y)),
    framePx: Math.round(Math.hypot(after.pos.fx - before.pos.fx, after.pos.fy - before.pos.fy)),
  };
}

/**
 * Click a fractional pixel of a map and wait for the editor to answer, so the snapshot
 * that judges the click cannot be read before the state update has painted. Carries the
 * evidence that separates "the app ignored the click" from "the harness dragged the map
 * instead of clicking it": how many mouse-moves arrived with a button held, and how far
 * the view shifted underneath the gesture.
 */
async function clickMap(id, fx, fy) {
  const before = await settleMap(id);
  const pixel = await mapPixel(id, fx, fy);
  const rowsBefore = await rowCount();
  const movesBefore = await inRenderer("window.__dragMoves ?? 0");
  const mode = await realClick(pixel.x, pixel.y);
  let waited = 0;
  let rows = rowsBefore;
  while (rows === rowsBefore && waited < 1_200) {
    await wait(80);
    waited += 80;
    rows = await rowCount();
  }
  let after = await settleMap(id);
  let shift = mapShift(before, after);
  let retryAt = null;
  // Nothing appended while the geometry is not where the pixel was measured means the
  // view panned or the page reflowed under the cursor — a user would watch the same click
  // miss. Put the pointer on the pixel as it now stands and click again; both attempts are
  // reported, so this recovery reads as a finding about the layout, not as a passing test.
  if (rows === rowsBefore && (shift.framePx > 2 || shift.panPx > 2)) {
    const fresh = await mapPixel(id, fx, fy);
    retryAt = `${fresh.x},${fresh.y}`;
    await realClick(fresh.x, fresh.y);
    let more = 0;
    while (rows === rowsBefore && more < 1_200) {
      await wait(80);
      more += 80;
      rows = await rowCount();
    }
    waited += more;
    after = await settleMap(id);
    shift = mapShift(before, after);
  }
  const dragMoves = (await inRenderer("window.__dragMoves ?? 0")) - movesBefore;
  return {
    ...pixel,
    mode,
    rowsBefore,
    rows,
    waited,
    dragMoves,
    ...shift,
    retryAt,
  };
}

/**
 * Everything the route editor claims about itself, read from what is painted: marker
 * pixels, the canvas the polyline draws into (Leaflet runs with `preferCanvas`, so the
 * line is pixels, not DOM), the list rows and the derived metrics.
 */
function routeSnapshot() {
  return inRenderer(`(() => {
    const frameOf = (id) => {
      const host = document.getElementById(id);
      if (!host) return null;
      const r = host.getBoundingClientRect();
      const pins = [...host.querySelectorAll(".leaflet-marker-icon")].map((node) => {
        const b = node.getBoundingClientRect();
        const inner = node.firstElementChild;
        return {
          kind: inner ? String(inner.className).split(" ")[0] : null,
          n: node.querySelector(".pin-waypoint span")?.textContent.trim() ?? null,
          selected: Boolean(node.querySelector(".pin-waypoint.selected")),
          border: inner ? getComputedStyle(inner).borderColor : null,
          x: Math.round(b.left + b.width / 2),
          y: Math.round(b.top + b.height / 2),
          w: Math.round(b.width),
          h: Math.round(b.height),
          inside: b.left >= r.left - 2 && b.top >= r.top - 2 && b.right <= r.right + 2 && b.bottom <= r.bottom + 2,
        };
      });
      const canvas = host.querySelector(".leaflet-overlay-pane canvas");
      let painted = 0;
      // A map whose container is hidden has a zero-sized canvas; getImageData throws
      // on a 0×0 region, so the pixel count is only taken from a canvas that has one.
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 8) painted += 1;
      }
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        left: Math.round(r.left),
        top: Math.round(r.top),
        waypoints: pins.filter((pin) => pin.kind === "pin-waypoint"),
        previewPin: pins.find((pin) => pin.kind === "pin-preview") || null,
        otherPins: [...new Set(pins.filter((pin) => pin.kind !== "pin-waypoint").map((pin) => pin.kind))],
        cursor: getComputedStyle(host).cursor,
        editingClass: host.classList.contains("route-editing"),
        canvases: host.querySelectorAll(".leaflet-overlay-pane canvas").length,
        painted,
      };
    };
    const read = (id) => document.getElementById(id)?.textContent.trim() ?? null;
    const play = document.getElementById("btn-preview-play");
    return {
      preview: frameOf("preview-map"),
      studio: frameOf("map"),
      count: read("route-count"),
      listEmpty: document.querySelector("#waypoint-list .empty")?.textContent.replace(/\\s+/g, " ").trim() ?? null,
      rows: [...document.querySelectorAll("#waypoint-list .list-row")].map((row) => ({
        number: row.querySelector(".wp-number")?.textContent.trim() ?? null,
        name: row.querySelector(".name")?.textContent.trim() ?? null,
        selected: row.classList.contains("selected"),
      })),
      distance: read("metric-distance"),
      duration: read("metric-duration"),
      updates: read("metric-updates"),
      waypointMetric: read("metric-waypoints"),
      timelineCount: read("timeline-count"),
      timeline: [...document.querySelectorAll("#timeline-list .list-row .name")].map((node) => node.textContent.trim()),
      state: read("preview-state"),
      note: read("preview-note"),
      status: read("coord-status"),
      playText: play.textContent.trim(),
      playDisabled: play.disabled,
      pauseText: document.getElementById("btn-preview-pause").textContent.trim(),
      pauseDisabled: document.getElementById("btn-preview-pause").disabled,
      resetDisabled: document.getElementById("btn-preview-reset").disabled,
      progress: read("preview-progress"),
      elapsed: read("preview-elapsed"),
      next: read("preview-next"),
      speed: read("preview-speed"),
      previewHint: read("preview-hint"),
      mapHint: read("map-hint"),
      help: read("waypoint-help"),
      pressedPreview: document.getElementById("btn-edit-route-preview").getAttribute("aria-pressed"),
      pressedMap: document.getElementById("btn-edit-route-map").getAttribute("aria-pressed"),
      toggleChecked: document.getElementById("toggle-route-edit").checked,
      lat: document.getElementById("input-lat").value,
      lon: document.getElementById("input-lon").value,
      speedInput: document.getElementById("input-speed").value,
      rateInput: document.getElementById("input-rate").value,
      sendRouteDisabled: document.getElementById("btn-send-route").disabled,
      sendPointDisabled: document.getElementById("btn-send-point").disabled,
      sendStatus: read("motion-send-status"),
      deviceTitle: read("motion-device-title"),
      deviceSub: read("motion-device-sub"),
      modalOpen: document.getElementById("modal").hidden === false,
      modalTitle: read("modal-title"),
      modalButtons: [...document.querySelectorAll("#modal-body button")].map((node) => node.textContent.trim()),
      clicks: window.__clicks ?? 0,
      containers: document.querySelectorAll(".leaflet-container").length,
    };
  })()`);
}

function buildChecks() {
  return async () => {
    // ---------------------------------------------------------------- boot
    const shell = await inRenderer(`(() => {
      const views = [...document.querySelectorAll("section.view")].map((node) => node.id);
      return {
        views,
        activeView: document.querySelector("section.view.active")?.id || null,
        navItems: [...document.querySelectorAll(".nav-item")].map((node) => node.dataset.view),
        hasApi: typeof window.locationStudio === "object",
        apiKeys: Object.keys(window.locationStudio || {}).length,
        hasGenericInvoke: "invoke" in (window.locationStudio || {}),
        title: document.title,
        inspector: document.getElementById("view-title")?.textContent || "",
        strip: ["strip-state", "strip-transport", "strip-model", "strip-pairing", "strip-tunnel"].map(
          (id) => document.getElementById(id)?.textContent.trim() ?? null
        ),
        connectDisabled: document.getElementById("btn-strip-connect")?.disabled,
      };
    })()`);

    record(
      "renderer: the five workspaces of the redesign are present",
      ["view-overview", "view-map", "view-motion", "view-device", "view-settings"].every((id) => shell.views.includes(id)),
      `views: ${shell.views.join(", ")}`
    );
    record(
      "renderer: navigation offers exactly Overview, Location, Routes, Device, Settings",
      shell.navItems.join(",") === "overview,map,motion,device,settings",
      `nav: ${shell.navItems.join(", ")}`
    );
    record("renderer: overview is the active view on boot", shell.activeView === "view-overview", `active: ${shell.activeView}`);
    record(
      "header: the status strip starts unmeasured and Connect is disabled",
      shell.strip.every((value) => value !== null) &&
        !/CONNECTED/i.test(shell.strip.join(" ")) &&
        shell.connectDisabled === true,
      `strip: ${shell.strip.join(" | ")}`
    );
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
        // The cable check mark may only appear on an entry usbmuxd reported as USB.
        device.stages?.usbDetected === (device.connectionType === "USB") &&
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
    // A green "VERIFIED / HARDWARE" badge is a claim about the past, so the bridge has to
    // hand over the device and date it was made on; without it the UI could not say so.
    const capProvenance = capabilities.data?.provenance || null;
    record(
      "capabilities: hardware badges arrive with the bench and date behind them",
      Boolean(capProvenance?.verifiedOn) && /iPhone/.test(capProvenance?.bench || "") && Boolean(capProvenance?.note),
      capProvenance ? `${capProvenance.verifiedOn} · ${capProvenance.bench}` : "the bridge sent no provenance with the matrix"
    );

    // -------------------------------------------------------------- basemap
    // The map must show real imagery. A key-gated provider still answers 200
    // with a decodable "API KEY REQUIRED" watermark, so decoded <img> pixels
    // alone prove nothing; the endpoint itself is also probed for real bytes.
    //
    // Boot lands on Overview, so the Location workspace has to be opened before its
    // map has a size at all: a hidden Leaflet container requests no tiles.
    await inRenderer(`document.querySelector('.nav-item[data-view="map"]').click()`);
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

    // ------------------------------------------------- the fold at 1280x720
    // §3 and §7 of the brief are geometric promises, so they are measured, not
    // eyeballed: the primary action has to be painted inside the viewport, and the
    // workspace columns must not overlap.
    const fold = await inRenderer(`(() => {
      const viewport = { w: window.innerWidth, h: window.innerHeight };
      const box = (id) => {
        const node = document.getElementById(id);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right), w: Math.round(rect.width), h: Math.round(rect.height) };
      };
      const start = box("btn-console-start-point");
      const column = document.querySelector("#view-map .main-col")?.getBoundingClientRect();
      const dock = document.querySelector("#view-map .dock")?.getBoundingClientRect();
      const map = box("map");
      return {
        viewport,
        start,
        startText: document.getElementById("btn-console-start-point")?.textContent.trim(),
        startDisabled: document.getElementById("btn-console-start-point")?.disabled,
        startHint: document.getElementById("console-start-hint")?.textContent.trim(),
        map,
        column: column ? { left: Math.round(column.left), right: Math.round(column.right) } : null,
        dock: dock ? { left: Math.round(dock.left), right: Math.round(dock.right) } : null,
        stripVisible: (() => {
          const rect = document.getElementById("device-strip").getBoundingClientRect();
          return rect.height > 12 && rect.top >= 0 && rect.bottom <= 60;
        })(),
        // A strip that has run out of header clips mid-word, which reads as a broken
        // build; the eyebrow wrapping to two lines does the same.
        stripClipped: (() => {
          const s = document.getElementById("device-strip");
          return s.scrollWidth > s.clientWidth + 1;
        })(),
        eyebrowHeight: Math.round(document.getElementById("view-eyebrow").getBoundingClientRect().height),
        primaryPanel: (() => {
          const panel = document.getElementById("btn-console-start-point").closest(".panel");
          const rect = panel.getBoundingClientRect();
          return { top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
        })(),
      };
    })()`);

    record(
      "layout: the viewport really is the smallest target size",
      fold.viewport.w >= 1200 && fold.viewport.h >= 640,
      `${fold.viewport.w}×${fold.viewport.h} CSS px`
    );
    record(
      "layout: Start Location Simulation is painted above the fold without scrolling",
      Boolean(fold.start) && fold.start.h > 20 && fold.start.top >= 0 && fold.start.bottom <= fold.viewport.h,
      `button ${fold.start ? `${fold.start.w}×${fold.start.h}, bottom ${fold.start.bottom} of ${fold.viewport.h}` : "missing"}: "${fold.startText}"`
    );
    record(
      "layout: the map keeps usable space in the main column",
      Boolean(fold.map) && fold.map.w > 300 && fold.map.h > 200,
      `#map ${fold.map?.w}×${fold.map?.h}`
    );
    record(
      "layout: the control dock sits beside the map column instead of over it",
      fold.column && fold.dock && fold.dock.left >= fold.column.right - 1 && fold.dock.right <= fold.viewport.w + 1,
      `column ${fold.column?.left}–${fold.column?.right}, dock ${fold.dock?.left}–${fold.dock?.right} of ${fold.viewport.w}`
    );
    record("layout: the header status strip is painted inside the top bar", fold.stripVisible === true, "strip measured in the top 60 px");
    record(
      "layout: the header strip is not clipped and the eyebrow never wraps",
      fold.stripClipped === false && fold.eyebrowHeight <= 16,
      `strip clipped: ${fold.stripClipped}; eyebrow ${fold.eyebrowHeight === 0 ? "dropped at this width (the title already names the workspace)" : `${fold.eyebrowHeight} px tall, one line`}`
    );
    // The strip is the one header element whose wording the bridge chooses, and a real
    // iPhone lengthens every cell at once. A bench cannot summon a phone on demand and the
    // phone is not always plugged in, so each tier of wording devicestrip.js can write is
    // painted deliberately and measured, then restored exactly as it was found.
    async function measureStripWording(words, label) {
      const measured = await inRenderer(`(() => {
        const words = ${JSON.stringify(words)};
        const strip = document.getElementById("device-strip");
        const read = () => [...strip.querySelectorAll(".strip-item")]
          .map((item) => item.dataset.cell + "=" + item.querySelector("b").textContent).join("|");
        const before = read();
        const saved = [...strip.querySelectorAll(".strip-item")].map((item) => ({
          cell: item.dataset.cell,
          value: item.querySelector("b").textContent,
          tone: item.dataset.tone || null,
        }));
        for (const [id, text] of Object.entries(words)) document.getElementById(id).textContent = text;
        const items = [...strip.querySelectorAll(".strip-item")]
          .filter((item) => item.offsetWidth > 0)
          .map((item) => {
            const key = item.querySelector(".k");
            const value = item.querySelector("b");
            return {
              cell: item.dataset.cell,
              labelWhole: Math.abs(key.getBoundingClientRect().width - key.scrollWidth) < 0.6,
              ellipsized: value.scrollWidth > value.clientWidth + 0.5,
            };
          });
        const rect = strip.getBoundingClientRect();
        const actions = document.querySelector(".topbar-actions").getBoundingClientRect();
        const answer = {
          viewport: { w: window.innerWidth, h: window.innerHeight },
          clipped: strip.scrollWidth > strip.clientWidth + 1,
          items,
          right: Math.round(rect.right),
          actionsLeft: Math.round(actions.left),
          height: Math.round(rect.height),
        };
        for (const cell of saved) {
          const item = strip.querySelector('[data-cell="' + cell.cell + '"]');
          item.querySelector("b").textContent = cell.value;
          if (cell.tone) item.dataset.tone = cell.tone;
          else delete item.dataset.tone;
        }
        answer.before = before;
        answer.after = read();
        return answer;
      })()`);
      const shown = measured.items.map((item) => item.cell + (item.ellipsized ? "(…)" : "")).join(" ");
      return { ...measured, label, shown, short: measured.items.filter((item) => item.ellipsized).length };
    }
    // Every string the module can write, at once - the layout must fall back to an
    // ellipsis on a value, never clip a word at the container edge.
    const worstStrip = await measureStripWording(
      {
        "strip-state": "PAIRED, NOT LINKED",
        "strip-transport": "WI-FI · CABLE-FREE",
        "strip-model": "Studio Bench iPhone · iOS 27.0.1",
        "strip-pairing": "RECORD, TRUST UNCONFIRMED",
        "strip-tunnel": "OPEN ON ANOTHER DEVICE",
      },
      "every verdict at its longest"
    );
    record(
      "layout: the header strip absorbs the longest device verdicts without clipping",
      worstStrip.clipped === false &&
        worstStrip.items.length >= 3 &&
        worstStrip.items.every((item) => item.labelWhole) &&
        worstStrip.right <= worstStrip.actionsLeft &&
        worstStrip.height <= 34 &&
        worstStrip.after === worstStrip.before,
      `${worstStrip.label}: ${worstStrip.items.length} cell(s) → ${worstStrip.shown} · strip ends at ${worstStrip.right} px, actions start at ${worstStrip.actionsLeft} px of ${worstStrip.viewport.w}; ${worstStrip.height} px tall; text restored exactly (${worstStrip.before})`
    );
    // The wording the bench iPhone actually produced over USB: paired, trusted, tunnel
    // closed. Nothing here is allowed to abbreviate - a driver reading the header has to
    // see the verdict whole or the status stops being evidence.
    const wiredStrip = await measureStripWording(
      {
        "strip-state": "PAIRED, NOT LINKED",
        "strip-transport": "USB",
        "strip-model": "iPhone · iOS 27.0.1",
        "strip-pairing": "TRUSTED",
        "strip-tunnel": "CLOSED",
      },
      "the paired-cable case"
    );
    record(
      "layout: a paired iPhone over a cable reads whole in the header",
      wiredStrip.clipped === false &&
        wiredStrip.short === 0 &&
        wiredStrip.items.every((item) => item.labelWhole) &&
        wiredStrip.right <= wiredStrip.actionsLeft &&
        wiredStrip.after === wiredStrip.before,
      `${wiredStrip.label}: ${wiredStrip.items.length} cell(s) → ${wiredStrip.shown} · strip ends at ${wiredStrip.right} px, ${wiredStrip.viewport.w - wiredStrip.actionsLeft} px left for the header actions`
    );
    // A wireless developer session is the widest realistic link/tunnel pair.
    const airStrip = await measureStripWording(
      {
        "strip-state": "CONNECTED",
        "strip-transport": "WI-FI · CABLE-FREE",
        "strip-model": "iPhone · iOS 27.0.1",
        "strip-pairing": "TRUSTED",
        "strip-tunnel": "OPEN · CABLE-FREE",
      },
      "the cable-free session case"
    );
    record(
      "layout: a wireless session reads whole in the header too",
      airStrip.clipped === false &&
        airStrip.short === 0 &&
        airStrip.items.every((item) => item.labelWhole) &&
        airStrip.right <= airStrip.actionsLeft &&
        airStrip.after === airStrip.before,
      `${airStrip.label}: ${airStrip.items.length} cell(s) → ${airStrip.shown} · ends at ${airStrip.right} of ${airStrip.viewport.w}, actions at ${airStrip.actionsLeft}`
    );
    // The rail is the one column that must never need hunting: a workspace row or a
    // status card that falls below its own scroll edge is invisible in exactly the
    // moments the user is diagnosing a device.
    const railFit = await inRenderer(`(() => {
      const rail = document.querySelector(".rail");
      const railBox = rail.getBoundingClientRect();
      const nav = [...document.querySelectorAll(".nav-item")].map((node) => node.getBoundingClientRect());
      return {
        scrolls: rail.scrollHeight > rail.clientHeight + 4,
        overflowPx: rail.scrollHeight - rail.clientHeight,
        rows: nav.length,
        heights: nav.map((rect) => Math.round(rect.height)),
        widths: [...new Set(nav.map((rect) => Math.round(rect.width)))],
        lastBottom: Math.round(nav[nav.length - 1].bottom),
        railBottom: Math.round(railBox.bottom),
        cards: [...document.querySelectorAll(".rail-card")].map((card) => {
          const rect = card.getBoundingClientRect();
          return { title: card.querySelector("h4")?.textContent.trim(), inside: rect.bottom <= railBox.bottom + 1 && rect.height > 18 };
        }),
      };
    })()`);
    record(
      "layout: the rail shows all five workspaces and its status cards without scrolling",
      railFit.scrolls === false &&
        railFit.rows === 5 &&
        railFit.heights.every((h) => h >= 44 && h <= 48) &&
        railFit.lastBottom <= railFit.railBottom &&
        railFit.cards.length === 3 &&
        railFit.cards.every((card) => card.inside),
      `rail overflow ${railFit.overflowPx} px · rows ${railFit.heights.join("/")} px, widths ${railFit.widths.join("/")} · last row bottom ${railFit.lastBottom} of ${railFit.railBottom} · cards ${railFit.cards.map((card) => `${card.title}${card.inside ? "" : "(cut off)"}`).join(", ")}`
    );
    record(
      "layout: the whole primary action panel, its hint included, is above the fold",
      Boolean(fold.primaryPanel) && fold.primaryPanel.top >= 0 && fold.primaryPanel.bottom <= fold.viewport.h,
      `panel ${fold.primaryPanel?.top}–${fold.primaryPanel?.bottom} of ${fold.viewport.h}`
    );
    // Where the loaded tiles sit relative to the map frame. A map revealed from a
    // hidden container keeps painting into the box it had at boot; this is the
    // geometric half of that check (the pixel half belongs to capture-ui.cjs).
    // Tiles arrive over the network, so coverage is polled with a deadline instead of
    // sampled once — the first decoded tile lands long before the grid fills the frame.
    const grid = await pollRenderer(TILE_GRID_PROBE, (value) =>
      Boolean(value) && value.coversLeft && value.coversRight && value.coversTop && value.coversBottom,
      { timeoutMs: 20_000, intervalMs: 250 }
    );
    record(
      "map: the loaded tile grid covers the whole frame, not just the boot-time box",
      grid.settled,
      grid.value
        ? `${grid.value.loaded}/${grid.value.tiles} tiles loaded, ${grid.value.grid}, settled after ${grid.ms} ms`
        : `no tiles measured after ${grid.ms} ms`
    );
    const primaryAction = await inRenderer(`(() => ({
      disabled: document.getElementById("btn-console-start-point").disabled,
      hint: document.getElementById("console-start-hint").textContent.trim(),
    }))()`);
    record(
      "primary action: its state is always explained by the hint under it",
      (primaryAction.disabled === true
        ? /device|bridge|ready|select|scan|trust|developer/i.test(primaryAction.hint)
        : /readiness|not passed|prerequisite|developer|trust|real error/i.test(primaryAction.hint)) &&
        (attachedCount === 0 ? primaryAction.disabled === true : true),
      `${attachedCount} iPhone(s) attached: button disabled=${primaryAction.disabled}, hint "${primaryAction.hint}" (boot hint was "${fold.startHint}")`
    );

    // Keyboard navigation is a §6 promise: 1..5 reach the five workspaces.
    for (const [key, expected] of [["1", "view-overview"], ["3", "view-motion"], ["5", "view-settings"]]) {
      await inRenderer(`document.getElementById("input-search").blur(); document.body.focus();`);
      await inRenderer(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "${key}", bubbles: true }))`);
      const active = await inRenderer(`document.querySelector("section.view.active")?.id || null`);
      record(`keyboard: key "${key}" switches to ${expected}`, active === expected, `active: ${active}`);
    }
    await inRenderer(`document.querySelector('.nav-item[data-view="map"]').click()`);

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

    const stageKeys = [
      "usbDetected",
      "paired",
      "wirelessReachable",
      "developerModeEnabled",
      "developerServiceAvailable",
      "tunnelOverWireless",
      "simulationReady",
    ];
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

    // --------------------------------------------------------- wireless link
    // The link panels live in the Device workspace now. They must be *painted*, not
    // merely present in the document, and must show nothing until the bridge has
    // measured something.
    await inRenderer(`document.querySelector('.nav-item[data-view="device"]').click()`);
    const wirelessShell = await inRenderer(`(() => {
      const section = document.getElementById("view-device");
      const rect = section.getBoundingClientRect();
      return {
        active: document.querySelector("section.view.active")?.id || null,
        visible: section.classList.contains("active") && section.offsetParent !== null,
        painted: rect.height > 200 && rect.width > 300,
        rowsBeforeProbe: document.querySelectorAll("#wireless-transports .check").length,
        emptyRows: [...document.querySelectorAll("#view-device .empty")].map((node) => node.textContent.trim()),
        tag: document.getElementById("wireless-probed-tag").textContent.trim(),
        railChip: document.getElementById("rail-wireless-chip").textContent.trim(),
        disconnectDisabled: document.getElementById("btn-wireless-disconnect").disabled,
        readinessDisabled: document.getElementById("btn-wireless-readiness").disabled,
        capabilityTag: document.getElementById("wireless-capability-tag").textContent.trim(),
        actionNote: document.getElementById("wireless-action-note").textContent.replace(/\\s+/g, " ").trim(),
        selectedDevice: document.getElementById("device-list")?.querySelector(".device-card.selected")?.textContent.replace(/\\s+/g, " ").trim().slice(0, 46) ?? null,
        helpExists: Boolean(document.getElementById("btn-wireless-help")),
      };
    })()`);
    record(
      "ui: the Device workspace is active and painted, not just in the DOM",
      wirelessShell.active === "view-device" && wirelessShell.visible && wirelessShell.painted,
      `active=${wirelessShell.active}, visible=${wirelessShell.visible}, painted=${wirelessShell.painted}`
    );
    // The matrix loads over IPC, so the caption under it is polled rather than sampled.
    await waitFor(
      async () => {
        const text = await inRenderer(`document.getElementById("capability-provenance").textContent.trim()`);
        return /iPhone\(s\) attached/.test(text);
      },
      { label: "capability provenance line to fill in", timeoutMs: 20_000 }
    );
    const capCaption = await inRenderer(`(() => {
      const node = document.getElementById("capability-provenance");
      const rect = node.getBoundingClientRect();
      return { text: node.textContent.trim(), painted: rect.width > 160 && rect.height > 8 };
    })()`);
    record(
      "device: the capability matrix says which session it does not measure",
      capCaption.painted && /\d+ iPhone\(s\) attached/.test(capCaption.text) && /verified on hardware/i.test(capCaption.text),
      `${capCaption.text.slice(0, 190)}${capCaption.text.length > 190 ? "…" : ""}`
    );
    record(
      "ui: before a probe the link panels claim nothing about the network",
      wirelessShell.rowsBeforeProbe === 0 &&
        wirelessShell.tag === "NOT PROBED" &&
        /NOT PROBED/.test(wirelessShell.railChip) &&
        wirelessShell.emptyRows.length >= 2 &&
        !/connected|ready|reachable/i.test(wirelessShell.emptyRows.join(" ")),
      `tag=${wirelessShell.tag}, rail="${wirelessShell.railChip}", rows=${wirelessShell.rowsBeforeProbe}, empty="${wirelessShell.emptyRows.join(" / ")}"`
    );
    const linkDevice = currentDevices[0]?.deviceId ?? null;
    const linkFact = linkDevice
      ? await inRenderer(`window.locationStudio.getWirelessStatus({ deviceId: ${JSON.stringify(linkDevice)} })`)
      : { ok: false, data: null, error: { message: "no device to ask about" } };
    const sessionOpen = Boolean(linkFact.data?.activeSession?.open);
    record(
      "ui: the wireless controls match the session the bridge actually reports",
      wirelessShell.helpExists &&
        wirelessShell.disconnectDisabled === !sessionOpen &&
        (linkDevice ? true : wirelessShell.readinessDisabled === true),
      `bridge activeSession.open=${sessionOpen} for ${linkDevice ? "the attached iPhone" : `no device (${linkFact.error?.message})`}: disconnect disabled=${wirelessShell.disconnectDisabled}, readiness disabled=${wirelessShell.readinessDisabled}, capability tag "${wirelessShell.capabilityTag}", note "${wirelessShell.actionNote}"`
    );

    // Drive the real button: the probe browses multicast DNS, so it takes seconds.
    await inRenderer(`document.getElementById("btn-wireless-probe").click()`);
    await waitFor(
      async () => {
        const snapshot = await inRenderer(
          `(() => ({ tag: document.getElementById("wireless-probed-tag").textContent.trim(), busy: document.getElementById("btn-wireless-probe").disabled }))()`
        );
        return !snapshot.busy && snapshot.tag !== "PROBING…";
      },
      { label: "wireless probe to finish", timeoutMs: 120_000 }
    );
    const wirelessStatus = await inRenderer("window.locationStudio.getWirelessStatus({})");
    const lastProbe = wirelessStatus.data?.lastProbe || null;
    const wirelessView = await inRenderer(`(() => {
      const rows = [...document.querySelectorAll("#wireless-transports .check")].map((row) => ({
        transport: row.querySelector(".label").textContent.trim(),
        ok: row.getAttribute("data-ok"),
        mark: row.querySelector(".mark").textContent.trim(),
        painted: row.getBoundingClientRect().height > 18,
      }));
      const list = document.getElementById("wireless-candidates");
      return {
        rows,
        probeTag: document.getElementById("wireless-probed-tag").textContent.trim(),
        capabilityTag: document.getElementById("wireless-capability-tag").textContent.trim(),
        sessionCell: document.getElementById("kv-wireless-session").textContent.trim(),
        // reportError() writes to the in-app console, not to the JS console, so this is
        // the only place a rejected probe leaves its reason.
        errorLines: [...document.querySelectorAll("#console-log .log-line.error")].map((line) =>
          line.textContent.trim().slice(0, 220)
        ),
        metrics: ["link-usb", "link-wifi", "link-tunnel"].map((id) => document.getElementById(id).textContent.trim()),
        summary: document.getElementById("wireless-summary").textContent.trim(),
        candidates: [...list.querySelectorAll(".device-card")].map((card) => ({
          text: card.textContent.replace(/\\s+/g, " ").trim(),
          reached: [...card.querySelectorAll(".chip.ok")].map((chip) => chip.textContent.trim()),
          seenOnly: [...card.querySelectorAll(".chip.warn")].map((chip) => chip.textContent.trim()),
          connectable: [...card.parentElement.querySelectorAll("button")].map((button) => button.textContent.trim()),
        })),
        candidateEmpty: list.querySelector(".empty")?.textContent.trim() || null,
        capabilityRows: [...document.querySelectorAll("#wireless-capability .check")].map((row) => ({
          label: row.querySelector(".label").textContent.trim(),
          ok: row.getAttribute("data-ok"),
          detail: row.querySelector(".detail")?.textContent.trim() || "",
        })),
        issues: document.querySelectorAll("#wireless-issues .banner-note").length,
        issueEmpty: document.querySelector("#wireless-issues .empty")?.textContent.trim() || null,
        diagnostics: ["kv-wireless-mdns", "kv-wireless-records", "kv-wireless-selected", "kv-wireless-session"].map(
          (id) => document.getElementById(id).textContent.trim()
        ),
        text: document.getElementById("view-device").textContent.replace(/\\s+/g, " "),
        railChip: document.getElementById("rail-wireless-chip").textContent.trim(),
        disconnectDisabled: document.getElementById("btn-wireless-disconnect").disabled,
      };
    })()`);

    record(
      "wireless: the probe ran and painted one row per transport",
      lastProbe !== null &&
        wirelessView.probeTag !== "PROBE FAILED" &&
        wirelessView.rows.length === 3 &&
        wirelessView.rows.every((row) => row.painted),
      `${wirelessView.rows.length} row(s), tag=${wirelessView.probeTag}: ${wirelessView.rows
        .map((row) => `${row.transport}=${row.ok}`)
        .join(" | ")}${wirelessView.errorLines.length ? ` // ${wirelessView.errorLines.join(" | ")}` : ""}`
    );
    const transportTruth = ["usb", "wifi-mux", "rsd-lan"].map((key) => lastProbe?.transports?.[key]?.available);
    record(
      "wireless: each transport row's mark equals what the bridge measured",
      wirelessView.rows.map((row) => row.ok).join(",") === transportTruth.map((value) => String(value)).join(","),
      `DOM ${wirelessView.rows.map((row) => row.ok).join(",")} vs bridge ${transportTruth.join(",")}`
    );
    record(
      "wireless: the summary is the bridge's verdict, verbatim",
      Boolean(lastProbe?.verdict?.summary) && wirelessView.summary.startsWith(lastProbe.verdict.summary),
      wirelessView.summary.slice(0, 140)
    );
    record(
      "wireless: diagnostics cells are filled from the probe, not left blank",
      wirelessView.diagnostics.every((value) => value && value !== "—") && wirelessView.metrics.every((value) => value !== "—"),
      `${wirelessView.diagnostics.join(" | ")} // ${wirelessView.metrics.join(" | ")}`
    );
    // Field names and PEM headers that only ever belong to a pairing record. A bare
    // "Users" is deliberately absent: Settings legitimately prints the workspace path,
    // which lives under C:\Users\, and a path on disk is not pairing material.
    const pairingHits = [...new Set(wirelessView.text.match(/-----BEGIN[A-Z ]*|privateKey|hostPairingId|PairingRecord|EscrowBag|SystemBUID|\.plist/gi) || [])];
    record(
      "wireless: pairing material never reaches the window",
      pairingHits.length === 0,
      pairingHits.length
        ? `matched ${pairingHits.map((token) => `"${token}"`).join(", ")} in ${wirelessView.text.length} chars of visible text`
        : `scanned ${wirelessView.text.length} chars of the Device workspace for key or record material`
    );
    // wireless.js gates the disconnect control per device, so the fact it must match is
    // "a developer session is open for the device on screen", not "a tunnel exists".
    const linkStatusNow = linkDevice
      ? await inRenderer(`window.locationStudio.getWirelessStatus({ deviceId: ${JSON.stringify(linkDevice)} })`)
      : wirelessStatus;
    const sessionNow = Boolean(linkDevice ? linkStatusNow.data?.activeSession?.open : linkStatusNow.data?.tunnel?.open);
    // Only the status surfaces may claim a link. Prose elsewhere in the panel legitimately
    // says "while the phone was connected over USB" or "confirm the adapter is connected",
    // so scanning the whole panel text would punish honest troubleshooting advice.
    const statusSurfaces = [
      ["rail chip", wirelessView.railChip],
      ["probe tag", wirelessView.probeTag],
      ["capability tag", wirelessView.capabilityTag],
      ["active session cell", wirelessView.sessionCell],
    ];
    record(
      "wireless: no status surface claims a link while no developer session is open",
      sessionNow ||
        (statusSurfaces.every(([, text]) => !/link open|connected|gps (overridden|changed)/i.test(text)) &&
          wirelessView.sessionCell === "no developer session" &&
          !wirelessView.capabilityRows.some((row) => row.ok === "true") &&
          !/GPS (OVERRIDDEN|CHANGED)/i.test(wirelessView.text)),
      `${statusSurfaces.map(([label, text]) => `${label}="${text}"`).join(", ")}; capability rows ${wirelessView.capabilityRows
        .map((row) => row.ok)
        .join(",")}`
    );
    record(
      "wireless: the disconnect control is enabled only while a session is open",
      sessionNow || wirelessView.disconnectDisabled,
      `disabled=${wirelessView.disconnectDisabled}, session open=${sessionNow} for ${linkDevice ? "the attached device" : "no device"}`
    );
    record(
      "wireless: the capability panel answers four questions and names its medium",
      wirelessView.capabilityRows.length === 4 &&
        wirelessView.capabilityRows.every((row) => ["true", "false", "null"].includes(row.ok)) &&
        wirelessView.capabilityRows
          .filter((row) => row.ok === "true")
          .every((row) => /cable-free|wireless|over |Measured on/i.test(row.detail)),
      wirelessView.capabilityRows.map((row) => `${row.label}=${row.ok}`).join(", ")
    );
    // A candidate may show a green "REACHED" chip exactly as many times as the bridge
    // recorded a completed handshake for it - never more. An advertisement alone has to
    // paint as "SEEN ONLY".
    const candidateTruth = (lastProbe?.candidates || []).map((candidate) => {
      const row = wirelessView.candidates.find((entry) => entry.text.includes(candidate.deviceId));
      const expectedReached = (candidate.reachableOver || []).length;
      const expectedSeenOnly = (candidate.seenOn || []).filter((t) => !(candidate.reachableOver || []).includes(t)).length;
      return {
        deviceId: candidate.deviceId,
        reachableOver: candidate.reachableOver || [],
        found: Boolean(row),
        chipsOk: row ? row.reached.length : 0,
        chipsWarn: row ? row.seenOnly.length : 0,
        ok: Boolean(row) && row.reached.length === expectedReached && row.seenOnly.length === expectedSeenOnly,
      };
    });
    record(
      "wireless: a device that was only advertised is not listed as reachable",
      candidateTruth.every((entry) => entry.ok),
      candidateTruth.length
        ? candidateTruth.map((entry) => `${entry.deviceId.slice(0, 8)}… reached=${entry.chipsOk}/${entry.reachableOver.length}`).join(", ")
        : "no candidate was seen, so nothing was claimed"
    );
    record(
      "wireless: a connect button only appears for an allowlisted transport",
      wirelessView.candidates.every((row) =>
        row.connectable
          .filter((label) => /^connect /i.test(label))
          .every((label) => ["connect usb", "connect wifi-mux", "connect rsd-lan"].includes(label.toLowerCase()))
      ),
      wirelessView.candidates.map((row) => row.connectable.join("/")).join(" | ") || "no candidate row"
    );
    record(
      "wireless: an empty candidate list explains the network instead of blaming a device",
      wirelessView.candidates.length > 0
        ? true
        : /not|no iphone|wireless|enabled|observation/i.test(wirelessView.candidateEmpty || "") &&
            !/connected|ready/i.test(wirelessView.candidateEmpty || ""),
      `candidates list says: "${wirelessView.candidateEmpty}"`
    );

    // ------------------------------------------------------- settings workspace
    // The one-time wireless checklist is instructions the app can only partly observe.
    // A tick is allowed exactly where the bridge measured the fact behind it.
    await inRenderer(`document.querySelector('.nav-item[data-view="settings"]').click()`);
    const settingsView = await inRenderer(`(() => {
      const rows = [...document.querySelectorAll("#wireless-setup-checks .check")].map((row) => ({
        label: row.querySelector(".label").textContent.trim(),
        ok: row.getAttribute("data-ok"),
        evidence: [...row.querySelectorAll(".body .detail")].map((node) => node.textContent.trim()).pop() || "",
        painted: row.getBoundingClientRect().height > 18,
      }));
      return {
        active: document.querySelector("section.view.active")?.id || null,
        rows,
        note: document.getElementById("settings-setup-note").textContent.trim(),
        basemap: document.getElementById("select-tile-style").value,
        workspaceFile: document.getElementById("settings-workspace-file").textContent.trim(),
        version: document.getElementById("settings-app-version").textContent.trim(),
        limitations: document.getElementById("btn-show-limitations") !== null,
      };
    })()`);

    const sawNetwork = Boolean(lastProbe?.transports?.["wifi-mux"]?.available || lastProbe?.transports?.["rsd-lan"]?.available);
    const usbmuxAnswered = Boolean(health.data?.usbmux?.available);
    // The checklist mirrors whatever the bridge reported last, and a phone can appear
    // mid-run, so the evidence behind each tick is re-read here instead of reusing the
    // scan taken several workspaces ago.
    const liveDevices = (await inRenderer("window.locationStudio.discoverDevices({ probeIdentity: false })")).data?.devices ?? currentDevices;
    const selected = liveDevices[0] || null;
    // A tick is only allowed where the bridge measured the fact behind it. Each row is
    // given the one observation that could justify it; the app may not invent the rest.
    const evidenceFor = [
      () => Boolean(selected?.stages?.paired === true),
      () => sawNetwork,
      () => sawNetwork,
      () => usbmuxAnswered,
      () => Boolean(selected?.stages?.developerModeEnabled === true),
      () => Boolean(selected?.identity?.productVersion),
    ];
    const unjustified = settingsView.rows
      .map((row, index) => ({ row, index, claim: row.ok === "true", allowed: evidenceFor[index]() }))
      .filter((entry) => entry.claim && !entry.allowed)
      .map((entry) => `row ${entry.index + 1} ("${entry.row.label}") is ticked with nothing behind it`);
    record(
      "settings: the setup checklist never ticks a step the bridge did not measure",
      settingsView.active === "view-settings" && settingsView.rows.length === 6 && unjustified.length === 0,
      unjustified.length
        ? unjustified.join(" | ")
        : `rows ${settingsView.rows.map((row) => row.ok).join(",")} · sawNetwork=${sawNetwork}, usbmux=${usbmuxAnswered}, device=${liveDevices.length}`
    );
    record(
      "settings: the service row is exactly the health report's answer",
      settingsView.rows[3]?.ok === String(usbmuxAnswered),
      `DOM=${settingsView.rows[3]?.ok} bridge=${usbmuxAnswered}`
    );
    record(
      "settings: with no iPhone selected the device-scoped steps stay unmeasured",
      liveDevices.length > 0 ||
        [0, 4, 5].every((index) => settingsView.rows[index]?.ok === "null" && /Not measured/i.test(settingsView.rows[index]?.evidence || "")),
      settingsView.rows.map((row) => `${row.ok}`).join(",")
    );
    record(
      "settings: every row names its evidence instead of a bare tick",
      settingsView.rows.every((row) => row.evidence.length > 10) && settingsView.rows.every((row) => row.painted),
      settingsView.rows.map((row) => `${row.label}=${row.ok}`).join(" | ")
    );
    record(
      "settings: the workspace file shown is the isolated one this run was started with",
      String(settingsView.workspaceFile).startsWith(scratch),
      `${settingsView.workspaceFile} · basemap ${settingsView.basemap} · ${settingsView.version}`
    );

    // --------------------------------------------------------- routes workspace
    // Priority 1 of the brief is a promise about what a mouse does, so the whole edit
    // cycle — empty → editing → click → drag → select → reorder → delete → play →
    // clear — runs through Chromium's real input pipeline and is judged on pixels that
    // were painted, not on state the renderer keeps for itself.
    await inRenderer(`document.querySelector('.nav-item[data-view="motion"]').click()`);
    await inRenderer(`(() => {
      window.__clicks = 0;
      window.__dragMoves = 0;
      document.addEventListener("click", () => { window.__clicks += 1; }, true);
      document.addEventListener("mousemove", (event) => { if (event.buttons !== 0) window.__dragMoves += 1; }, true);
    })()`);
    const inert = await boxOf("view-title");
    await realClick(inert.x, inert.y);
    const landedClicks = await inRenderer("window.__clicks");
    inputLands = landedClicks > 0;
    const gestureMode = () => (inputLands ? "real mouse" : "dispatched DOM events (real input did not reach the window)");
    record(
      "input: a real mouse click reaches the window's hit-test pipeline",
      inputLands === true,
      `window shown=${SHOW_WINDOW}; a click at ${inert.x},${inert.y} produced ${landedClicks} DOM click event(s)`
    );

    const empty = await routeSnapshot();
    record(
      "routes: the preview map fills its frame inside the 1280×720 target",
      empty.preview.w > 300 && empty.preview.h > 200 && empty.count === "0 WAYPOINTS",
      `preview map ${empty.preview.w}×${empty.preview.h}, play button bottom-edge inside ${empty.preview.h} px frame`
    );
    record(
      "routes: an empty route looks empty — no marker, no invented line, no metrics, no Play",
      empty.rows.length === 0 &&
        empty.preview.waypoints.length === 0 &&
        empty.preview.canvases === 0 &&
        empty.studio.canvases === 0 &&
        empty.playDisabled === true &&
        empty.state === "NO ROUTE" &&
        /^0/.test(empty.distance) &&
        empty.duration === "00:00" &&
        empty.updates === "0",
      `markers ${empty.preview.waypoints.length}, vector canvases ${empty.preview.canvases}/${empty.studio.canvases} (preview/location), distance "${empty.distance}", duration "${empty.duration}", updates "${empty.updates}", state "${empty.state}", Play disabled=${empty.playDisabled}`
    );
    // A dimmed accent button still reads as the thing to press, so the disabled state has
    // to be visible in the paint, not only in the `disabled` attribute. Both buttons are
    // real: Play is blocked by the empty route, Add target pin is genuinely available.
    const affordance = await inRenderer(`(() => {
      const style = (id) => {
        const node = document.getElementById(id);
        const cs = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return {
          disabled: node.disabled,
          background: cs.backgroundColor,
          color: cs.color,
          opacity: cs.opacity,
          painted: rect.height > 16 && rect.width > 30,
        };
      };
      return { blocked: style("btn-preview-play"), ready: style("btn-add-waypoint") };
    })()`);
    record(
      "ui: a disabled primary action is painted unavailable instead of only faded",
      affordance.blocked.disabled === true &&
        affordance.ready.disabled === false &&
        affordance.blocked.painted &&
        affordance.ready.painted &&
        affordance.blocked.background !== affordance.ready.background &&
        affordance.blocked.opacity === "1",
      `blocked Play paints ${affordance.blocked.background} at opacity ${affordance.blocked.opacity} against available “+ Add target pin” ${affordance.ready.background}`
    );
    record(
      "routes: the empty list says how to begin instead of showing a placeholder shape",      /no waypoints yet/i.test(empty.listEmpty || "") &&
        /add target pin|edit route/i.test(empty.listEmpty || "") &&
        /no waypoints yet/i.test(empty.note || ""),
      `list: "${empty.listEmpty}" · note: "${empty.note}"`
    );
    record(
      "routes: with editing off, both chips say a click will not add a waypoint",
      empty.pressedPreview === "false" &&
        empty.pressedMap === "false" &&
        empty.toggleChecked === false &&
        /clicks pan/i.test(empty.previewHint) &&
        /moves the target pin/i.test(empty.mapHint),
      `preview chip "${empty.previewHint}" · location chip "${empty.mapHint}"`
    );

    const modeMechanism = await clickNode("btn-edit-route-preview");
    const editing = await routeSnapshot();
    record(
      "routes: Edit Route is a visibly distinct mode and the cursor says what a click will do",
      editing.pressedPreview === "true" &&
        editing.pressedMap === "true" &&
        editing.toggleChecked === true &&
        editing.preview.editingClass === true &&
        editing.studio.editingClass === true &&
        editing.preview.cursor === "crosshair" &&
        editing.studio.cursor === "crosshair" &&
        /appends a waypoint/i.test(editing.previewHint) &&
        /appends a waypoint/i.test(editing.mapHint) &&
        /editing is on/i.test(editing.help),
      `${modeMechanism} click on #btn-edit-route-preview → aria-pressed ${editing.pressedPreview}/${editing.pressedMap}, cursors ${editing.preview.cursor} and ${editing.studio.cursor}, chips "${editing.previewHint}" / "${editing.mapHint}"`
    );

    const clicksBefore = await inRenderer("window.__clicks");
    const pixels = [await clickMap("preview-map", 0.28, 0.7)];
    const one = await routeSnapshot();
    record(
      "routes: one click on the map adds exactly one waypoint, painted where it was clicked",
      one.count === "1 WAYPOINT" &&
        one.rows.length === 1 &&
        one.preview.waypoints.length === 1 &&
        one.preview.waypoints[0].n === "1" &&
        one.preview.waypoints[0].inside === true &&
        pixelDistance(one.preview.waypoints[0], pixels[0]) <= 6,
      `${pixels[0].mode} click at ${pixels[0].x},${pixels[0].y} (element there: "${pixels[0].hit}") → rows ${pixels[0].rowsBefore}→${pixels[0].rows} in ${pixels[0].waited} ms, marker painted at ${one.preview.waypoints[0]?.x},${one.preview.waypoints[0]?.y}, ${pixelDistance(one.preview.waypoints[0], pixels[0])} px away, view panned ${pixels[0].panPx} px and the frame moved ${pixels[0].framePx} px, list row "${one.rows[0]?.name}"`
    );
    record(
      "routes: the map clicks the harness sent stayed clicks on a map that held still",
      pixels.every((click) => click.dragMoves === 0 && click.panPx === 0 && click.framePx === 0 && !click.retryAt) && pointerRepairs === 0,
      `${pixels.length} map click(s) so far: ${pixels.map((click) => `${click.dragMoves} move(s) with a button held, ${click.panPx} px view pan, ${click.framePx} px layout shift${click.retryAt ? `, retried at ${click.retryAt}` : ""}`).join(" · ")}, ${pointerRepairs} repaired pointer state(s)`
    );
    record(
      "routes: a single waypoint is refused as a route — no line, no Play, and it says why",
      one.playDisabled === true &&
        one.state === "NO ROUTE" &&
        one.preview.canvases === 0 &&
        /one waypoint is a position/i.test(one.note),
      `vector canvases ${one.preview.canvases}, painted px ${one.preview.painted}, Play disabled=${one.playDisabled}, state "${one.state}", note "${one.note}"`
    );

    for (const [fx, fy] of [[0.52, 0.4], [0.74, 0.62]]) {
      pixels.push(await clickMap("preview-map", fx, fy));
    }
    // The metric strip is refreshed through the bridge with a 180 ms debounce, so the
    // numbers are read once that round trip has had time to land.
    await wait(900);
    const three = await routeSnapshot();
    const clicksLanded = three.clicks - clicksBefore;
    record(
      "routes: three clicks become three waypoints, numbered in the order they were placed",
      three.count === "3 WAYPOINTS" &&
        three.rows.length === 3 &&
        three.preview.waypoints.length === 3 &&
        three.preview.waypoints.map((pin) => pin.n).join(",") === "1,2,3" &&
        three.rows.map((row) => row.number).join(",") === "1,2,3" &&
        clicksLanded === 3,
      `${clicksLanded} DOM click event(s) behind 3 map clicks; markers ${three.preview.waypoints.map((pin) => `${pin.n}@${pin.x},${pin.y}`).join(" ")}; per click ${pixels.map((click) => `${click.rowsBefore}→${click.rows} rows, ${click.dragMoves} button-held move(s), ${click.panPx} px pan, ${click.framePx} px layout${click.retryAt ? `, retry at ${click.retryAt}` : ""}`).join(" | ")}`
    );
    record(
      "routes: every numbered marker is painted at the pixel that was clicked",
      three.preview.waypoints.every((pin, index) => pixelDistance(pin, pixels[index]) <= 6),
      `${gestureMode()}: ` +
        three.preview.waypoints.map((pin, index) => `wp${pin.n} ${pixelDistance(pin, pixels[index])}px from click`).join(", ")
    );
    record(
      "routes: two or more waypoints draw one real polyline where the previous build drew a decorative diamond",
      three.preview.canvases === 1 && three.preview.painted > 40,
      `preview map vector canvas ${three.preview.canvases} with ${three.preview.painted} painted px; markers ${three.preview.waypoints.length}`
    );
    record(
      "routes: the list coordinates are the geometry the bridge measures",
      three.rows.every((row) => /^-?\d+\.\d{6}, -?\d+\.\d{6}$/.test(row.name)) &&
        three.timeline.length === 3 &&
        three.timeline.every((row, index) => row.startsWith(`0${index + 1} · `) && row.includes(three.rows[index].name)) &&
        three.duration !== "00:00" &&
        Number(three.updates) > 3,
      `points ${three.rows.map((row) => row.name).join(" → ")} · distance "${three.distance}" · duration "${three.duration}" · updates ${three.updates} · timeline "${three.timelineCount}"`
    );
    const parsedRoute = three.rows
      .filter((row) => /^-?\d+\.\d+/.test(row.name ?? ""))
      .map((row) => {
        const [lat, lon] = row.name.split(",").map((part) => Number(part.trim()));
        return { lat, lon };
      });
    const analysed = await inRenderer(`window.locationStudio.analyzeRoute({
      points: ${JSON.stringify(parsedRoute)},
      options: { speedMps: ${Number(three.speedInput)}, updateRateHz: ${Number(three.rateInput)}, interpolate: true, loop: false }
    })`);
    record(
      "routes: the bridge measures the same length for the waypoints the editor shows",
      analysed.ok === true && parsedRoute.length === 3 &&
        analysed.data.routeLengthM > 20 &&
        analysed.data.estimatedDurationSeconds > 0 &&
        analysed.data.playbackPointCount > 3 &&
        analysed.data.routeLengthM < 20000,
      `bridge: ${analysed.data?.routeLengthM} m in ${analysed.data?.estimatedDurationSeconds} s over ${analysed.data?.playbackPointCount} playback points; UI strip: "${three.distance}" / "${three.duration}" / ${three.updates}`
    );

    const pin2 = three.preview.waypoints.find((pin) => pin.n === "2") || null;
    await settleMap("preview-map");
    const drop = await mapPixel("preview-map", 0.6, 0.88);
    let dragMechanism;
    if (!pin2) {
      dragMechanism = "no drag: marker 2 was not painted to grab";
    } else if (inputLands) {
      dragMechanism = dragLabel(await realDrag(pin2, drop));
    } else {
      await syntheticDragPin("preview-map", 2, pin2, drop);
      dragMechanism = "dispatched DOM drag";
    }
    await wait(250);
    const dragged = await routeSnapshot();
    const movedPin = dragged.preview.waypoints.find((pin) => pin.n === "2");
    record(
      "routes: dragging a marker rewrites its coordinates, the line, the list and the metrics together",
      dragged.count === "3 WAYPOINTS" &&
        dragged.preview.waypoints.length === 3 &&
        dragged.rows[1]?.name !== three.rows[1]?.name &&
        dragged.rows[0]?.name === three.rows[0]?.name &&
        dragged.rows[2]?.name === three.rows[2]?.name &&
        pixelDistance(movedPin, drop) <= 10 &&
        dragged.distance !== three.distance &&
        /waypoint 2 moved/i.test(dragged.status),
      `${dragMechanism} ${pin2 ? `${pin2.x},${pin2.y}` : "(absent)"} → ${drop ? `${drop.x},${drop.y}` : "(off screen)"} (element there: "${drop?.hit}"): row 2 "${three.rows[1]?.name}" → "${dragged.rows[1]?.name}", marker now ${pixelDistance(movedPin, drop)} px from the drop point, distance "${three.distance}" → "${dragged.distance}", hint "${dragged.status}"`
    );

    const rowBox = await boxOfNode("#waypoint-list .list-row:nth-child(3) .grow");
    const selectMechanism = rowBox ? await realClick(rowBox.x, rowBox.y) : noteAbsent("#waypoint-list .list-row:nth-child(3) .grow");
    const rings = await inRenderer(`(() => {
      const pins = [...document.querySelectorAll("#preview-map .pin-waypoint")].map((node) => {
        const b = node.getBoundingClientRect();
        const cs = getComputedStyle(node);
        return {
          n: node.querySelector("span").textContent.trim(),
          selected: node.classList.contains("selected"),
          border: cs.borderTopColor,
          shadow: cs.boxShadow,
          w: Math.round(b.width),
          h: Math.round(b.height),
        };
      });
      return { pins, rows: [...document.querySelectorAll("#waypoint-list .list-row")].map((row) => row.classList.contains("selected")) };
    })()`);
    const chosen = rings.pins.find((pin) => pin.selected);
    const plain = rings.pins.filter((pin) => !pin.selected);
    record(
      "routes: clicking a list row selects that waypoint and only its marker changes",
      rings.rows.filter(Boolean).length === 1 &&
        rings.rows[2] === true &&
        chosen?.n === "3" &&
        plain.length === 2 &&
        plain.every((pin) => pin.border !== chosen.border),
      `${selectMechanism} click on row 3: row selection [${rings.rows.join(",")}], marker 3 border ${chosen?.border} vs ${plain.map((pin) => pin.border).join(" / ")}`
    );
    record(
      "routes: the selected marker is distinct without an oversized effect",
      Boolean(chosen) && chosen.w === plain[0]?.w && chosen.h === plain[0]?.h && chosen.w >= 20 && chosen.shadow !== "none",
      `selected ${chosen?.w}×${chosen?.h} px vs unselected ${plain.map((pin) => `${pin.w}×${pin.h}`).join(", ")} px; ring "${chosen?.shadow}"`
    );

    const beforeFocus = await routeSnapshot();
    const focusMechanism = await clickNode("preview-focus-selected");
    await wait(600);
    const focused = await routeSnapshot();
    const frameCentre = { x: focused.preview.left + Math.round(focused.preview.w / 2), y: focused.preview.top + Math.round(focused.preview.h / 2) };
    const pin3BeforeFocus = beforeFocus.preview.waypoints.find((pin) => pin.n === "3");
    const pin3AfterFocus = focused.preview.waypoints.find((pin) => pin.n === "3");
    record(
      "routes: ⊙ recentres the map on the selected marker",
      pixelDistance(pin3AfterFocus, frameCentre) < pixelDistance(pin3BeforeFocus, frameCentre) &&
        pixelDistance(pin3AfterFocus, frameCentre) <= 12,
      `${focusMechanism} click: marker 3 was ${pixelDistance(pin3BeforeFocus, frameCentre)} px from the frame centre (${pin3BeforeFocus?.x},${pin3BeforeFocus?.y}) and is now ${pixelDistance(pin3AfterFocus, frameCentre)} px (${pin3AfterFocus?.x},${pin3AfterFocus?.y})`
    );

    const beforeReorder = focused;
    const reorderMechanism = await clickNodeAt('#waypoint-list .list-row:nth-child(1) [title="Move later"]');
    const reordered = await routeSnapshot();
    record(
      "routes: a reorder swaps the waypoints in the list, on the markers and in the timeline",
      reordered.rows.length === 3 &&
        beforeReorder.rows.length === 3 &&
        reordered.rows[0].name === beforeReorder.rows[1].name &&
        reordered.rows[1].name === beforeReorder.rows[0].name &&
        reordered.rows[2].name === beforeReorder.rows[2].name &&
        pixelDistance(reordered.preview.waypoints[0], beforeReorder.preview.waypoints[1]) <= 4 &&
        pixelDistance(reordered.preview.waypoints[1], beforeReorder.preview.waypoints[0]) <= 4 &&
        reordered.preview.waypoints.map((pin) => pin.n).join(",") === "1,2,3" &&
        reordered.timeline[0].includes(reordered.rows[0].name) &&
        reordered.rows[1].selected === true,
      `${reorderMechanism} click on row 1's "Move later": list order ${beforeReorder.rows.map((row) => row.number).join(",")} kept, coordinates "${beforeReorder.rows[0]?.name}" ↔ "${beforeReorder.rows[1]?.name}", timeline row 1 "${reordered.timeline[0]}"`
    );

    const removeMechanism = await clickNodeAt('#waypoint-list .list-row:nth-child(3) [title="Remove this waypoint"]');
    const trimmed = await routeSnapshot();
    record(
      "routes: removing one waypoint leaves the survivors in route order and renumbers them",
      trimmed.count === "2 WAYPOINTS" &&
        trimmed.rows.length === 2 &&
        trimmed.rows.map((row) => row.number).join(",") === "1,2" &&
        trimmed.rows[0].name === reordered.rows[0]?.name &&
        trimmed.rows[1].name === reordered.rows[1]?.name &&
        trimmed.preview.waypoints.length === 2 &&
        trimmed.preview.canvases === 1,
      `${removeMechanism} click on row 3's ✕: "${reordered.rows[2]?.name}" gone, ${trimmed.rows.length} rows, markers ${trimmed.preview.waypoints.map((pin) => pin.n).join(",")}, hint "${trimmed.status}"`
    );

    const addMechanism = await clickNode("btn-add-waypoint");
    const appended = await routeSnapshot();
    record(
      "routes: “+ Add target pin” appends the destination without a map click",
      appended.count === "3 WAYPOINTS" &&
        appended.rows.length === 3 &&
        appended.rows[2].name === `${appended.lat}, ${appended.lon}` &&
        !appended.rows.slice(0, 2).some((row) => row.name === appended.rows[2].name) &&
        appended.preview.waypoints.length === 3,
      `${addMechanism} click: row 3 became "${appended.rows[2]?.name}" while the target inputs read ${appended.lat} / ${appended.lon}`
    );

    // ------------------------------------------------------------- preview run
    // The preview animates at whatever speed the panel holds; 8 m/s over a city block is
    // a sub-pixel move per frame, so the animation is observed at the top of the range.
    // The gesture under test stays the Play / Pause / Reset clicks.
    await inRenderer(`(() => {
      const input = document.getElementById("input-speed");
      input.value = "400";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await wait(400);
    const fitMechanism = await clickNode("preview-fit-route");
    await wait(600);
    const beforePlay = await routeSnapshot();
    const span = (snapshot) => {
      const xs = snapshot.preview.waypoints.map((pin) => pin.x);
      return Math.round(Math.max(...xs) - Math.min(...xs));
    };
    const playMechanism = await clickNode("btn-preview-play");
    await wait(900);
    const playing = await routeSnapshot();
    record(
      "routes: ⤢ fits the route so it occupies the frame instead of a corner",
      span(beforePlay) > beforePlay.preview.w * 0.35,
      `${fitMechanism} click: the three markers now span ${span(beforePlay)} px of a ${beforePlay.preview.w} px frame`
    );
    const playChecks = {
      "Play was enabled before pressing": beforePlay.playDisabled === false,
      "state reads PREVIEW RUNNING": playing.state === "PREVIEW RUNNING",
      "button reads ▶ Running": playing.playText === "▶ Running",
      "Play locks while running": playing.playDisabled === true,
      "Pause unlocks": playing.pauseDisabled === false,
      "Reset unlocks": playing.resetDisabled === false,
      "progress left 0%": playing.progress !== "0%",
      "the preview marker moved at least 3 px": pixelDistance(playing.preview.previewPin, beforePlay.preview.previewPin) >= 3,
    };
    record(
      "routes: Play animates the real route, not a generated shape",
      Object.values(playChecks).every(Boolean),
      `${playMechanism} at 400 m/s — unmet: ${Object.entries(playChecks).filter(([, ok]) => !ok).map(([label]) => label).join(", ") || "none"}. state "${playing.state}", button "${playing.playText}", pause "${playing.pauseText}" disabled=${playing.pauseDisabled}, reset disabled=${playing.resetDisabled}, progress "${playing.progress}", next "${playing.next}", marker ${beforePlay.preview.previewPin?.x},${beforePlay.preview.previewPin?.y} → ${playing.preview.previewPin?.x},${playing.preview.previewPin?.y}`
    );
    const pauseMechanism = await clickNode("btn-preview-pause");
    const paused1 = await routeSnapshot();
    await wait(500);
    const paused2 = await routeSnapshot();
    record(
      "routes: Pause freezes the preview and hands Play back as Continue",
      paused1.state === "PREVIEW PAUSED" &&
        paused1.playText === "▶ Continue" &&
        paused1.playDisabled === false &&
        paused1.pauseText === "▶ Continue" &&
        paused1.progress === paused2.progress &&
        pixelDistance(paused1.preview.previewPin, paused2.preview.previewPin) === 0,
      `${pauseMechanism} click: "${paused1.state}", Play "${paused1.playText}" disabled=${paused1.playDisabled}, progress held at "${paused1.progress}" over 500 ms, marker moved ${pixelDistance(paused1.preview.previewPin, paused2.preview.previewPin)} px`
    );
    await clickNode("btn-preview-pause");
    const resumed = await routeSnapshot();
    record("routes: Continue resumes the same preview run", resumed.state === "PREVIEW RUNNING" && resumed.progress === paused2.progress, `"${resumed.state}" at "${resumed.progress}"`);
    await clickNode("btn-preview-reset");
    const resetBack = await routeSnapshot();
    record(
      "routes: Reset rewinds the preview to the first waypoint and re-enables Play",
      resetBack.progress === "0%" &&
        ["IDLE", "NO ROUTE"].includes(resetBack.state) &&
        resetBack.playDisabled === false &&
        resetBack.playText === "▶ Play" &&
        resetBack.resetDisabled === true,
      `"${resetBack.state}" at "${resetBack.progress}", button "${resetBack.playText}", preview marker back at ${resetBack.preview.previewPin?.x},${resetBack.preview.previewPin?.y}`
    );

    // ------------------------------------------------- the editing surface too
    await inRenderer(`document.querySelector('.nav-item[data-view="map"]').click()`);
    await wait(400);
    // The waypoints were placed on the preview map, which has its own view. Fit the
    // Location map first — that is what ⤢ is for — before claiming a marker is on screen.
    const studioFitMechanism = await clickNode("map-fit-route");
    await wait(700);
    const studioStage = await routeSnapshot();
    record(
      "routes: the Location map renders the same numbered waypoints in the same order",
      studioStage.count === "3 WAYPOINTS" &&
        studioStage.studio.waypoints.length === 3 &&
        studioStage.studio.waypoints.map((pin) => pin.n).join(",") === "1,2,3" &&
        studioStage.studio.waypoints.every((pin) => pin.inside === true) &&
        studioStage.studio.canvases === 1 &&
        studioStage.studio.painted > 40,
      `${studioFitMechanism} on ⤢: markers ${studioStage.studio.waypoints.map((pin) => `${pin.n}@${pin.x},${pin.y}`).join(" ")} in a ${studioStage.studio.w}×${studioStage.studio.h} frame at left ${studioStage.studio.left}, ${studioStage.studio.painted} painted px of route`
    );
    const studioPin2 = studioStage.studio.waypoints.find((pin) => pin.n === "2") || null;
    await settleMap("map");
    const studioDrop = await mapPixel("map", 0.45, 0.32);
    let studioDragMechanism;
    if (!studioPin2) {
      studioDragMechanism = "no drag: marker 2 was not painted on the Location map";
    } else if (inputLands) {
      studioDragMechanism = dragLabel(await realDrag(studioPin2, studioDrop));
    } else {
      await syntheticDragPin("map", 2, studioPin2, studioDrop);
      studioDragMechanism = "dispatched DOM drag";
    }
    await wait(250);
    const studioDragged = await routeSnapshot();
    record(
      "routes: dragging works on the editing map as well and the two maps stay in step",
      studioDragged.rows.length === 3 &&
        studioDragged.rows[1].name !== studioStage.rows[1]?.name &&
        studioDragged.count === "3 WAYPOINTS" &&
        studioDragged.preview.waypoints.length === 3 &&
        /waypoint 2 moved/i.test(studioDragged.status),
      `${studioDragMechanism} on the Location map: row 2 "${studioStage.rows[1]?.name}" → "${studioDragged.rows[1]?.name}", preview map still shows ${studioDragged.preview.waypoints.length} markers`
    );

    // A handler that was re-registered on every workspace visit would append several
    // waypoints from one click. Visiting all five workspaces first makes that visible.
    for (const view of ["overview", "map", "motion", "device", "settings", "map"]) {
      await inRenderer(`document.querySelector('.nav-item[data-view="${view}"]').click()`);
      await wait(120);
    }
    const clicksBeforeSweep = await inRenderer("window.__clicks");
    const studioPixel = await clickMap("map", 0.4, 0.55);
    const afterSweep = await routeSnapshot();
    record(
      "routes: after visiting every workspace, one map click still adds exactly one waypoint",
      afterSweep.count === "4 WAYPOINTS" &&
        afterSweep.rows.length === 4 &&
        afterSweep.preview.waypoints.length === 4 &&
        afterSweep.studio.waypoints.length === 4 &&
        afterSweep.containers === 2 &&
        afterSweep.clicks - clicksBeforeSweep === 1,
      `${studioPixel.mode} click at ${studioPixel.x},${studioPixel.y} (hit "${studioPixel.hit}", ${studioPixel.dragMoves} button-held move(s), ${studioPixel.panPx} px pan, ${studioPixel.framePx} px layout${studioPixel.retryAt ? `, retry at ${studioPixel.retryAt}` : ""}) after 6 workspace switches: "${studioDragged.count}" → "${afterSweep.count}", ${afterSweep.clicks - clicksBeforeSweep} click event, ${afterSweep.containers} map containers`
    );

    // ---------------------------------------------------- naming a saved route
    // Saving asks for a name through the same modal machinery, so this is the second
    // half of the proof that a dialog answer reaches the code that waits for it.
    // The control lives in the Routes dock, so the workspace is switched to first.
    await inRenderer(`document.querySelector('.nav-item[data-view="motion"]').click()`);
    await wait(250);
    const savedBefore = await inRenderer("document.getElementById('routes-count').textContent.trim()");
    const saveMechanism = await clickNode("btn-save-route");
    const prompting = await inRenderer(`(() => {
      const input = document.querySelector("#modal-body input[type=text]");
      return { open: !document.getElementById("modal").hidden, title: document.getElementById("modal-title").textContent.trim(), hasInput: Boolean(input), value: input ? input.value : null };
    })()`);
    await inRenderer(`(() => { const input = document.querySelector("#modal-body input[type=text]"); if (input) { input.focus(); input.select(); } })()`);
    // Measured against Electron 35.7.5: `sendInputEvent` rejects every `char` object as
    // "Invalid event object" and a keyDown/rawKeyDown pair inserts nothing into a focused
    // field, so no synthetic keystroke is available to this harness. The name is therefore
    // written into the field directly; what is still proven with a real trusted click is
    // the part that matters — that the answer leaves the dialog and reaches the code
    // waiting on it.
    let typeMechanism = "typed through synthetic char events";
    try {
      for (const ch of "Harbour sweep") {
        window.webContents.sendInputEvent({ type: "char", text: ch });
        await wait(12);
      }
      const untouched = await inRenderer(`(() => { const input = document.querySelector("#modal-body input[type=text]"); return input ? input.value : ""; })()`);
      if (!untouched) throw new Error("char events produced no text");
    } catch (error) {
      typeMechanism = `name written into the field (${String(error.message).split("\n")[0]} — Electron gives this harness no text event)`;
      await inRenderer(`(() => { const input = document.querySelector("#modal-body input[type=text]"); if (input) { input.value = "Harbour sweep"; input.dispatchEvent(new Event("input", { bubbles: true })); } })()`);
    }
    await wait(120);
    const typed = await inRenderer(`(() => { const input = document.querySelector("#modal-body input[type=text]"); return input ? input.value : null; })()`);
    const saveConfirmMechanism = await clickNodeAt("#modal-body .btn-row.end button.primary");
    await wait(400);
    const saved = await inRenderer(`(() => ({
      count: document.getElementById("routes-count").textContent.trim(),
      rows: [...document.querySelectorAll("#saved-routes .list-row")].map((row) => row.textContent.replace(/\\s+/g, " ").trim().slice(0, 70)),
      modal: !document.getElementById("modal").hidden,
    }))()`);
    record(
      "routes: typing a name into the Save dialog and pressing Save route stores the real waypoints",
      prompting.open === true &&
        prompting.title === "Save route" &&
        prompting.hasInput === true &&
        typed === "Harbour sweep" &&
        saved.modal === false &&
        saved.count === String(Number(savedBefore) + 1) &&
        saved.rows.some((row) => row.includes("Harbour sweep")),
      `${saveMechanism} on #btn-save-route opened "${prompting.title}" prefilled "${prompting.value}", ${typeMechanism} left "${typed}", then ${saveConfirmMechanism}: routes-count ${savedBefore}→${saved.count}, row "${saved.rows.find((row) => row.includes("Harbour sweep")) || "not found"}"`
    );
    const deleteMechanism = await clickNodeAt("#saved-routes .list-row .btn.danger");
    const deleteAsking = await inRenderer("document.getElementById('modal').hidden === false");
    const deleteConfirm = await clickNodeAt("#modal-body .btn-row.end button.danger");
    await wait(400);
    const afterDelete = await inRenderer(`(() => ({
      count: document.getElementById("routes-count").textContent.trim(),
      rows: document.querySelectorAll("#saved-routes .list-row").length,
      empty: document.querySelector("#saved-routes .empty")?.textContent.trim() ?? null,
    }))()`);
    record(
      "routes: deleting the saved route asks first and only removes it after the answer arrives",
      deleteAsking === true &&
        afterDelete.count === savedBefore &&
        afterDelete.rows === Number(savedBefore) &&
        (Number(savedBefore) > 0 || /no saved routes yet/i.test(afterDelete.empty || "")),
      `${deleteMechanism} on the row's ✕ left the dialog open=${deleteAsking}, then ${deleteConfirm} took routes-count ${saved.count}→${afterDelete.count} with ${afterDelete.rows} row(s) reading "${afterDelete.empty}"`
    );

    // Back to the editing map for the mode checks that follow.
    await inRenderer(`document.querySelector('.nav-item[data-view="map"]').click()`);
    await wait(250);
    const offMechanism = await clickNode("btn-edit-route-map");
    const editOff = await routeSnapshot();
    record(
      "routes: turning Edit Route off puts the click back to the target pin",
      editOff.pressedMap === "false" &&
        editOff.pressedPreview === "false" &&
        editOff.toggleChecked === false &&
        editOff.studio.editingClass === false &&
        editOff.studio.cursor !== "crosshair" &&
        /moves the target pin/i.test(editOff.mapHint) &&
        /editing is off/i.test(editOff.help),
      `${offMechanism} click on #btn-edit-route-map: aria-pressed ${editOff.pressedMap}, cursor "${editOff.studio.cursor}", chip "${editOff.mapHint}"`
    );
    const targetBefore = { lat: editOff.lat, lon: editOff.lon };
    const panPixel = await clickMap("map", 0.62, 0.7);
    const afterPan = await routeSnapshot();
    record(
      "routes: with editing off a map click moves the target pin and adds no waypoint",
      afterPan.count === "4 WAYPOINTS" &&
        afterPan.studio.waypoints.length === 4 &&
        panPixel.rows === panPixel.rowsBefore &&
        (afterPan.lat !== targetBefore.lat || afterPan.lon !== targetBefore.lon),
      `${panPixel.mode} click at ${panPixel.x},${panPixel.y}: waypoints stayed ${afterPan.count} (rows ${panPixel.rowsBefore}→${panPixel.rows} after ${panPixel.waited} ms), target readout ${targetBefore.lat}, ${targetBefore.lon} → ${afterPan.lat}, ${afterPan.lon}`
    );

    // ------------------------------------------------------------- clear + honesty
    await inRenderer(`document.querySelector('.nav-item[data-view="motion"]').click()`);
    const clearMechanism = await clickNode("btn-clear-route");
    const asking = await routeSnapshot();
    const confirmLabel = asking.modalButtons[asking.modalButtons.length - 1] || null;
    record(
      "routes: clearing the whole route asks for confirmation before it destroys anything",
      asking.modalOpen === true &&
        /clear route/i.test(asking.modalTitle || "") &&
        asking.modalButtons.includes("Cancel") &&
        confirmLabel === "Clear route" &&
        asking.count === "4 WAYPOINTS",
      `${clearMechanism} on Clear opened "${asking.modalTitle}" offering [${asking.modalButtons.join(" | ")}] with the route still at ${asking.count}`
    );
    // Where does the confirmation click actually go? Capture-phase listeners record every
    // pointer event that reaches the document while the dialog is open: the node it landed
    // on, its text, and whether Chromium considered it real input.
    await inRenderer(`(() => {
      window.__modalEvents = [];
      const note = (event) => window.__modalEvents.push({
        type: event.type,
        trusted: event.isTrusted,
        x: event.clientX,
        y: event.clientY,
        node: event.target === document.getElementById('modal') ? 'backdrop' : String(event.target.className || event.target.tagName).split(' ')[0],
        text: (event.target.textContent || '').trim().slice(0, 18)
      });
      for (const type of ['mousedown', 'mouseup', 'click']) document.addEventListener(type, note, true);
    })()`);
    let confirmNode = null;
    let confirmProbe = "";
    try {
      confirmNode = await inRenderer(`(() => {
        const buttons = [...document.querySelectorAll("#modal-body .btn-row.end button")];
        const target = buttons.find((node) => node.classList.contains("danger")) || buttons[buttons.length - 1];
        if (!target) return null;
        const r = target.getBoundingClientRect();
        const over = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        return {
          text: target.textContent.trim(),
          cls: String(target.className),
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          owner: over === target ? "the button itself" : over ? String(over.className || over.tagName) : "nothing",
        };
      })()`);
    } catch (error) {
      confirmProbe = String(error.message).split("\n")[0];
    }
    let confirmed;
    if (confirmNode) {
      let owner = confirmNode.owner;
      let waited = 0;
      while (owner !== "the button itself" && waited < 9_000) {
        await wait(250);
        waited += 250;
        try {
          owner = await inRenderer(`(() => {
            const target = [...document.querySelectorAll("#modal-body .btn-row.end button")].find((node) => node.classList.contains("danger"));
            if (!target) return "gone";
            const r = target.getBoundingClientRect();
            const over = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
            return over === target ? "the button itself" : over ? String(over.className || over.tagName) : "nothing";
          })()`);
        } catch (error) {
          confirmProbe = String(error.message).split("\n")[0];
          break;
        }
      }
      confirmed = `${await realClick(confirmNode.x, confirmNode.y)} click${waited ? ` (waited ${waited} ms for ${owner} to clear)` : ""} on "${confirmNode.text}"`;
    } else {
      // The measuring probe itself failed, so fall back to the ordinary control path
      // rather than reporting a control that is not there.
      confirmed = `${confirmProbe ? `probe failed (${confirmProbe}), then ` : ""}${await clickNodeAt("#modal-body .btn-row.end button.danger")}`;
    }
    // Leaflet clears the vector canvas on the next animation frame after the last path
    // is removed, so the "nothing is drawn" claim is read one frame later.
    await wait(300);
    let cleared = await routeSnapshot();
    // If the real press dismissed the dialog without clearing, find out whether the app
    // ignored the confirmation or the input event did. The second attempt dispatches the
    // click on the node itself, so the two possibilities separate instead of guessing.
    let fallback = "";
    if (cleared.count !== "0 WAYPOINTS") {
      const stuck = cleared.count;
      const reopened = await clickNode("btn-clear-route");
      let pressed = "";
      try {
        pressed = await inRenderer(`(() => {
          const target = [...document.querySelectorAll("#modal-body .btn-row.end button")].find((node) => node.classList.contains("danger"));
          if (!target) return "no danger button in the modal";
          target.click();
          return 'dispatched click on "' + target.textContent.trim() + '"';
        })()`);
      } catch (error) {
        pressed = "probe failed: " + String(error.message).split("\n")[0];
      }
      await wait(600);
      cleared = await routeSnapshot();
      fallback = ` — the real press left ${stuck} on the board; retry (${reopened}, ${pressed}) read ${cleared.count}, modal=${cleared.modalOpen ? "open" : "closed"}`;
    }
    const modalEvents = await inRenderer("window.__modalEvents");
    record(
      "routes: confirming the clear leaves an empty, non-playable, line-free editor",
      cleared.count === "0 WAYPOINTS" &&
        cleared.rows.length === 0 &&
        cleared.preview.waypoints.length === 0 &&
        cleared.preview.painted === 0 &&
        cleared.playDisabled === true &&
        cleared.state === "NO ROUTE" &&
        /^0/.test(cleared.distance) &&
        /no waypoints yet/i.test(cleared.note),
      `${confirmed}: pressed "${confirmNode?.text}" at ${confirmNode?.x},${confirmNode?.y} where the hit-test showed ${confirmNode?.owner}${confirmProbe ? ` (probe error: ${confirmProbe})` : ""}; events the document saw: ${(modalEvents || []).map((event) => `${event.type}${event.trusted ? "" : "(untrusted)"} on ${event.node} "${event.text}" @${event.x},${event.y}`).join(" | ") || "none"}; afterwards modal=${cleared.modalOpen ? `open as "${cleared.modalTitle}"` : "closed"}, markers ${cleared.preview.waypoints.length}, painted route px ${cleared.preview.painted}, distance "${cleared.distance}", state "${cleared.state}", list "${cleared.listEmpty}"${fallback}`
    );
    record(
      "routes: editing a full route never enabled a device action without a selected iPhone",
      asking.count === "4 WAYPOINTS" &&
        asking.sendRouteDisabled === true &&
        asking.sendPointDisabled === true &&
        /idle/i.test(asking.deviceTitle || "") &&
        cleared.sendRouteDisabled === true &&
        cleared.sendPointDisabled === true,
      `with ${asking.count} on the board: btn-send-route disabled=${asking.sendRouteDisabled}, btn-send-point disabled=${asking.sendPointDisabled}, banner "${asking.deviceTitle}" — ${asking.deviceSub}`
    );
    const sessionAfterEditing = await inRenderer("window.locationStudio.getSimulationStatus()");
    record(
      "device: route editing never opened a simulation session",
      sessionAfterEditing.ok === true && sessionAfterEditing.data?.session === null,
      `session=${JSON.stringify(sessionAfterEditing.data?.session)}, device-button state read from the dock`
    );
    record(
      "input: every control the route cycle asked for was on screen and the pointer stayed balanced",
      absentControls.length === 0 && pointerRepairs === 0,
      `${absentControls.length ? `missing: ${absentControls.join(", ")}` : "no absent controls"}; ${pointerRepairs} pointer state(s) repaired before a gesture`
    );

    // GPX export has to survive the redesign. It opens a native save dialog, so the
    // harness only proves the control is where the brief promises it and still enabled.
    const gpxControls = await inRenderer(`(() => {
      const ids = ["btn-import-gpx", "btn-export-gpx", "btn-save-route", "btn-clear-route"];
      return ids.map((id) => {
        const node = document.getElementById(id);
        const rect = node?.getBoundingClientRect();
        return { id, painted: Boolean(rect && rect.width > 20 && rect.height > 14), disabled: node?.disabled };
      });
    })()`);
    record(
      "routes: the route file controls are painted in the dock",
      gpxControls.every((entry) => entry.painted),
      gpxControls.map((entry) => `${entry.id}=${entry.disabled ? "disabled" : "enabled"}`).join(", ")
    );

    // The header strip is the always-visible claim, so re-read it after every probe
    // and scan this run performed: none of them opened a developer session.
    const stripAfterProbe = await inRenderer(`(() => ({
      state: document.getElementById("strip-state").textContent.trim(),
      transport: document.getElementById("strip-transport").textContent.trim(),
      tunnel: document.getElementById("strip-tunnel").textContent.trim(),
      model: document.getElementById("strip-model").textContent.trim(),
    }))()`);
    record(
      "header: no probe or scan is allowed to read as a connection",
      !/CONNECTED/i.test(stripAfterProbe.state) && !/OPEN/i.test(stripAfterProbe.tunnel),
      `state="${stripAfterProbe.state}" transport="${stripAfterProbe.transport}" tunnel="${stripAfterProbe.tunnel}" model="${stripAfterProbe.model}"`
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
      // The smallest size the redesign promises to support. Everything geometric below
      // is measured against this, so a layout that only works on a big screen fails.
      width: 1280,
      height: 720,
      // The route-editor checks drive real mouse input, and the preview animation runs
      // on requestAnimationFrame. A hidden window throttles animation frames away and
      // is not presented, so both would fail for reasons that have nothing to do with
      // the app. Same finding capture-ui.cjs measured (0% of the map painted hidden vs
      // 100% shown); pass --hidden to reproduce the old hidden behaviour.
      show: SHOW_WINDOW,
      webPreferences: {
        preload: path.join(PROJECT_ROOT, "electron", "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        // The preview animation is driven by requestAnimationFrame, which Chromium
        // stalls in a backgrounded page. Keep frames ticking so a check that says
        // "the marker moved" is measuring the app, not the throttling policy.
        backgroundThrottling: false,
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
