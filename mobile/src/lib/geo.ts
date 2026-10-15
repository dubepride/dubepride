/**
 * ============================================================================
 *  geo.ts — the geofence maths and the tunable timing constants
 * ============================================================================
 *
 *  Pure module: no React, no Expo, no I/O. Both the background task and the
 *  UI import it, so the fence verdict can never disagree between the two.
 */

import type { GeofenceConfig, GeoFenceSite } from "./types";

/* ------------------------------------------------------------------ */
/* Task names — referenced by the definitions AND by the UI            */
/* ------------------------------------------------------------------ */

/** OS region monitor: an ENTER event only *arms* the dwell candidate. */
export const GEOFENCE_TASK = "biobridge-geofence";
/** Continuous background fixes: where the dwell is actually confirmed. */
export const DWELL_TASK = "biobridge-dwell";

/**
 * Region-id prefix. The OS hands the identifier back on every ENTER/EXIT, so
 * it has to carry both whose fence it is and which branch — that is what lets
 * a background wake-up know where it is standing without a DB round-trip.
 */
export const REGION_PREFIX = "biobridge:";

/* ------------------------------------------------------------------ */
/* Timing + tolerance                                                  */
/* ------------------------------------------------------------------ */

/** The dwell time: the employee must REMAIN inside for this long. */
export const DWELL_MS = 3 * 60 * 1000;

/**
 * How many inside fixes are required before the dwell counts as "still
 * inside". One fix arms the candidate (the ENTER event itself counts), so the
 * value 2 means "we looked again and they were still there" — exactly the
 * spec's "wait 3 minutes, check the location again". Raising it demands a
 * longer unbroken presence; lowering it to 1 removes the continuity proof.
 */
export const DWELL_MIN_SAMPLES = 2;

/**
 * Background fix cadence.
 *
 * The dwell is confirmed on the first fix whose elapsed time already exceeds
 * DWELL_MS, so the *sampling* interval — not DWELL_MS — is what quantises the
 * wall-clock delay. Running two speeds keeps the battery cost of idling low
 * while making the confirmation tight once someone is actually dwelling:
 *
 *   relaxed (idle)    every 120 s  → a punch lands 3:00–5:00 after entry
 *   armed  (dwelling) every  30 s  → a punch lands 3:00–3:30 after entry
 *
 * The ENTER event re-requests the armed cadence; the punch (or leaving the
 * fence) re-requests the relaxed one.
 */
export const LOCATION_INTERVAL_RELAXED_MS = 120_000;
export const LOCATION_INTERVAL_ARMED_MS = 30_000;

/** Don't burn battery reporting near-stationary jitter. */
export const LOCATION_DISTANCE_M = 25;

/**
 * GPS jitter tolerance at the fence edge. A fix whose reported accuracy is
 * worse than the radius is inherently ambiguous, so we let the employee win by
 * this margin — the server re-computes the authoritative distance anyway and
 * records the exact metres on the row.
 */
export const ACCURACY_SLACK_M = 25;

/** Android's Geofence API rejects radii below 100 m. */
export const MIN_ANDROID_REGION_RADIUS_M = 100;

/* ------------------------------------------------------------------ */
/* Distance                                                            */
/* ------------------------------------------------------------------ */

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle distance in metres (Haversine) — the same formula the bridge
 * applies server-side, so a client-side "inside" verdict and the server's
 * recorded Geofence_Distance_Meters agree to the metre.
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

/**
 * The minimum a fence needs to be measurable. Both a `GeofenceConfig` (a site
 * as reported at sign-in) and a `GeoFenceSite` (a site the engine watches)
 * satisfy it, so the maths below has exactly one implementation.
 */
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

/** Jitter allowance: never let a shaky fix cost the employee a punch. */
function slackFor(accuracyMeters?: number | null): number {
  const accuracy = isFiniteNumber(accuracyMeters) ? accuracyMeters : 0;
  return Math.max(0, Math.min(accuracy, ACCURACY_SLACK_M));
}

