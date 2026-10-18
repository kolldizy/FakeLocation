/**
 * Renderer maths, tested as a plain ES module (no DOM required).
 *
 * `util.js` is imported by the browser as an ES module; every export used here is
 * DOM-free, which is exactly why the route maths can be verified in Node.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPlaybackPoints,
  clamp,
  cumulativeLengths,
  densify,
  fmtClock,
  fmtCoord,
  fmtDistance,
  haversineM,
  mergeStages,
  parseCoordinate,
  routeLengthM,
  validateAltitude,
  validateLatitude,
  validateLongitude,
  waypointIndexAtDistance,
} from "../../renderer/js/util.js";

test("haversineM matches known distances within a sensible tolerance", () => {
  const paris = { lat: 48.8566, lon: 2.3522 };
  const london = { lat: 51.5074, lon: -0.1278 };
  const parisToLondon = haversineM(paris, london);
  assert.ok(Math.abs(parisToLondon - 343_500) < 2_000, `expected ~343.5 km, got ${parisToLondon}`);

  assert.equal(haversineM(paris, paris), 0);
  const oneDegreeOfLatitude = haversineM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
  assert.ok(Math.abs(oneDegreeOfLatitude - 111_195) < 200, `expected ~111.2 km, got ${oneDegreeOfLatitude}`);
});

test("cumulativeLengths and routeLengthM agree", () => {
  const points = [
    { lat: 47.0, lon: 28.0 },
    { lat: 47.0, lon: 28.001 },
    { lat: 47.001, lon: 28.001 },
  ];
  const lengths = cumulativeLengths(points);
  assert.equal(lengths.length, points.length);
  assert.equal(lengths[0], 0);
  assert.ok(lengths[1] > 0 && lengths[2] > lengths[1]);
  assert.equal(lengths[2], routeLengthM(points));
  assert.equal(routeLengthM([]), 0);
  assert.equal(routeLengthM([{ lat: 1, lon: 1 }]), 0);
});

test("densify never changes the endpoints and respects the segment budget", () => {
  const points = [
    { lat: 47.0, lon: 28.0 },
    { lat: 47.01, lon: 28.0 },
  ];
  const dense = densify(points, 10);
  assert.deepEqual(dense[0], points[0]);
  assert.deepEqual(dense.at(-1), points[1]);
  assert.ok(dense.length > 50, `expected a dense path, got ${dense.length} points`);
  for (let index = 1; index < dense.length; index += 1) {
    assert.ok(haversineM(dense[index - 1], dense[index]) <= 10.0001);
  }

  // A single point, or a disabled budget, must not invent geometry.
  assert.deepEqual(densify([{ lat: 1, lon: 2 }], 5), [{ lat: 1, lon: 2 }]);
  assert.deepEqual(densify(points, 0).length, points.length);
});

test("buildPlaybackPoints scales the update count with speed and update rate", () => {
  const points = [
    { lat: 47.0, lon: 28.0 },
    { lat: 47.01, lon: 28.0 },
  ];

  const slow = buildPlaybackPoints(points, { speedMps: 2, updateRateHz: 2, interpolate: true });
  const fast = buildPlaybackPoints(points, { speedMps: 20, updateRateHz: 2, interpolate: true });
  assert.ok(fast.length < slow.length, "a faster route needs coarser interpolation");

  const noInterpolation = buildPlaybackPoints(points, { speedMps: 8, updateRateHz: 5, interpolate: false });
  assert.deepEqual(noInterpolation, points);

  assert.deepEqual(buildPlaybackPoints([{ lat: 1, lon: 1 }], { speedMps: 8, updateRateHz: 5 }), [{ lat: 1, lon: 1 }]);

  // Updates per second must never exceed the requested rate at a given speed.
  const streaming = buildPlaybackPoints(points, { speedMps: 10, updateRateHz: 10, interpolate: true });
  const duration = routeLengthM(streaming.map((point) => point)) / 10;
  assert.ok(streaming.length <= Math.ceil(duration * 10) + 2, `too many updates: ${streaming.length}`);
});

test("waypointIndexAtDistance walks the route monotonically", () => {
  const points = [
    { lat: 47.0, lon: 28.0 },
    { lat: 47.001, lon: 28.0 },
    { lat: 47.002, lon: 28.0 },
    { lat: 47.003, lon: 28.0 },
  ];
  const total = routeLengthM(points);
  assert.equal(waypointIndexAtDistance(points, 0), 0);
  assert.equal(waypointIndexAtDistance(points, -100), 0);
  assert.equal(waypointIndexAtDistance(points, total + 1000), points.length - 1);

  let previous = -1;
  for (let step = 0; step <= 10; step += 1) {
    const index = waypointIndexAtDistance(points, (total * step) / 10);
    assert.ok(index >= previous, "walking forward must not go backwards");
    previous = index;
  }
});

test("coordinate parsing and validation separate numbers from everything else", () => {
  assert.equal(parseCoordinate(" 47.0105 "), 47.0105);
  assert.equal(parseCoordinate("-0.5"), -0.5);
  assert.equal(parseCoordinate(""), 0); // Number("") is 0, which is why the UI checks emptiness first
  for (const bad of ["abc", "12,5", "NaN", "Infinity", {}, null, undefined]) {
    assert.equal(parseCoordinate(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }

  assert.equal(validateLatitude(47), null);
  assert.equal(validateLatitude(-90), null);
  assert.equal(validateLatitude(90), null);
  assert.match(validateLatitude(90.1), /between -90 and 90/);
  assert.match(validateLatitude(Number.NaN), /must be a number/);
  assert.match(validateLatitude("47"), /must be a number/);

  assert.equal(validateLongitude(180), null);
  assert.match(validateLongitude(180.1), /between -180 and 180/);

  assert.equal(validateAltitude(""), null);
  assert.equal(validateAltitude(null), null);
  assert.equal(validateAltitude(0), null);
  assert.equal(validateAltitude(-12000), null);
  assert.match(validateAltitude(12001), /within/);
  assert.match(validateAltitude("high"), /must be a number/);
});

test("formatting helpers stay stable for the UI", () => {
  assert.equal(fmtCoord(47.01049, 4), "47.0105");
  assert.equal(fmtClock(0), "00:00");
  assert.equal(fmtClock(59), "00:59");
  assert.equal(fmtClock(60), "01:00");
  assert.equal(fmtClock(3600), "1:00:00");
  assert.equal(fmtClock(-5), "00:00");
  assert.equal(fmtDistance(999), "999 m");
  assert.equal(fmtDistance(1000), "1.00 km");
  assert.equal(fmtDistance(Number.NaN), "—");
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-5, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
});

test("mergeStages never lets an unmeasured stage erase a measured one", () => {
  const previous = { usbDetected: true, paired: true, developerModeEnabled: true, simulationReady: true };
  // A cheap scan cannot open lockdown, so it reports those stages as null.
  const cheapScan = { usbDetected: true, paired: null, trusted: null, developerModeEnabled: null, simulationReady: null };
  assert.deepEqual(mergeStages(previous, cheapScan), {
    usbDetected: true,
    paired: true,
    developerModeEnabled: true,
    simulationReady: true,
  });

  // A fresh verdict is newer than the remembered one and must win.
  assert.deepEqual(mergeStages(previous, { simulationReady: false }), { ...previous, simulationReady: false });
  assert.deepEqual(mergeStages(previous, {}), previous);
  assert.deepEqual(mergeStages(undefined, { paired: false }), { paired: false });
  assert.deepEqual(mergeStages(previous, undefined), previous);
});
