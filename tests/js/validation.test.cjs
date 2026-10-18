/**
 * Validation rules used by the IPC layer, tested without Electron.
 *
 * These are the checks that decide whether a renderer payload may reach the
 * device bridge at all, so the hostile cases matter as much as the happy path.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  asNumber,
  asString,
  isPlainObject,
  safeFileName,
  toBridgeError,
  validateCoordinate,
  validateDeviceId,
  validateOptions,
  validatePoints,
} = require("../../electron/validation.cjs");

const UDID = "00008140-0000000000000000";

test("isPlainObject rejects arrays, null and class instances", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ a: 1 }), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(new Date()), true); // objects with a prototype are still objects here
  assert.equal(isPlainObject("{}"), false);
});

test("asString trims, bounds and refuses empty required values", () => {
  assert.equal(asString("  hello  ", "name"), "hello");
  assert.equal(asString(undefined, "name", { required: false }), null);
  assert.equal(asString(null, "name", { required: false }), null);
  assert.throws(() => asString("", "name"), /must not be empty/);
  assert.throws(() => asString("   ", "name"), /must not be empty/);
  assert.throws(() => asString(42, "name"), /must be a string/);
  assert.throws(() => asString("x".repeat(201), "name"), /at most 200/);
  assert.equal(asString("x".repeat(50), "name", { max: 50 }), "x".repeat(50));
});

test("asNumber accepts only finite numbers inside the range", () => {
  assert.equal(asNumber(5, "n", { min: 0, max: 10 }), 5);
  assert.equal(asNumber(undefined, "n", { optional: true }), undefined);
  assert.throws(() => asNumber(undefined, "n"), /required/);
  assert.throws(() => asNumber("5", "n"), /finite number/);
  assert.throws(() => asNumber(Number.NaN, "n"), /finite number/);
  assert.throws(() => asNumber(Number.POSITIVE_INFINITY, "n"), /finite number/);
  assert.throws(() => asNumber(-1, "n", { min: 0 }), /at least 0/);
  assert.throws(() => asNumber(11, "n", { max: 10 }), /at most 10/);
});

test("device identifiers must look like a UDID", () => {
  assert.equal(validateDeviceId({ deviceId: UDID }), UDID);
  assert.equal(validateDeviceId({ deviceId: `  ${UDID}  ` }), UDID);
  assert.equal(validateDeviceId({ deviceId: "abcdef01" }), "abcdef01");

  for (const bad of [undefined, "", "   ", "short", "-leading", "has spaces", "x".repeat(65), "$(id)"]) {
    assert.throws(() => validateDeviceId({ deviceId: bad }), /deviceId/);
  }
});

test("coordinates are clamped by range, not by rounding", () => {
  assert.deepEqual(validateCoordinate({ lat: 90, lon: 180 }), { lat: 90, lon: 180 });
  assert.deepEqual(validateCoordinate({ lat: -90, lon: -180 }), { lat: -90, lon: -180 });
  assert.deepEqual(validateCoordinate({ lat: 0, lon: 0, altitude: -12000 }), { lat: 0, lon: 0, altitude: -12000 });

  assert.throws(() => validateCoordinate({ lat: 90.000001, lon: 0 }), /lat/);
  assert.throws(() => validateCoordinate({ lat: 0, lon: 180.000001 }), /lon/);
  assert.throws(() => validateCoordinate({ lat: 0, lon: 0, altitude: 12001 }), /altitude/);
  assert.throws(() => validateCoordinate(null), /coordinate/);
  assert.throws(() => validateCoordinate([47, 28]), /coordinate/);
  assert.throws(() => validateCoordinate({ lat: 0 }), /coordinate.lon/);
});

test("point lists enforce minimums and the hard cap", () => {
  assert.equal(validatePoints([{ lat: 0, lon: 0 }], { minimum: 1 }).length, 1);
  assert.throws(() => validatePoints([], { minimum: 1 }), /at least 1/);
  assert.throws(() => validatePoints([{ lat: 0, lon: 0 }], { minimum: 2 }), /at least 2/);
  assert.throws(() => validatePoints("nope"), /must be an array/);
  assert.throws(() => validatePoints(Array.from({ length: 20_001 }, () => ({ lat: 0, lon: 0 }))), /20000/);
  assert.equal(validatePoints(Array.from({ length: 20_000 }, () => ({ lat: 0, lon: 0 }))).length, 20_000);
});

test("route options keep only known fields with valid values", () => {
  assert.deepEqual(validateOptions(undefined), {});
  assert.deepEqual(validateOptions(null), {});
  assert.deepEqual(validateOptions({}), {});
  assert.deepEqual(validateOptions({ speedMps: 8, updateRateHz: 5, loop: true, interpolate: false }), {
    speedMps: 8,
    updateRateHz: 5,
    loop: true,
    interpolate: false,
  });
  // Unknown fields are dropped rather than forwarded to the device bridge.
  assert.deepEqual(validateOptions({ speedMps: 8, extra: "ignored", command: "shutdown" }), { speedMps: 8 });

  assert.throws(() => validateOptions({ speedMps: 0 }), /speedMps/);
  assert.throws(() => validateOptions({ speedMps: 401 }), /speedMps/);
  assert.throws(() => validateOptions({ updateRateHz: 0.4 }), /updateRateHz/);
  assert.throws(() => validateOptions({ updateRateHz: 21 }), /updateRateHz/);
  assert.throws(() => validateOptions({ loop: "true" }), /loop/);
  assert.throws(() => validateOptions([]), /must be an object/);
});

test("safeFileName strips traversal, punctuation and extension", () => {
  assert.equal(safeFileName("My route"), "My-route");
  assert.equal(safeFileName("../../etc/passwd"), "etcpasswd");
  assert.equal(safeFileName("route.gpx"), "route");
  assert.equal(safeFileName("route.GPX"), "route");
  assert.equal(safeFileName("a".repeat(200)).length, 64);
  assert.equal(safeFileName(""), "location-studio-route");
  assert.equal(safeFileName(undefined), "location-studio-route");
  assert.equal(safeFileName("CON<>|?*"), "CON");
  assert.equal(safeFileName("  spaced   name  "), "spaced-name");
});

test("a rejected payload is reported as INVALID_PARAMS, never as an internal fault", () => {
  const attempts = [
    () => validateCoordinate({ lat: 91, lon: 0 }),
    () => validateCoordinate("paris"),
    () => validateDeviceId({ deviceId: "not a udid!" }),
    () => validateDeviceId({}),
    () => validatePoints([]),
    () => validateOptions({ speedMps: 0 }),
    () => validateOptions([1, 2]),
    () => asNumber(Number.NaN, "n"),
  ];

  for (const attempt of attempts) {
    let caught = null;
    try {
      attempt();
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, `expected ${attempt} to be refused`);
    assert.equal(caught.code, "INVALID_PARAMS", `${attempt} must carry the validation code`);
    assert.deepEqual(toBridgeError(caught), { code: "INVALID_PARAMS", message: caught.message });
  }
});

test("toBridgeError always yields a plain, serialisable object", () => {
  assert.deepEqual(toBridgeError(new Error("boom")), { code: "INTERNAL", message: "boom" });
  assert.deepEqual(toBridgeError("boom"), { code: "INTERNAL", message: "Unexpected error." });
  assert.deepEqual(toBridgeError(undefined), { code: "INTERNAL", message: "Unexpected error." });

  const rich = Object.assign(new Error("not paired"), {
    code: "NOT_PAIRED",
    details: "lockdownd refused",
    remedy: "pair the phone",
    retryable: true,
  });
  assert.deepEqual(toBridgeError(rich), {
    code: "NOT_PAIRED",
    message: "not paired",
    details: "lockdownd refused",
    remedy: "pair the phone",
    retryable: true,
  });

  const jsonable = { toJSON: () => ({ code: "TIMEOUT", message: "timed out" }), toString: () => "ignored" };
  assert.deepEqual(toBridgeError(jsonable), { code: "TIMEOUT", message: "timed out" });

  // The result must survive a structured clone (what Electron does to the reply).
  assert.deepEqual(JSON.parse(JSON.stringify(toBridgeError(rich))), toBridgeError(rich));
});