/**
 * Inside-or-not verdict, with a jitter allowance that scales down as the
 * reported accuracy improves. Never call this from the UI as the final word —
 * the bridge is authoritative; this only decides whether it's worth a request.
 */
export function isInsideFence(
  config: FenceLike | null | undefined,
  latitude: number,
  longitude: number,
  accuracyMeters?: number | null
): boolean {
  const distance = distanceToCentre(config, latitude, longitude);
  if (distance === null) return false;
  return distance <= Number(config!.radiusMeters) + slackFor(accuracyMeters);
}

/**
 * The radius to hand to the OS region monitor. Android refuses anything under
 * 100 m, so a tighter configured radius is registered enlarged — the *verdict*
 * still uses the configured radius, so a 150 m zone behaves as 150 m even
 * though the OS was told 150 m and a 60 m zone is registered at 100 m but
 * judged at 60 m.
 */
export function regionRadiusMeters(config: FenceLike): number {
  const configured = isFiniteNumber(config.radiusMeters) ? config.radiusMeters : 0;
  return Math.max(configured, MIN_ANDROID_REGION_RADIUS_M);
}

/* ------------------------------------------------------------------ */
/* Many sites (Phase 17) — "clock in wherever you are"                  */
/* ------------------------------------------------------------------ */

/** One site plus how far a given fix sits from it. */
export interface SiteMatch {
  site: GeoFenceSite;
  distanceMeters: number;
  withinGeofence: boolean;
}

/** A site is watchable only when its centre and radius are usable. */
function isUsableSite(site: GeoFenceSite | null | undefined): site is GeoFenceSite {
  return !!site && hasFence(site) && typeof site.branch === "string" && site.branch.length > 0;
}

/**
 * Rank every site nearest-first for a fix. Ordering is deterministic — ties
 * fall back to branch name — because a verdict that flapped between two
 * overlapping fences would keep resetting the dwell.
 */
export function rankSites(
  sites: readonly GeoFenceSite[] | null | undefined,
  latitude: number,
  longitude: number,
  accuracyMeters?: number | null
): SiteMatch[] {
  const slack = slackFor(accuracyMeters);
  return (sites ?? [])
    .filter(isUsableSite)
    .map((site) => {
      const distanceMeters = haversineMeters(latitude, longitude, site.latitude, site.longitude);
      return {
        site,
        distanceMeters,
        withinGeofence: distanceMeters <= site.radiusMeters + slack,
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

/**
 * Stable region identifier — one region per employee per site.
 *
 * The branch name is the payload: the OS hands it back on every ENTER/EXIT, so
 * a background wake-up can tell which fence it is standing in without a
 * database round-trip. Parsed back by `branchFromRegionIdentifier`.
 */
export function regionIdentifier(site: GeoFenceSite, employeeId: number): string {
  return `${REGION_PREFIX}${employeeId}:${site.branch}`;
}

/** Recover the branch from a region id, or null when it isn't one of ours. */
export function branchFromRegionIdentifier(identifier: string | null | undefined): string | null {
  if (!identifier || !identifier.startsWith(REGION_PREFIX)) return null;
  const rest = identifier.slice(REGION_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator < 0) return null;
  const branch = rest.slice(separator + 1);
  return branch.length > 0 ? branch : null;
}

/**
 * The sites a signed-in phone should watch (Phase 17).
 *
 * Normally `session.fences` — every registered, mobile-capable, geo-ready site.
 * A session cached by an older build has only its home site, so that is used as
 * the single-site fallback rather than leaving the phone monitoring nothing.
 */
export function sessionSites(session: {
  fences?: readonly GeoFenceSite[] | null;
  geofence?: GeofenceConfig | null;
} | null | undefined): GeoFenceSite[] {
  if (!session) return [];
  const listed = (session.fences ?? []).filter(isUsableSite);
  if (listed.length > 0) return listed;

  const home = session.geofence;
  if (home && hasFence(home) && home.branch) {
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

/** "2:14" — dwell time remaining, for the status card. */
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
