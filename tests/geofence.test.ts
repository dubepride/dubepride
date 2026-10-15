import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isFiniteCoordinate,
  isValidRadius,
  haversineMeters,
  haversineMetersRounded,
  normalizeClockingMethod,
  methodAllowsMobile,
  methodUsesTerminal,
  clockingMethodShort,
  readClockingConfig,
  hasClockingConfig,
  validateClockingConfig,
} from "../src/lib/geofence.ts";

test("isFiniteCoordinate accepts valid WGS-84", () => {
  assert.equal(isFiniteCoordinate(0, 0), true);
  assert.equal(isFiniteCoordinate(-17.8292, 31.0522), true);
  assert.equal(isFiniteCoordinate(-90, -180), true);
  assert.equal(isFiniteCoordinate(90, 180), true);
});

test("isFiniteCoordinate rejects out of range", () => {
  assert.equal(isFiniteCoordinate(91, 0), false);
  assert.equal(isFiniteCoordinate(-91, 0), false);
  assert.equal(isFiniteCoordinate(0, 181), false);
  assert.equal(isFiniteCoordinate(0, -181), false);
  assert.equal(isFiniteCoordinate(NaN, 0), false);
});

test("isValidRadius checks bounds", () => {
  assert.equal(isValidRadius(1), true);
  assert.equal(isValidRadius(150), true);
  assert.equal(isValidRadius(100000), true);
  assert.equal(isValidRadius(0), false);
  assert.equal(isValidRadius(-10), false);
  assert.equal(isValidRadius(100001), false);
  assert.equal(isValidRadius(NaN), false);
});

test("haversine is symmetric and roughly correct", () => {
  const d = haversineMeters(0, 0, 0, 1.0);
  assert.ok(d >= 111195 && d <= 111200, `distance ~111195 m, got ${d}`);
  assert.ok(Math.abs(haversineMeters(0, 0, 1, 1) - haversineMeters(1, 1, 0, 0)) < 1e-6);
  assert.ok(Math.abs(haversineMeters(0, 0, 0, 0)) < 1e-6);
});

test("haversineMetersRounded rounds to nearest metre", () => {
  const d = haversineMetersRounded(0, 0, 0, 1.0);
  assert.equal(d, 111195);
});

test("normalizeClockingMethod maps synonyms", () => {
  assert.equal(normalizeClockingMethod("biometric only"), "Biometric");
  assert.equal(normalizeClockingMethod("Biometric Only"), "Biometric");
  assert.equal(normalizeClockingMethod("Geofence Only"), "Geofence");
  assert.equal(normalizeClockingMethod("hybrid"), "Both");
  assert.equal(normalizeClockingMethod("Hybrid — Both"), "Both");
  assert.equal(normalizeClockingMethod(null), "Biometric");
  assert.equal(normalizeClockingMethod("weird"), "Biometric");
});

test("methodFlags behave correctly", () => {
  assert.equal(methodAllowsMobile("Biometric"), false);
  assert.equal(methodAllowsMobile("Geofence"), true);
  assert.equal(methodAllowsMobile("Both"), true);

  assert.equal(methodUsesTerminal("Biometric"), true);
  assert.equal(methodUsesTerminal("Geofence"), false);
  assert.equal(methodUsesTerminal("Both"), true);

  assert.equal(clockingMethodShort("Both"), "Hybrid");
  assert.equal(clockingMethodShort("Biometric"), "Biometric");
  assert.equal(clockingMethodShort("Geofence"), "Geofence");
});

test("readClockingConfig reads aliased fields and treats null as explicit clear", () => {
  const c = readClockingConfig({
    latitude: " -17.829 ",
    lon: " 31.052 ",
    geofence_radius_meters: " 250 ",
    clocking_method: "geofence only",
  });
  assert.equal(c.clockingMethod, "Geofence");
  assert.equal(c.latitude, -17.829);
  assert.equal(c.longitude, 31.052);
  assert.equal(c.geofenceRadiusMeters, 250);

  const d = readClockingConfig({ geofenceRadiusMeters: null });
  assert.equal(d.geofenceRadiusMeters, null);
  assert.equal(d.clockingMethod, undefined);
});

test("hasClockingConfig detects presence", () => {
  assert.equal(hasClockingConfig({}), false);
  assert.equal(hasClockingConfig({ latitude: 1 }), true);
  assert.equal(hasClockingConfig({ geofenceRadiusMeters: null }), true);
  assert.equal(hasClockingConfig({ clockingMethod: "Biometric" }), true);
});

test("validateClockingConfig enforces ranges", () => {
  assert.equal(validateClockingConfig({}), null);
  assert.equal(
    validateClockingConfig({ latitude: 1, longitude: 1, geofenceRadiusMeters: 100 }),
    null
  );
  // A single non-finite coordinate is reported on its own.
  assert.ok(validateClockingConfig({ latitude: NaN })?.includes("Latitude"));
  assert.ok(validateClockingConfig({ longitude: Infinity })?.includes("Longitude"));
  // Out-of-range values are caught when a full coordinate pair is supplied.
  assert.ok(validateClockingConfig({ latitude: 91, longitude: 0 })?.includes("-90..90"));
  assert.ok(validateClockingConfig({ latitude: 0, longitude: 181 })?.includes("-90..90"));
  assert.ok(
    validateClockingConfig({ latitude: 1, longitude: 1, geofenceRadiusMeters: 0 })?.includes("radius")
  );
});
