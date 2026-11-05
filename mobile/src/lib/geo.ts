/**
 * ============================================================================
 *  geo.ts — the geofence maths and site ranking
 * ============================================================================
 *
 *  Pure module: no React, no Expo, no I/O. Uses the exact same Haversine
 *  distance and radius comparison (`Math.round(distance) <= radiusMeters`) as
 *  the server (`src/lib/geo-punch.ts`), so resizing a geofence radius on the
 *  web app produces the exact same inside/outside boundary on the mobile app.
 */

import type { GeofenceConfig, GeoFenceSite } from "./types";

/* ------------------------------------------------------------------ */
/* Task names                                                          */
/* ------------------------------------------------------------------ */

export const GEOFENCE_TASK = "biobridge-geofence";
export const DWELL_TASK = "biobridge-dwell";
export const REGION_PREFIX = "biobridge:";

/* ------------------------------------------------------------------ */
/* Timing + constants                                                  */
/* ------------------------------------------------------------------ */

export const DWELL_MS = 3 * 60 * 1000;
export const DWELL_MIN_SAMPLES = 2;
/**
 * While signed in the fix stream also feeds the Field Tracker. A relaxed fix
 * every 60 s keeps the map fresh (the bridge marks a phone stale after 5 min)
 * without the battery cost of the armed cadence.
 */
export const LOCATION_INTERVAL_RELAXED_MS = 60_000;
export const LOCATION_INTERVAL_ARMED_MS = 30_000;
export const LOCATION_DISTANCE_M = 25;
export const ACCURACY_SLACK_M = 0;
export const MIN_ANDROID_REGION_RADIUS_M = 100;

/* ------------------------------------------------------------------ */
/* Distance                                                            */
/* ------------------------------------------------------------------ */

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle distance in metres (Haversine) — identical to the bridge's
 * server-side formula.
 */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export interface FenceLike {
  latitude: number | null;
  longitude: number | null;
  radiusMeters: number | null;
}

/** True when the site has a usable centre and radius. */
export function hasFence(config: FenceLike | null | undefined): boolean {
  if (!config) return false;
  return (
    isFiniteNumber(config.latitude) &&
    isFiniteNumber(config.longitude) &&
    isFiniteNumber(config.radiusMeters) &&
    config.radiusMeters > 0
  );
}

/** Metres from the fence centre, or null when the fence isn't configured. */
export function distanceToCentre(
  config: FenceLike | null | undefined,
  latitude: number,
  longitude: number
): number | null {
  if (!hasFence(config) || !isFiniteNumber(latitude) || !isFiniteNumber(longitude)) {
    return null;
  }
  return haversineMeters(
    latitude,
    longitude,
    Number(config!.latitude),
    Number(config!.longitude)
  );
}

/**
 * Inside-or-not verdict matching the server's `haversineMetersRounded <= radiusMeters`
 * to the exact metre.
 */
export function isInsideFence(
  config: FenceLike | null | undefined,
  latitude: number,
  longitude: number,
  _accuracyMeters?: number | null
): boolean {
  const distance = distanceToCentre(config, latitude, longitude);
  if (distance === null) return false;
  return Math.round(distance) <= Number(config!.radiusMeters);
}

export function regionRadiusMeters(config: FenceLike): number {
  const configured = isFiniteNumber(config.radiusMeters) ? config.radiusMeters : 0;
  return Math.max(configured, MIN_ANDROID_REGION_RADIUS_M);
}

/* ------------------------------------------------------------------ */
/* Many sites — "clock in wherever you are"                            */
/* ------------------------------------------------------------------ */

export interface SiteMatch {
  site: GeoFenceSite;
  distanceMeters: number;
  withinGeofence: boolean;
}

function isUsableSite(site: GeoFenceSite | null | undefined): site is GeoFenceSite {
  return !!site && hasFence(site) && typeof site.branch === "string" && site.branch.length > 0;
}

/**
 * Rank every site nearest-first for a fix. Uses rounded distance in metres
 * (`Math.round(distanceMeters) <= site.radiusMeters`) so client and server
 * agree to the exact metre on every resized geofence radius.
 */
export function rankSites(
  sites: readonly GeoFenceSite[] | null | undefined,
  latitude: number,
  longitude: number,
  _accuracyMeters?: number | null
): SiteMatch[] {
  return (sites ?? [])
    .filter(isUsableSite)
    .map((site) => {
      const rawDistance = haversineMeters(latitude, longitude, site.latitude, site.longitude);
      const distanceMeters = Math.round(rawDistance);
      return {
        site,
        distanceMeters,
        withinGeofence: distanceMeters <= site.radiusMeters,
      };
    })
    .sort(
      (a, b) =>
        a.distanceMeters - b.distanceMeters || a.site.branch.localeCompare(b.site.branch)
    );
}

/** The site whose fence contains the fix, or null when outside all of them. */
export function activeSite(
  sites: readonly GeoFenceSite[] | null | undefined,
  latitude: number,
  longitude: number,
  accuracyMeters?: number | null
): SiteMatch | null {
  return rankSites(sites, latitude, longitude, accuracyMeters).find((m) => m.withinGeofence) ?? null;
}

/** The closest site whether or not it contains the fix — the "nearest" readout. */
export function nearestSite(
  sites: readonly GeoFenceSite[] | null | undefined,
  latitude: number,
  longitude: number,
  accuracyMeters?: number | null
): SiteMatch | null {
  return rankSites(sites, latitude, longitude, accuracyMeters)[0] ?? null;
}

export function regionIdentifier(site: GeoFenceSite, employeeId: number): string {
  return `${REGION_PREFIX}${employeeId}:${site.branch}`;
}

export function branchFromRegionIdentifier(identifier: string | null | undefined): string | null {
  if (!identifier || !identifier.startsWith(REGION_PREFIX)) return null;
  const rest = identifier.slice(REGION_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator < 0) return null;
  const branch = rest.slice(separator + 1);
  return branch.length > 0 ? branch : null;
}

/**
 * The mobile-enabled sites a signed-in phone watches.
 */
export function sessionSites(session: {
  fences?: readonly GeoFenceSite[] | null;
  geofence?: GeofenceConfig | null;
} | null | undefined): GeoFenceSite[] {
  if (!session) return [];
  if (Array.isArray(session.fences)) {
    return session.fences.filter(isUsableSite);
  }

  const home = session.geofence;
  if (home && home.method !== "Biometric" && hasFence(home) && home.branch) {
    return [
      {
        id: -1,
        branch: home.branch,
        method: home.method,
        latitude: Number(home.latitude),
        longitude: Number(home.longitude),
        radiusMeters: Number(home.radiusMeters),
      },
    ];
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* Formatting (UI)                                                     */
/* ------------------------------------------------------------------ */

/** "142 m" / "1.24 km" */
export function formatDistance(meters: number | null): string {
  if (meters === null || !Number.isFinite(meters)) return "—";
  const m = Math.round(meters);
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(2)} km`;
}

export function formatDwellRemaining(
  enteredAt: number | null,
  now: number = Date.now()
): string | null {
  if (enteredAt === null) return null;
  const remaining = DWELL_MS - (now - enteredAt);
  if (remaining <= 0) return "0:00";
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}
