/**
 * Local persistence: a single versioned JSON document in the user-data directory.
 *
 * A JSON document store is used deliberately instead of SQLite: the dataset is a
 * handful of saved locations, routes and presets, the app must stay dependency
 * free for reproducible Windows builds, and writes are atomic. The API is kept
 * narrow so it can be swapped for SQLite later without touching callers.
 */

const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 500;

const EMPTY = {
  schemaVersion: SCHEMA_VERSION,
  locations: [],
  routes: [],
  settings: {
    lastDeviceId: null,
    routeSpeedMps: 8,
    updateRateHz: 5,
    mapCenter: { lat: 47.0105, lon: 28.8638, zoom: 12 },
    tileStyle: "dark",
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function sanitiseCoordinate(value) {
  if (!value || typeof value !== "object") return null;
  if (!isFiniteNumber(value.lat) || !isFiniteNumber(value.lon)) return null;
  if (value.lat < -90 || value.lat > 90 || value.lon < -180 || value.lon > 180) return null;
  const result = { lat: value.lat, lon: value.lon };
  if (isFiniteNumber(value.altitude) && Math.abs(value.altitude) <= 12000) result.altitude = value.altitude;
  return result;
}

function sanitiseText(value, limit = 120) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, limit);
}

function sanitiseEntry(raw, kind) {
  if (!raw || typeof raw !== "object") return null;
  const id = sanitiseText(raw.id, 64) || `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const name = sanitiseText(raw.name, 120) || (kind === "routes" ? "Untitled route" : "Untitled location");

  if (kind === "locations") {
    const coordinate = sanitiseCoordinate(raw.coordinate);
    if (!coordinate) return null;
    return { id, name, coordinate, note: sanitiseText(raw.note, 400), savedAt: isFiniteNumber(raw.savedAt) ? raw.savedAt : Date.now() };
  }

  if (!Array.isArray(raw.points)) return null;
  const points = raw.points.map(sanitiseCoordinate).filter(Boolean).slice(0, 20_000);
  if (points.length < 2) return null;
  const options = raw.options && typeof raw.options === "object" ? raw.options : {};
  return {
    id,
    name,
    points,
    options: {
      speedMps: isFiniteNumber(options.speedMps) ? Math.min(Math.max(options.speedMps, 0.1), 400) : 8,
      updateRateHz: isFiniteNumber(options.updateRateHz) ? Math.min(Math.max(options.updateRateHz, 0.5), 20) : 5,
      loop: Boolean(options.loop),
    },
    savedAt: isFiniteNumber(raw.savedAt) ? raw.savedAt : Date.now(),
  };
}

class WorkspaceStore {
  constructor(directory) {
    this.file = path.join(directory, "workspace.json");
    this.document = clone(EMPTY);
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      if (raw.length > MAX_DOCUMENT_BYTES) {
        throw new Error("workspace file exceeds the size limit");
      }
      const parsed = JSON.parse(raw);
      this.document = this._normalise(parsed);
    } catch (error) {
      if (error.code !== "ENOENT") {
        // A corrupt store must never block startup: keep a copy and start clean.
        try {
          fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          /* best effort */
        }
      }
      this.document = clone(EMPTY);
    }
    return clone(this.document);
  }

  _normalise(parsed) {
    const document = clone(EMPTY);
    if (!parsed || typeof parsed !== "object") return document;
    if (Array.isArray(parsed.locations)) {
      document.locations = parsed.locations.map((entry) => sanitiseEntry(entry, "locations")).filter(Boolean).slice(0, MAX_ENTRIES);
    }
    if (Array.isArray(parsed.routes)) {
      document.routes = parsed.routes.map((entry) => sanitiseEntry(entry, "routes")).filter(Boolean).slice(0, MAX_ENTRIES);
    }
    const settings = parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {};
    document.settings = {
      ...EMPTY.settings,
      ...settings,
      lastDeviceId: typeof settings.lastDeviceId === "string" ? settings.lastDeviceId.slice(0, 64) : null,
      routeSpeedMps: isFiniteNumber(settings.routeSpeedMps) ? settings.routeSpeedMps : EMPTY.settings.routeSpeedMps,
      updateRateHz: isFiniteNumber(settings.updateRateHz) ? settings.updateRateHz : EMPTY.settings.updateRateHz,
      mapCenter: sanitiseCoordinate(settings.mapCenter) || EMPTY.settings.mapCenter,
    };
    if (isFiniteNumber(settings.mapCenter?.zoom)) {
      document.settings.mapCenter.zoom = Math.min(Math.max(settings.mapCenter.zoom, 1), 19);
    }
    document.schemaVersion = SCHEMA_VERSION;
    return document;
  }

  save(payload) {
    const incoming = this._normalise(payload);
    const serialised = JSON.stringify(incoming, null, 2);
    if (serialised.length > MAX_DOCUMENT_BYTES) {
      throw new Error("Workspace data is too large to save.");
    }
    const temporary = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(temporary, serialised, "utf8");
    fs.renameSync(temporary, this.file); // atomic on the same volume
    this.document = incoming;
    return clone(this.document);
  }

  get filePath() {
    return this.file;
  }
}

module.exports = { WorkspaceStore, SCHEMA_VERSION, sanitiseCoordinate, sanitiseText };
