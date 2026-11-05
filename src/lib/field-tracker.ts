/**
 * ============================================================================
 *  field-tracker.ts — pure helpers for the Field Tracker live map
 * ============================================================================
 *
 *  No React, no next/*, no database imports — so the same rules run in the
 *  API layer, the client components and the node:test suite.
 *
 *  The server remains the authority for fence containment (src/lib/db.ts
 *  `listFieldTracker`); these helpers mirror that arithmetic for the client
 *  so the UI can rank/focus a fence without another round-trip. The distance
 *  formula is the same haversine used by src/lib/geofence.ts (kept local so
 *  this module stays runtime-dependency-free and directly testable).
 */

import type { FieldTrackerDevice, FieldTrackerStatus } from "./types";

const EARTH_RADIUS_M = 6_371_008.8;
const toRadians = (deg: number): number => (deg * Math.PI) / 180;

/** Whole-metre great-circle distance (identical to geofence.haversineMetersRounded). */
function haversineRounded(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(EARTH_RADIUS_M * c);
}

/** Minimum fence shape needed to test containment. */
export interface FenceLike {
  id: number;
  branch: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

export interface FenceMatch<T extends FenceLike> {
  site: T;
  distanceMeters: number;
}

/**
 * The fence whose radius contains the fix, or null. Overlapping fences resolve
 * to the nearest centre (mirrors the server's rule).
 */
export function findContainingFence<T extends FenceLike>(
  sites: readonly T[],
  latitude: number,
  longitude: number
): FenceMatch<T> | null {
  let best: FenceMatch<T> | null = null;
  for (const site of sites) {
    const distanceMeters = haversineRounded(
      latitude,
      longitude,
      site.latitude,
      site.longitude
    );
    if (distanceMeters > site.radiusMeters) continue;
    if (!best || distanceMeters < best.distanceMeters) best = { site, distanceMeters };
  }
  return best;
}

/** Closest fence by centre distance, regardless of radius. */
export function findNearestFence<T extends FenceLike>(
  sites: readonly T[],
  latitude: number,
  longitude: number
): FenceMatch<T> | null {
  let best: FenceMatch<T> | null = null;
  for (const site of sites) {
    const distanceMeters = haversineRounded(
      latitude,
      longitude,
      site.latitude,
      site.longitude
    );
    if (!best || distanceMeters < best.distanceMeters) best = { site, distanceMeters };
  }
  return best;
}

/** "45 m" / "1.2 km" / "—" — compact distance for chips and tooltips. */
export function formatDistance(meters: number | null | undefined): string {
  if (typeof meters !== "number" || !Number.isFinite(meters) || meters < 0) return "—";
  if (meters < 1_000) return `${Math.round(meters)} m`;
  return `${(meters / 1_000).toFixed(1)} km`;
}

/** Human label for the source/status of a tracked fix. */
export function statusLabel(status: FieldTrackerStatus): string {
  switch (status) {
    case "live":
      return "Live";
    case "stale":
      return "Stale";
    default:
      return "Last known";
  }
}

/** One-line freshness wording used by the directory and tooltip. */
export function freshnessLabel(device: FieldTrackerDevice, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - device.lastSeenAt) / 1000));
  if (device.source === "punch" || device.source === "terminal" || device.source === "branch") {
    return `Last known · ${relativeShort(seconds)}`;
  }
  return `${statusLabel(device.status)} · ${relativeShort(seconds)}`;
}

function relativeShort(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Case-insensitive employee-number / name match. */
export function matchesFieldTrackerQuery(
  device: FieldTrackerDevice,
  query: string
): boolean {
  const text = query.trim().toLowerCase();
  if (!text) return true;
  return (
    device.employeeNumber.toLowerCase().includes(text) ||
    device.fullName.toLowerCase().includes(text) ||
    device.department.toLowerCase().includes(text)
  );
}

/** Clocked-in first, then employee number (stable, predictable directory). */
export function sortFieldTrackerDevices(
  devices: readonly FieldTrackerDevice[]
): FieldTrackerDevice[] {
  return [...devices].sort(
    (a, b) =>
      Number(b.clockedIn) - Number(a.clockedIn) ||
      a.employeeNumber.localeCompare(b.employeeNumber)
  );
}

/** Tooltip lines for a map pin — the employee number is ALWAYS first. */
export function markerLines(device: FieldTrackerDevice, now = Date.now()): string[] {
  const place = device.branch?.trim() || "Outside every fence";
  const badge = device.clockedIn ? "Clocked in" : "Not clocked in";
  return [
    device.employeeNumber,
    device.fullName,
    `${place} · ${freshnessLabel(device, now)}`,
    badge,
    device.accuracyMeters != null ? `GPS ±${Math.round(device.accuracyMeters)} m` : "",
  ].filter(Boolean);
}
