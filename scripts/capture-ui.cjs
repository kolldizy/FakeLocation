/**
 * Painted-output capture for the redesign.
 *
 *     node scripts/capture-ui.cjs            # 1280x720 and 1920x1080, all five views
 *     node scripts/capture-ui.cjs --sizes 1366x768
 *
 * `npm run check` proves the modules link and `smoke-app.cjs` proves the wiring, but
 * neither proves what the user sees. This harness opens the real stack at each target
 * window size, switches through the workspaces and writes one PNG per view plus a
 * geometry report: the primary action's bottom edge against the fold, the map's box,
 * whether the dock overlaps the main column, and whether anything overflows.
 *
 * The pictures and the numbers are meant to be read together. A layout that measures
 * well but paints badly is still broken.
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

const argValues = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const OUT_DIR = path.resolve(argValues("--out", path.join(PROJECT_ROOT, "tmp", "ui")));
const SIZES = argValues("--sizes", "1280x720,1366x768,1920x1080")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [width, height] = entry.split("x").map(Number);
    return { label: entry.replace(/x/i, "w-"), width, height };
  });
const VIEWS = ["overview", "map", "motion", "device", "settings"];

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "location-studio-capture-"));
app.setPath("userData", scratch);
app.disableHardwareAcceleration();
// A window that is never shown does not tick CSS animations, and Leaflet fades every
// tile in over 200 ms. A still captured from such a window shows a map whose tiles are
// decoded, positioned and painted at opacity 0 — which looks exactly like a broken
// basemap. Reduced motion is the app's own supported answer; pass --animations to
// capture the animated path instead.
if (!process.argv.includes("--animations")) app.commandLine.appendSwitch("force-prefers-reduced-motion");
// With `show: false` Chromium never presents the window, and images decoded after the
// last paint are not always rasterised into the captured frame: the DOM reports every
// tile loaded, visible and correctly placed while the PNG shows one tile on a sea of
// background. Measured: 0 % of the map frame painted from a hidden window, 100 % from a
// shown one, with identical DOM numbers. So the window is real unless --hidden is passed.
const SHOW_WINDOW = !process.argv.includes("--hidden");
protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES]);

const bridge = new BridgeClient({ projectRoot: PROJECT_ROOT, log: (level, message) => process.stderr.write(`${level}: ${message}\n`) });
const store = new WorkspaceStore(app.getPath("userData"));
let window = null;

const forward = (channel) => (payload) => {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
};
bridge.on("bridge-status", forward("bridge:status"));
bridge.on("bridge-log", forward("bridge:log"));
bridge.on("event", (payload) => forward("bridge:event")(payload));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 30_000, label }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await predicate()) return true;
    } catch (error) {
      process.stderr.write(`wait failed for ${label}: ${error.message}\n`);
      return false;
    }
    if (Date.now() > deadline) {
      process.stderr.write(`timed out waiting for ${label}\n`);
      return false;
    }
    await sleep(120);
  }
}

const measure = `(() => {
  const viewport = { w: window.innerWidth, h: window.innerHeight };
  const box = (id) => {
    const node = document.getElementById(id);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { top: Math.round(rect.top), left: Math.round(rect.left), bottom: Math.round(rect.bottom), right: Math.round(rect.right), w: Math.round(rect.width), h: Math.round(rect.height) };
  };
  const active = document.querySelector("section.view.active");
  const describe = (node) =>
    node.tagName.toLowerCase() + (node.id ? "#" + node.id : "." + String(node.className || "").split(" ")[0]);
  // Where the loaded tiles actually sit inside the map container. A map revealed from
  // a hidden container can keep a stale size: the frame is 720 px wide while the tile
  // grid covers a 350 px block, and only a screenshot or this box shows it.
  const tileBox = (id) => {
    const host = document.getElementById(id);
    if (!host) return null;
    const frame = host.getBoundingClientRect();
    const tiles = [...host.querySelectorAll("img.leaflet-tile")];
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity, loaded = 0;
    for (const tile of tiles) {
      const box = tile.getBoundingClientRect();
      if (tile.naturalWidth > 0) loaded += 1;
      left = Math.min(left, box.left);
      right = Math.max(right, box.right);
      top = Math.min(top, box.top);
      bottom = Math.max(bottom, box.bottom);
    }
    if (!tiles.length) return { frame: { w: Math.round(frame.width), h: Math.round(frame.height) }, tiles: 0, loaded: 0 };
    return {
      frame: { w: Math.round(frame.width), h: Math.round(frame.height) },
      tiles: tiles.length,
      loaded,
      // Where each tile actually sits, relative to the frame. A union box can look
      // healthy (a 1024×512 grid inside a 722×368 frame) while the whole grid is
      // translated off the visible corner — only the per-tile offsets show that.
      sample: tiles.slice(0, 10).map((tile) => {
        const box = tile.getBoundingClientRect();
        return {
          x: Math.round(box.left - frame.left),
          y: Math.round(box.top - frame.top),
          w: Math.round(box.width),
          h: Math.round(box.height),
          seen: box.right > frame.left && box.left < frame.right && box.bottom > frame.top && box.top < frame.bottom,
          ok: tile.naturalWidth > 0,
          opacity: getComputedStyle(tile).opacity,
          src: (tile.currentSrc || tile.src || "").slice(-26),
        };
      }),
      pane: (() => {
        const pane = host.querySelector(".leaflet-map-pane");
        const t = pane ? getComputedStyle(pane).transform : "none";
        return t === "none" ? "none" : t.replace(/^matrix3?d?\((.*)\)$/, "$1").split(",").slice(-2).map((n) => Math.round(parseFloat(n))).join(",");
      })(),
      grid: {
        left: Math.round(left - frame.left),
        right: Math.round(right - frame.left),
        top: Math.round(top - frame.top),
        bottom: Math.round(bottom - frame.top),
        w: Math.round(right - left),
        h: Math.round(bottom - top),
      },
    };
  };
  const overflowing = active
    ? [...active.querySelectorAll("*")]
        .filter((node) => node.getBoundingClientRect().right > window.innerWidth + 2 && !node.closest(".leaflet-pane"))
        .slice(0, 6)
        .map(describe)
    : [];
  const scrollers = active
    ? [...active.querySelectorAll("*")]
        .filter((node) => node.scrollHeight > node.clientHeight + 4 && getComputedStyle(node).overflowY !== "hidden")
        .slice(0, 8)
        .map((node) => describe(node) + "(" + node.scrollHeight + ">" + node.clientHeight + ")")
    : [];
  const topbar = document.querySelector(".topbar");
  // The sidebar brief is a list of numbers (icon size, row height, spacing, hierarchy)
  // and of two visual claims (the active row must stand out, the cards must not compete
  // with the nav). Both halves are measured here so the screenshots can be read against
  // them instead of against an opinion.
  const readRgb = (color, node) => {
    if (color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
    const parent = node.parentElement;
    return parent ? readRgb(getComputedStyle(parent).backgroundColor, parent) : "rgb(0, 0, 0)";
  };
  const channel = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : Math.pow((v / 255 + 0.055) / 1.055, 2.4));
  const luminance = (color) => {
    const m = String(color).match(/[\\d.]+/g);
    if (!m) return 0;
    const [r, g, b] = m.map(Number);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const contrast = (a, b) => {
    const x = luminance(a);
    const y = luminance(b);
    return Number(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2));
  };
  const rail = (() => {
    const railNode = document.querySelector(".rail");
    if (!railNode) return null;
    const railBox = railNode.getBoundingClientRect();
    const nav = [...document.querySelectorAll(".nav-item")].map((node) => {
      const r = node.getBoundingClientRect();
      const cs = getComputedStyle(node);
      const glyph = node.querySelector("svg") || node.querySelector(".glyph");
      const gb = glyph ? glyph.getBoundingClientRect() : null;
      const label = node.querySelector(".nav-label");
      const lcs = label ? getComputedStyle(label) : null;
      const bg = readRgb(cs.backgroundColor, node);
      return {
        view: node.dataset.view,
        active: node.classList.contains("active"),
        h: Math.round(r.height),
        w: Math.round(r.width),
        top: Math.round(r.top),
        glyphLeft: gb ? Math.round(gb.left - railBox.left) : null,
        glyph: gb ? Math.round(gb.width) + "x" + Math.round(gb.height) : null,
        strokeWidths: glyph && glyph.tagName === "svg" ? [...new Set([...glyph.querySelectorAll("[stroke-width]")].map((el) => el.getAttribute("stroke-width")))] : [],
        labelFont: lcs ? lcs.fontSize : null,
        labelWeight: lcs ? lcs.fontWeight : null,
        labelColor: lcs ? lcs.color : null,
        background: bg,
        labelContrast: lcs ? contrast(lcs.color, bg) : null,
        gap: cs.gap,
        padding: cs.padding,
        indicator: cs.boxShadow === "none" ? null : cs.boxShadow,
      };
    });
    const card = document.querySelector(".rail-card");
    const chip = document.querySelector(".rail-card .chip");
    const dot = document.querySelector(".rail-card .chip .dot");
    const brand = document.querySelector(".brand");
    return {
      w: Math.round(railBox.width),
      scrolls: railNode.scrollHeight > railNode.clientHeight + 4,
      scrollOverflow: railNode.scrollHeight - railNode.clientHeight,
      // The status cards at the foot of the rail may have to be scrolled on a short
      // window; the navigation itself must never need it, or a workspace goes missing.
      navFits: nav.length > 0 && nav[nav.length - 1].top + nav[nav.length - 1].h <= Math.round(railBox.bottom) - 4,
      lastNavBottom: nav.length ? nav[nav.length - 1].top + nav[nav.length - 1].h : null,
      railBottom: Math.round(railBox.bottom),
      clipped: railNode.scrollWidth > railNode.clientWidth + 1,
      brandH: brand ? Math.round(brand.getBoundingClientRect().height) : null,
      nav,
      rowGapPx: nav.length > 1 ? nav[1].top - (nav[0].top + nav[0].h) : null,
      cardTitle: card ? getComputedStyle(card.querySelector("h4")).fontSize : null,
      chipFont: chip ? getComputedStyle(chip).fontSize : null,
      chipH: chip ? Math.round(chip.getBoundingClientRect().height) : null,
      dotSize: dot ? Math.round(dot.getBoundingClientRect().width) : null,
      cardContrast: card ? contrast(getComputedStyle(card).color, readRgb(getComputedStyle(card).backgroundColor, card)) : null,
    };
  })();
  const tools = [...document.querySelectorAll(".map-tool")].map((node) => {
    const r = node.getBoundingClientRect();
    return { id: node.id, w: Math.round(r.width), h: Math.round(r.height), font: getComputedStyle(node).fontSize };
  });
  const titles = document.querySelector(".topbar-titles");
  const eyebrow = document.getElementById("view-eyebrow");
  const strip = document.getElementById("device-strip");
  const primaryPanel = document.getElementById("btn-console-start-point")?.closest(".panel");
  return {
    viewport,
    active: active?.id || null,
    title: document.getElementById("view-title").textContent,
    primary: box("btn-console-start-point"),
    stop: box("btn-console-stop"),
    previewPlay: box("btn-preview-play"),
    map: box("map"),
    previewMap: box("preview-map"),
    column: active?.querySelector(".main-col") ? (() => { const r = active.querySelector(".main-col").getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom) }; })() : null,
    dock: active?.querySelector(".dock") ? (() => { const r = active.querySelector(".dock").getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom) }; })() : null,
    dockScrolls: active?.querySelector(".dock") ? active.querySelector(".dock").scrollHeight > active.querySelector(".dock").clientHeight + 4 : false,
    strip: box("device-strip"),
    rail,
    tools,
    studioTiles: tileBox("map"),
    previewTiles: tileBox("preview-map"),
    header: {
      topbarH: topbar ? Math.round(topbar.getBoundingClientRect().height) : null,
      titlesH: titles ? Math.round(titles.getBoundingClientRect().height) : null,
      titlesOverflow: titles ? titles.scrollHeight > titles.clientHeight + 1 : null,
      eyebrowLines: eyebrow ? Math.round(eyebrow.getBoundingClientRect().height / parseFloat(getComputedStyle(eyebrow).lineHeight)) : null,
      stripClipped: strip ? strip.scrollWidth > strip.clientWidth + 1 : null,
      stripFree: topbar && strip ? Math.round(topbar.getBoundingClientRect().width - strip.getBoundingClientRect().width) : null,
    },
    primaryPanel: primaryPanel
      ? (() => {
          const r = primaryPanel.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), belowFold: Math.round(r.bottom - window.innerHeight) };
        })()
      : null,
    overflowing,
    scrollers,
    decodedTiles: [...document.querySelectorAll("img.leaflet-tile")].filter((img) => img.naturalWidth > 0).length,
  };
})()`;

async function capture(view) {
  await window.webContents.executeJavaScript(`document.querySelector('.nav-item[data-view="${view}"]').click()`, true);
  await sleep(view === "map" || view === "motion" ? 1200 : 250);
  const measurement = await window.webContents.executeJavaScript(measure, true);
  const image = await window.webContents.capturePage();
  const file = path.join(OUT_DIR, `${currentSize.label}--${view}.png`);
  fs.writeFileSync(file, image.toPNG());
  return { ...measurement, file, bytes: fs.statSync(file).size };
}

let currentSize = null;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  protocol.handle("app", createProtocolHandler({ rendererRoot: RENDERER_ROOT, isDevelopment: false, log: () => {} }));
  registerIpc({ ipcMain, bridge, store, getWindow: () => window });

  window = new BrowserWindow({
    width: SIZES[0].width,
    height: SIZES[0].height,
    show: SHOW_WINDOW,
    webPreferences: {
      preload: path.join(PROJECT_ROOT, "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  const loaded = new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
  await window.loadURL(`${APP_ORIGIN}/index.html`);
  await loaded;
  // main.cjs starts the bridge eagerly; mirror that so the first view is not
  // captured against a bridge that only woke up because the window asked.
  bridge.ensureStarted().catch(() => {});
  await waitFor(async () => (await window.webContents.executeJavaScript("window.locationStudio.getBridgeStatus()")).data?.state === "ready", {
    label: "bridge ready",
    timeoutMs: 90_000,
  });
  // Let the boot scan and the first basemap tiles settle before anything is measured.
  await sleep(2500);

  const report = { generatedAt: new Date().toISOString(), sizes: {} };

  for (const size of SIZES) {
    currentSize = size;
    window.setBounds({ width: size.width, height: size.height });
    await sleep(600);
    report.sizes[size.label] = {};
    for (const view of VIEWS) {
      const entry = await capture(view);
      report.sizes[size.label][view] = entry;
      const fold = entry.primary ? `primary bottom ${entry.primary.bottom}/${entry.viewport.h}` : "primary not on this view";
      const tiles = entry.studioTiles?.tiles ? `tiles ${entry.studioTiles.loaded}/${entry.studioTiles.tiles} in ${entry.studioTiles.grid?.w}×${entry.studioTiles.grid?.h} of ${entry.studioTiles.frame.w}×${entry.studioTiles.frame.h}` : "";
      process.stdout.write(
        `${size.label} ${view.padEnd(9)} ${entry.viewport.w}×${entry.viewport.h}  map ${entry.map?.w ?? "-"}×${entry.map?.h ?? "-"}  ${tiles}  ${fold}  panel ${
          entry.primaryPanel ? (entry.primaryPanel.belowFold > 0 ? `+${entry.primaryPanel.belowFold}px below fold` : "above fold") : "-"
        }  ${entry.bytes} bytes → ${path.basename(entry.file)}\n`
      );
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, "geometry.json"), JSON.stringify(report, null, 2), "utf8");
  process.stdout.write(`\n${Object.keys(SIZES).length ? SIZES.map((s) => s.label).join(", ") : ""} captured into ${OUT_DIR}\n`);

  try {
    await bridge.stop();
  } catch {
    /* the bridge is a child process; exiting takes it down anyway */
  }
  app.exit(0);
});
