/**
 * ============================================================================
 *  field-tracker.test.ts — pure map/fence rules for the Field Tracker
 * ============================================================================
 *
 *  The server decides containment, but the client mirrors it (to focus a
 *  fence and format a pin tooltip). These tests pin that mirror down:
 *  overlap → nearest centre, outside = no match, and the employee number is
 *  always the first tooltip line.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findContainingFence,
  findNearestFence,
  formatDistance,
  freshnessLabel,
  markerLines,
  matchesFieldTrackerQuery,
  sortFieldTrackerDevices,
  statusLabel,
} from "../src/lib/field-tracker.ts";
import type { FieldTrackerDevice } from "../src/lib/types.ts";

const BELMONT = {
  id: 1,
  branch: "Belmont",
  latitude: -20.1725,
  longitude: 28.5752,
  radiusMeters: 150,
};

const TONGOGARA = {
  id: 2,
  branch: "Tongogara",
  latitude: -20.1503,
  longitude: 28.5898,
  radiusMeters: 150,
};

/** Build a device fixture with sensible defaults. */
function device(overrides: Partial<FieldTrackerDevice> = {}): FieldTrackerDevice {
  return {
    employeeId: 1,
    employeeNumber: "ERP-1001",
    fullName: "Amara Okafor",
    department: "Operations",
    homeBranch: "Belmont",
    deviceName: "Pixel 8",
    branch: "Belmont",
    latitude: BELMONT.latitude,
    longitude: BELMONT.longitude,
    accuracyMeters: 12,
    source: "live",
    status: "live",
    lastSeenAt: 1_700_000_000_000,
    clockedIn: true,
    clockedInAt: 1_700_000_000_000,
    direction: "IN",
    insideFence: true,
    distanceMeters: 0,
    ...overrides,
  };
}

test("findContainingFence returns the fence that actually contains a fix", () => {
  const match = findContainingFence(
    [BELMONT, TONGOGARA],
    BELMONT.latitude,
    BELMONT.longitude
  );
  assert.equal(match?.site.branch, "Belmont");
  assert.equal(match?.distanceMeters, 0);
});

test("findContainingFence returns null outside every radius", () => {
  assert.equal(findContainingFence([BELMONT, TONGOGARA], -17.8292, 31.0522), null);
});

test("overlapping fences resolve to the nearest centre", () => {
  const other = {
    id: 3,
    branch: "Junkshop",
    latitude: -20.1486,
    longitude: 28.587,
    radiusMeters: 5_000,
  };
  // Standing exactly on Belmont is 0 m from Belmont, far from Junkshop.
  const match = findContainingFence([other, BELMONT], BELMONT.latitude, BELMONT.longitude);
  assert.equal(match?.site.branch, "Belmont");
});

test("findNearestFence works even outside every radius", () => {
  const match = findNearestFence([BELMONT, TONGOGARA], -17.8292, 31.0522);
  assert.ok(match);
  // Both are far, but the result must be one of the two known sites.
  assert.ok(["Belmont", "Tongogara"].includes(match!.site.branch));
});

test("formatDistance is compact and guards junk", () => {
  assert.equal(formatDistance(45), "45 m");
  assert.equal(formatDistance(1_250), "1.3 km");
  assert.equal(formatDistance(null), "—");
  assert.equal(formatDistance(Number.NaN), "—");
});

test("statusLabel covers every stored status", () => {
  assert.equal(statusLabel("live"), "Live");
  assert.equal(statusLabel("stale"), "Stale");
  assert.equal(statusLabel("last-known"), "Last known");
});

test("freshnessLabel distinguishes live fixes from last-known punches", () => {
  const now = 1_700_000_120_000; // +2 min
  assert.equal(freshnessLabel(device({ source: "live" }), now), "Live · 2m ago");
  assert.equal(freshnessLabel(device({ source: "punch", status: "last-known" }), now), "Last known · 2m ago");
});

test("search matches employee number, name and department", () => {
  const d = device();
  assert.equal(matchesFieldTrackerQuery(d, "erp-1001"), true);
  assert.equal(matchesFieldTrackerQuery(d, "amara"), true);
  assert.equal(matchesFieldTrackerQuery(d, "operations"), true);
  assert.equal(matchesFieldTrackerQuery(d, "nobody"), false);
  assert.equal(matchesFieldTrackerQuery(d, "   "), true);
});

test("directory order puts clocked-in people first, then employee number", () => {
  const rows = sortFieldTrackerDevices([
    device({ employeeId: 1, employeeNumber: "ERP-2", clockedIn: false }),
    device({ employeeId: 2, employeeNumber: "ERP-10", clockedIn: true }),
    device({ employeeId: 3, employeeNumber: "ERP-1", clockedIn: true }),
  ]);
  assert.deepEqual(
    rows.map((r) => r.employeeNumber),
    ["ERP-1", "ERP-10", "ERP-2"]
  );
});

test("markerLines always leads with the employee number", () => {
  const lines = markerLines(device(), 1_700_000_060_000);
  assert.equal(lines[0], "ERP-1001");
  assert.equal(lines[1], "Amara Okafor");
  assert.match(lines[2], /Belmont/);
  assert.equal(lines[3], "Clocked in");
  assert.match(lines[4], /GPS/);
});

test("markerLines falls back to an off-site label", () => {
  const lines = markerLines(
    device({ branch: null, insideFence: false, accuracyMeters: null }),
    1_700_000_000_000
  );
  assert.equal(lines[0], "ERP-1001");
  assert.match(lines[2], /Outside every fence/);
  assert.equal(lines.includes(""), false);
});
