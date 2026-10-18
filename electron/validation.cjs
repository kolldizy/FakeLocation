/**
 * Payload validation for every privileged renderer request.
 *
 * This module is deliberately free of any `electron` import so the rules can be
 * unit-tested with plain Node. It is the only place that decides what a renderer
 * is allowed to ask for; `ipc.cjs` never passes an unvalidated value to the
 * bridge.
 */

const MAX_GPX_READ_BYTES = 16 * 1024 * 1024;
const MAX_ROUTE_POINTS = 20_000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * A rejected renderer request.
 *
 * Carries the same `code` the bridge uses for bad input, so a renderer sees one
 * error vocabulary whether the request was refused here or by the device layer.
 */
class ValidationFailure extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ValidationFailure";
    this.code = "INVALID_PARAMS";
    if (details) this.details = details;
  }
}

function asString(value, name, { max = 200, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationFailure(`'${name}' is required.`);
    return null;
  }
  if (typeof value !== "string") throw new ValidationFailure(`'${name}' must be a string.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new ValidationFailure(`'${name}' must not be empty.`);
  if (trimmed.length > max) throw new ValidationFailure(`'${name}' must be at most ${max} characters.`);
  return trimmed;
}

function asNumber(value, name, { min, max, optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new ValidationFailure(`'${name}' is required.`);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationFailure(`'${name}' must be a finite number.`);
  }
  if (min !== undefined && value < min) throw new ValidationFailure(`'${name}' must be at least ${min}.`);
  if (max !== undefined && value > max) throw new ValidationFailure(`'${name}' must be at most ${max}.`);
  return value;
}

function asBoolean(value, name) {
  if (typeof value !== "boolean") throw new ValidationFailure(`'${name}' must be a boolean.`);
  return value;
}

/** A device identifier: the UDID form reported by usbmuxd, nothing else. */
const DEVICE_ID_PATTERN = /^[0-9A-Fa-f][0-9A-Fa-f-]{7,63}$/;

function validateDeviceId(params) {
  const deviceId = asString(params?.deviceId, "deviceId", { max: 64 });
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new ValidationFailure("'deviceId' does not look like a device identifier.");
  }
  return deviceId;
}

function validateCoordinate(value, name = "coordinate") {
  if (!isPlainObject(value)) throw new ValidationFailure(`'${name}' must be an object with lat and lon.`);
  const coordinate = {
    lat: asNumber(value.lat, `${name}.lat`, { min: -90, max: 90 }),
    lon: asNumber(value.lon, `${name}.lon`, { min: -180, max: 180 }),
  };
  const altitude = asNumber(value.altitude, `${name}.altitude`, { min: -12000, max: 12000, optional: true });
  if (altitude !== undefined) coordinate.altitude = altitude;
  return coordinate;
}

function validatePoints(value, { minimum = 1 } = {}) {
  if (!Array.isArray(value)) throw new ValidationFailure("'points' must be an array of coordinates.");
  if (value.length < minimum) throw new ValidationFailure(`'points' needs at least ${minimum} coordinate(s).`);
  if (value.length > MAX_ROUTE_POINTS) {
    throw new ValidationFailure(`'points' must not exceed ${MAX_ROUTE_POINTS} coordinates.`);
  }
  return value.map((point, index) => validateCoordinate(point, `points[${index}]`));
}

function validateOptions(value) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw new ValidationFailure("'options' must be an object.");
  const options = {};
  const speed = asNumber(value.speedMps, "options.speedMps", { min: 0.1, max: 400, optional: true });
  if (speed !== undefined) options.speedMps = speed;
  const rate = asNumber(value.updateRateHz, "options.updateRateHz", { min: 0.5, max: 20, optional: true });
  if (rate !== undefined) options.updateRateHz = rate;
  if (value.loop !== undefined) options.loop = asBoolean(value.loop, "options.loop");
  if (value.interpolate !== undefined) options.interpolate = asBoolean(value.interpolate, "options.interpolate");
  return options;
}

/** Reduce a user-supplied name to something safe for a file on disk. */
function safeFileName(value, fallback = "location-studio-route") {
  const base = typeof value === "string" ? value : "";
  const cleaned = base
    .replace(/\.[A-Za-z0-9]{1,8}$/, "")
    .replace(/[^A-Za-z0-9 _-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return (cleaned || fallback).slice(0, 64);
}

/**
 * Normalise any thrown value into a plain object with the same shape as a bridge
 * error envelope.
 *
 * The result is deliberately a plain object: class instances would lose both
 * their prototype and any `toJSON` method when Electron structured-clones the
 * response to the renderer, so the shape is normalised here instead.
 */
function toBridgeError(error) {
  if (error && typeof error.toJSON === "function") {
    const serialised = error.toJSON();
    if (isPlainObject(serialised)) return serialised;
  }
  if (!error || typeof error !== "object") {
    return { code: "INTERNAL", message: "Unexpected error." };
  }
  const payload = {
    code: typeof error.code === "string" && error.code ? error.code : "INTERNAL",
    message: typeof error.message === "string" && error.message ? error.message : "Unexpected error.",
  };
  if (error.details) payload.details = String(error.details);
  if (error.remedy) payload.remedy = String(error.remedy);
  if (error.retryable !== undefined) payload.retryable = Boolean(error.retryable);
  return payload;
}

module.exports = {
  MAX_GPX_READ_BYTES,
  MAX_ROUTE_POINTS,
  DEVICE_ID_PATTERN,
  ValidationFailure,
  isPlainObject,
  asString,
  asNumber,
  asBoolean,
  validateDeviceId,
  validateCoordinate,
  validatePoints,
  validateOptions,
  safeFileName,
  toBridgeError,
};
