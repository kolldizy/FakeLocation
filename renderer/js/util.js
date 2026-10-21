/** Formatting, DOM and geodesic helpers shared by every view. */

export const $ = (id) => document.getElementById(id);

export function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.html !== undefined) node.innerHTML = options.html;
  if (options.attrs) for (const [key, value] of Object.entries(options.attrs)) node.setAttribute(key, value);
  if (options.on) for (const [name, handler] of Object.entries(options.on)) node.addEventListener(name, handler);
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function fmtCoord(value, digits = 6) {
  return Number(value).toFixed(digits);
}

export function fmtCoordPair(lat, lon, digits = 6) {
  return `${fmtCoord(lat, digits)}, ${fmtCoord(lon, digits)}`;
}

export function fmtClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtDistance(metres) {
  if (!Number.isFinite(metres)) return "—";
  if (metres >= 1000) return `${(metres / 1000).toFixed(2)} km`;
  return `${metres.toFixed(0)} m`;
}

export function fmtTimestamp(value) {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], { hour12: false });
}

export function nowStamp() {
  const date = new Date();
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function parseCoordinate(text) {
  const value = Number(String(text).trim());
  return Number.isFinite(value) ? value : null;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function debounce(fn, delay = 250) {
  let handle = null;
  return (...args) => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => {
      handle = null;
      fn(...args);
    }, delay);
  };
}

/* --------------------------------------------------------------- geodesy */

const EARTH_RADIUS_M = 6371008.8;

export function haversineM(a, b) {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function cumulativeLengths(points) {
  const lengths = [0];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += haversineM(points[index - 1], points[index]);
    lengths.push(total);
  }
  return lengths;
}

export function routeLengthM(points) {
  return points.length ? cumulativeLengths(points)[points.length - 1] : 0;
}

export function densify(points, maxSegmentM = 5) {
  if (points.length < 2 || !(maxSegmentM > 0)) return points.map((point) => ({ ...point }));
  const result = [{ ...points[0] }];
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const distance = haversineM(start, end);
    const steps = distance > 0 ? Math.max(1, Math.ceil(distance / maxSegmentM)) : 1;
    for (let step = 1; step <= steps; step += 1) {
      const fraction = step / steps;
      result.push({
        lat: start.lat + (end.lat - start.lat) * fraction,
        lon: start.lon + (end.lon - start.lon) * fraction,
      });
    }
  }
  return result;
}

export function buildPlaybackPoints(points, options) {
  if (points.length < 2) return points.map((point) => ({ ...point }));
  if (options.interpolate === false) return points.map((point) => ({ ...point }));
  const speed = Number(options.speedMps) || 8;
  const rate = Number(options.updateRateHz) || 5;
  return densify(points, Math.max(1, speed / Math.max(rate, 0.001)));
}

export function waypointIndexAtDistance(points, distance) {
  const lengths = cumulativeLengths(points);
  for (let index = 0; index < lengths.length; index += 1) {
    if (lengths[index] > distance) return Math.max(0, index - 1);
  }
  return Math.max(0, points.length - 1);
}

/* -------------------------------------------------------- waypoint editing */

/**
 * The list operations a route editor has to get right, kept DOM-free so the order they
 * produce can be tested without a map. Each one returns a new array: the store and the
 * render signatures compare by value, and an in-place mutation would let a dragged or
 * reordered waypoint look unchanged to everything downstream.
 */
export function withWaypointMoved(route, index, lat, lon) {
  if (index < 0 || index >= route.length) return route;
  return route.map((point, position) => (position === index ? { ...point, lat, lon } : point));
}

export function withWaypointRemoved(route, index) {
  if (index < 0 || index >= route.length) return route;
  return route.filter((_, position) => position !== index);
}

/** Swap a waypoint with its neighbour; stepping off either end leaves the route alone. */
export function withWaypointReordered(route, index, direction) {
  const target = index + direction;
  if (target < 0 || target >= route.length) return route;
  const next = [...route];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/* ---------------------------------------------------------- validation */

export function validateLatitude(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Latitude must be a number.";
  if (value < -90 || value > 90) return "Latitude must be between -90 and 90.";
  return null;
}

export function validateLongitude(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Longitude must be a number.";
  if (value < -180 || value > 180) return "Longitude must be between -180 and 180.";
  return null;
}

export function validateAltitude(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return "Altitude must be a number.";
  if (Math.abs(number) > 12000) return "Altitude must be within ±12000 m.";
  return null;
}

/**
 * Merge the stage flags of two reports about the same device.
 *
 * `null`/`undefined` means "this report could not measure the stage", which must not
 * erase a value that was measured before (a cheap scan cannot see pairing). A fresh
 * `true`/`false` is a newer observation and wins over the older one.
 */
export function mergeStages(previous, fresh) {
  const merged = { ...(previous || {}) };
  for (const [key, value] of Object.entries(fresh || {})) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  return merged;
}
