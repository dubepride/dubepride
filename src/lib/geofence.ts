/**
 * ============================================================================
 *  geofence.ts — Hands-Free Geofenced Mobile Clocking (Phase 15)
 * ============================================================================
 *
 *  Pure, dependency-free helpers shared by:
 *    • the server  (db.ts migrations/seeds, /api/attendance/geopunch, branches
 *                   & terminals API handlers)
 *    • the client  (Settings → Branches tab, Clocking Devices form)
 *
 *  No React, no next/*, no node:sqlite imports — so it bundles cleanly into
 *  both sides of the app (same convention as lib/rbac.ts).
 *
 *  The feature is an OPTIONAL secondary clocking channel. Biometric terminals
 *  remain the default and primary path; geofencing only ever *adds* a way in,
 *  it never removes or alters the ADMS push listener or the ERP sync engine.
 */

import type { ClockingMethod } from "./types";

/** Canonical stored values, in UI order (Biometric first = the default). */
export const CLOCKING_METHODS: readonly ClockingMethod[] = ["Biometric", "Geofence", "Both"];

/** Dropdown/segmented options with the friendlier admin-facing wording. */
export const CLOCKING_METHOD_OPTIONS: readonly {
  value: ClockingMethod;
  label: string;
  hint: string;
}[] = [
  {
    value: "Biometric",
    label: "Biometric Only",
    hint: "Physical fingerprint terminal only — mobile clocking is rejected here.",
  },
  {
    value: "Geofence",
    label: "Geofence Only",
    hint: "Hands-free mobile check-in inside the GPS radius — no terminal needed.",
  },
  {
    value: "Both",
    label: "Hybrid — Both",
    hint: "Accept the fingerprint terminal AND hands-free mobile clocking.",
  },
];

/** Short chip label for tables/lists. */
export function clockingMethodShort(method: ClockingMethod): string {
  switch (method) {
    case "Geofence":
      return "Geofence";
    case "Both":
      return "Hybrid";
    default:
      return "Biometric";
  }
}

/**
 * Normalise any admin/API input into a canonical ClockingMethod.
 * Accepts the seed/UI wording ("Biometric Only", "Geofence Only", "Hybrid"),
 * common synonyms and anything unknown falls back to "Biometric" — the safe,
 * primary-only default (never accidentally opens mobile clocking).
 */
export function normalizeClockingMethod(raw: unknown): ClockingMethod {
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "both" || v === "hybrid" || v === "hybrid (both)" || v === "hybrid — both") return "Both";
    if (v === "geofence" || v === "geo" || v === "gps" || v === "mobile" || v === "geofence only") {
      return "Geofence";
    }
    if (v === "biometric" || v === "biometric only" || v === "fingerprint" || v === "terminal") {
      return "Biometric";
    }
  }
  return "Biometric";
}

/** True when this method permits the mobile GPS channel at all. */
export function methodAllowsMobile(method: ClockingMethod): boolean {
  return method === "Geofence" || method === "Both";
}

/** True when this method still expects a physical terminal (MAC/IP). */
export function methodUsesTerminal(method: ClockingMethod): boolean {
  return method === "Biometric" || method === "Both";
}

/** A coordinate pair is usable only when both halves are finite & in range. */
export function isFiniteCoordinate(latitude: unknown, longitude: unknown): boolean {
  const lat = typeof latitude === "number" ? latitude : Number(latitude);
  const lng = typeof longitude === "number" ? longitude : Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/** A radius is usable when it is a finite number in (0, 100 km]. */
export function isValidRadius(radius: unknown): boolean {
  const r = typeof radius === "number" ? radius : Number(radius);
  return Number.isFinite(r) && r > 0 && r <= 100_000;
}

/** Mean Earth radius in metres (WGS-84 sphere approximation). */
const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle (haversine) distance between two WGS-84 points, in metres.
 * Accurate to well under a metre at geofence scales (tens → thousands of m),
 * which is far tighter than typical phone GPS accuracy.
 */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/** Whole-metre distance (what we persist + report). */
export function haversineMetersRounded(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  return Math.round(haversineMeters(lat1, lon1, lat2, lon2));
}

/* ------------------------------------------------------------------ */
/* Request-body helpers (shared by the Branches + Terminals APIs)       */
/* ------------------------------------------------------------------ */

/** Partial clocking configuration pulled from an untrusted request body. */
export interface ClockingConfigBody {
  clockingMethod?: ClockingMethod;
  latitude?: number | null;
  longitude?: number | null;
  geofenceRadiusMeters?: number | null;
}

/** Coerce an optional numeric field: absent → undefined, blank/junk → null. */
function optionalNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * First alias that is actually *present*. Unlike `??`, an explicit `null`
 * counts as present — so a client can deliberately clear a stored value
 * (e.g. send `geofenceRadiusMeters: null` to wipe a radius).
 */
function firstPresent(...values: unknown[]): unknown {
  for (const value of values) if (value !== undefined) return value;
  return undefined;
}

/**
 * Extract the Phase 15 fields from a request body, keeping only the keys the
 * caller actually sent (so a PATCH that omits geofence config never clears
 * it). Unknown/missing keys are left `undefined`.
 */
export function readClockingConfig(body: Record<string, unknown>): ClockingConfigBody {
  const out: ClockingConfigBody = {};
  for (const key of ["clockingMethod", "clocking_method", "method"]) {
    if (body[key] !== undefined) {
      out.clockingMethod = normalizeClockingMethod(body[key]);
      break;
    }
  }
  const lat = optionalNumber(firstPresent(body.latitude, body.lat));
  if (lat !== undefined) out.latitude = lat;
  const lng = optionalNumber(firstPresent(body.longitude, body.lng, body.lon));
  if (lng !== undefined) out.longitude = lng;
  const radius = optionalNumber(
    firstPresent(body.geofenceRadiusMeters, body.geofence_radius_meters, body.radiusMeters, body.radius)
  );
  if (radius !== undefined) out.geofenceRadiusMeters = radius;
  return out;
}

/** True when the caller sent at least one Phase 15 field. */
export function hasClockingConfig(config: ClockingConfigBody): boolean {
  return (
    config.clockingMethod !== undefined ||
    config.latitude !== undefined ||
    config.longitude !== undefined ||
    config.geofenceRadiusMeters !== undefined
  );
}

/** Validate a parsed clocking config — returns an error string or null. */
export function validateClockingConfig(config: ClockingConfigBody): string | null {
  if (config.latitude !== undefined && config.latitude !== null && !Number.isFinite(config.latitude)) {
    return "Latitude must be a number between -90 and 90.";
  }
  if (config.longitude !== undefined && config.longitude !== null && !Number.isFinite(config.longitude)) {
    return "Longitude must be a number between -180 and 180.";
  }
  if (
    config.latitude !== undefined &&
    config.latitude !== null &&
    config.longitude !== undefined &&
    config.longitude !== null &&
    !isFiniteCoordinate(config.latitude, config.longitude)
  ) {
    return "Latitude must be -90..90 and longitude -180..180.";
  }
  if (
    config.geofenceRadiusMeters !== undefined &&
    config.geofenceRadiusMeters !== null &&
    !isValidRadius(config.geofenceRadiusMeters)
  ) {
    return "Geofence radius must be between 1 and 100000 metres.";
  }
  return null;
}
