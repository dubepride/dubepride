/**
 * ============================================================================
 *  geofenceTask.ts — the hands-free engine (expo-task-manager + expo-location)
 * ============================================================================
 *
 *  TWO background tasks cooperate. Neither of them is a timer.
 *
 *   1. GEOFENCE_TASK  ("biobridge-geofence")
 *      The OS-level region monitor. An ENTER event only *ARMS* a dwell
 *      candidate. It never sends a punch. An EXIT event ends the visit.
 *
 *   2. DWELL_TASK     ("biobridge-dwell")
 *      Continuous background location fixes. Every fix re-evaluates the armed
 *      candidate; once the employee has been continuously inside for DWELL_MS
 *      (3 minutes) the punch is sent — or queued, if there is no network.
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  WHY A STATE MACHINE AND NOT `setTimeout(180_000)`
 *  ─────────────────────────────────────────────────────────────────────
 *  This is the single most important thing to understand when reviewing the
 *  3-minute dwell, so it is stated plainly:
 *
 *      A background task's JS context is SUSPENDED the moment its callback
 *      resolves. A `setTimeout` scheduled inside the ENTER event therefore
 *      never fires — Android dozes the process and iOS suspends it, and a
 *      headless JS context has no event loop between OS wake-ups.
 *
 *  So "wait 3 minutes, then check again" is implemented as a re-check on the
 *  NEXT background fix the OS delivers, which is exactly what the platform
 *  gives us to work with. The consequence for the *timing* is:
 *
 *      DWELL_MS (180 s) is exact, but the confirmation is QUANTISED by the
 *      fix interval. A punch therefore lands at the first fix whose elapsed
 *      time already exceeds 180 s — never earlier, and later by at most one
 *      interval.
 *
 *  To keep that overshoot small without draining the battery while idling, the
 *  fix cadence runs at two speeds (see geo.ts):
 *
 *      relaxed  every 60 s  · idling, nobody on site
 *      armed    every 30 s  · someone is dwelling → punch lands 3:00–3:30
 *
 *  The ENTER event re-requests the armed cadence; the punch (or leaving the
 *  site) re-requests the relaxed one.
 *
 *  Every fix ALSO feeds the Field Tracker heartbeat, even when no geofence is
 *  configured. That heartbeat is latest-position-only, works offline (the last
 *  fix is kept on the device), and stops only when the employee signs out.
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  THE OTHER TWO RULES THAT MATTER
 *  ─────────────────────────────────────────────────────────────────────
 *   · ONE PUNCH PER VISIT. The dwell record is marked `firedAt` and is only
 *     cleared when the employee leaves the fence. Without that, a stationary
 *     employee would punch again every ~3 minutes and the bridge (which infers
 *     IN/OUT from the punch sequence) would record nonsense.
 *   · CLAIM BEFORE YOU SEND. `firedAt` is written BEFORE the network call, so
 *     an overlapping wake-up can never double-fire.
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  ANY REGISTERED SITE, NOT JUST THE ROSTER BRANCH
 *  ─────────────────────────────────────────────────────────────────────
 *  An employee may travel, so the engine watches EVERY registered site the
 *  sign-in returned, not merely the branch on their employee record. One OS
 *  region is registered per site (`regionIdentifier` names it, so an ENTER
 *  wake-up knows which fence was crossed without a round-trip), and every fix
 *  is matched against the whole list (`activeSite`).
 *
 *  Which site a punch belongs to is decided by the BRIDGE from the
 *  coordinates — the phone never sends a branch, so it cannot claim one it is
 *  not standing in. Locally the engine only needs the answer to know when a
 *  visit has moved from one site to another (that resets the visit).
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  ANDROID / iOS CAVEATS
 *  ─────────────────────────────────────────────────────────────────────
 *   · Android refuses geofence radii below 100 m, so the registered region is
 *     `max(configured, 100)`. The *verdict* always uses the configured radius
 *     and the real Haversine distance, so a small zone still behaves small.
 *   · Continuous background location needs a foreground service on Android 14+
 *     (declared via the expo-location plugin in app.json) and the "Always"
 *     location permission on both platforms. Neither works in Expo Go — this
 *     feature requires a native dev build (`npx expo run:android`).
 *   · The bridge re-computes the distance server-side and records the exact
 *     metres on the row, so a client-side rounding choice can never change the
 *     attendance outcome.
 */

import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";

import {
  DWELL_MIN_SAMPLES,
  DWELL_MS,
  DWELL_TASK,
  GEOFENCE_TASK,
  LOCATION_INTERVAL_ARMED_MS,
  LOCATION_INTERVAL_RELAXED_MS,
  activeSite,
  branchFromRegionIdentifier,
  distanceToCentre,
  isInsideFence,
  nearestSite,
  regionIdentifier,
  regionRadiusMeters,
  sessionSites,
} from "@/lib/geo";
import { deliverPresence } from "@/lib/presence";
import { getNativeLocationInfo, isIgnoringBatteryOptimizations } from "@/lib/nativeLocation";
import {
  clearDwell,
  clearPendingPresence,
  readDwell,
  readLastPresence,
  readSession,
  writeDwell,
} from "@/lib/storage";
import { COLORS } from "@/theme";
import type { DwellState, GeoFenceSite, MobileSession, PresencePayload } from "@/lib/types";

export { DWELL_TASK, GEOFENCE_TASK };

/** Background logs surface via `adb logcat | grep ReactNativeJS`. */
const LOG_PREFIX = "[biobridge:geofence]";

/**
 * The browser (`npm run web`) has no background-task or geofencing support.
 * TaskManager.defineTask would throw at import time and take the whole app
 * down, so registration and the tracking entry points are disabled there.
 * The UI still renders for design review; hands-free clocking is device-only.
 */
const IS_WEB = Platform.OS === "web";

function log(...args: unknown[]): void {
  console.log(LOG_PREFIX, ...args);
}

/* ------------------------------------------------------------------ */
/* Permission + device health                                          */
/* ------------------------------------------------------------------ */

export type LocationPrecision = "fine" | "coarse" | "none";
export type BackgroundPermission = "always" | "while-using" | "denied" | "unknown";

export interface LocationAccess {
  /** True only for precise (fine) location. Coarse is deliberately not enough. */
  granted: boolean;
  precision: LocationPrecision;
  background: BackgroundPermission;
  servicesEnabled: boolean;
}

/**
 * A single, consistent reading of Android location permission state.
 *
 * Android 12+ lets the user grant only "Approximate" location. The stock
 * expo-location response says that permission is GRANTED, which is why the old
 * code started tracking happily and then produced kilometre-level fixes that
 * could never match a geofence. Precision is therefore part of the contract.
 */
export async function getLocationAccess(): Promise<LocationAccess> {
  if (IS_WEB) {
    return { granted: false, precision: "none", background: "denied", servicesEnabled: false };
  }

  const [foreground, background, servicesEnabled] = await Promise.all([
    Location.getForegroundPermissionsAsync().catch(() => null),
    Location.getBackgroundPermissionsAsync().catch(() => null),
    Location.hasServicesEnabledAsync().catch(() => false),
  ]);

  let precision: LocationPrecision = "none";
  if (foreground?.status === Location.PermissionStatus.GRANTED) {
    // `android.accuracy` is "coarse" when the user denied precise access.
    precision = foreground.android?.accuracy === "coarse" ? "coarse" : "fine";
  }

  let backgroundState: BackgroundPermission = "unknown";
  if (foreground?.status === Location.PermissionStatus.GRANTED) {
    backgroundState =
      background?.status === Location.PermissionStatus.GRANTED ? "always" : "while-using";
  } else {
    backgroundState = "denied";
  }

  return {
    granted: precision === "fine",
    precision,
    background: backgroundState,
    servicesEnabled,
  };
}

/**
 * Ask for background location when the employee explicitly taps the guidance
 * button. Never call this silently: on Android 11+ it leaves the app for
 * Settings, which used to interrupt tracking start-up.
 */
export async function requestBackgroundLocationPermission(): Promise<{
  granted: boolean;
  access: LocationAccess;
}> {
  if (IS_WEB) {
    return { granted: false, access: await getLocationAccess() };
  }
  try {
    const precise = await ensureForegroundLocationPermission();
    if (!precise) {
      return { granted: false, access: await getLocationAccess() };
    }
    const asked = await Location.requestBackgroundPermissionsAsync().catch(() => null);
    const access = await getLocationAccess();
    return {
      granted: asked?.status === Location.PermissionStatus.GRANTED || access.background === "always",
      access,
    };
  } catch {
    return { granted: false, access: await getLocationAccess() };
  }
}

export interface LocationDiagnostics {
  access: LocationAccess;
  providers: {
    gps: boolean;
    network: boolean;
    passive: boolean;
  } | null;
  trackingActive: boolean;
  fixAgeMs: number | null;
  fixAccuracyMeters: number | null;
  nativeMarker: string | null;
  nativeFallback: boolean;
  manufacturer: string | null;
  model: string | null;
  androidSdk: number | null;
  googlePlayServices: boolean | null;
  batteryOptimized: boolean | null;
  lastPresence: {
    status: string;
    at: number;
    accuracyMeters: number | null;
    branch: string | null;
  } | null;
}

/** Everything the dashboard needs to explain why a phone is not sharing. */
export async function getLocationDiagnostics(): Promise<LocationDiagnostics> {
  const [access, trackingActive, nativeInfo, batteryOptimized, lastPresence] =
    await Promise.all([
      getLocationAccess(),
      isTrackingActive(),
      getNativeLocationInfo(),
      isIgnoringBatteryOptimizations(),
      readLastPresence(),
    ]);

  let providers: LocationDiagnostics["providers"] = null;
  try {
    const status = await Location.getProviderStatusAsync();
    providers = {
      gps: Boolean(status.gpsAvailable),
      network: Boolean(status.networkAvailable),
      passive: Boolean(status.passiveAvailable),
    };
  } catch {
    providers = null;
  }

  let fixAgeMs: number | null = null;
  let fixAccuracyMeters: number | null = null;
  try {
    const last = await Location.getLastKnownPositionAsync({
      maxAge: 24 * 60 * 60 * 1_000,
      requiredAccuracy: 100_000,
    });
    if (last) {
      fixAgeMs = Math.max(0, Date.now() - (last.timestamp ?? 0));
      fixAccuracyMeters = last.coords.accuracy ?? null;
    }
  } catch {
    /* no cached fix */
  }

  return {
    access,
    providers,
    trackingActive,
    fixAgeMs,
    fixAccuracyMeters,
    nativeMarker: nativeInfo?.marker ?? null,
    nativeFallback: nativeInfo?.nativeFallback ?? false,
    manufacturer: nativeInfo?.manufacturer ?? null,
    model: nativeInfo?.model ?? null,
    androidSdk: nativeInfo?.sdk ?? null,
    googlePlayServices: nativeInfo?.googlePlayServices ?? null,
    batteryOptimized: batteryOptimized === null ? null : !batteryOptimized,
    lastPresence: lastPresence ?? null,
  };
}


/* ------------------------------------------------------------------ */
/* Task payloads                                                       */
/*                                                                     */
/* expo-location does not export typed task-data shapes, so the two     */
/* callbacks are typed from the documented contract:                    */
/*   geofencing → { eventType, region }                                 */
/*   location   → { locations: LocationObject[] }                       */
/* ------------------------------------------------------------------ */

interface GeofencingTaskPayload {
  eventType: Location.LocationGeofencingEventType;
  region: Location.LocationRegion;
}

interface LocationFixPayload {
  locations: Location.LocationObject[];
}

/* ------------------------------------------------------------------ */
/* 1. The region monitor — ARMS the dwell, never punches                */
/* ------------------------------------------------------------------ */

if (!IS_WEB && !TaskManager.isTaskDefined(GEOFENCE_TASK)) {
  TaskManager.defineTask<GeofencingTaskPayload>(GEOFENCE_TASK, async ({ data, error }) => {
    if (error) {
      log("region task error:", error.message);
      return;
    }
    if (!data) return;

    const entering = data.eventType === Location.GeofencingEventType.Enter;
    const identifier = data.region?.identifier ?? null;
    log(`region ${entering ? "ENTER" : "EXIT"} ${identifier ?? ""}`);

    try {
      await onRegionEvent(entering, identifier);
    } catch (err) {
      log("region handler failed:", err instanceof Error ? err.message : err);
    }
  });
}

/**
 * ARRIVING only ever ARMS a candidate — nothing leaves the device here, which
 * is the whole point of the dwell: arriving is not the same as staying.
 *
 * `identifier` is the region id from `regionIdentifier()`; it names the branch
 * whose fence was crossed. With several fences registered at once, that is how
 * a wake-up knows *where* it is standing without a database round-trip.
 */
async function onRegionEvent(entering: boolean, identifier: string | null): Promise<void> {
  const branch = branchFromRegionIdentifier(identifier);

  if (!entering) {
    // Leaving a site ends the visit — but only when it is the visit in
    // progress. With many fences registered, an EXIT from a neighbouring site
    // must not cancel a dwell that is running somewhere else.
    const state = await readDwell();
    if (state && (!branch || state.branch === branch)) {
      log(`left ${branch ?? "the site"} — visit ended, dwell reset`);
      await clearDwell();
      await requestCadence("relaxed");
    }
    return;
  }

  const session = await readSession();
  if (!session) return;

  const site = sessionSites(session).find((candidate) => candidate.branch === branch) ?? null;
  if (!site) return; // a fence this session no longer cares about

  const state = await readDwell();
  if (state?.firedAt) return; // already clocked on this visit

  if (!state) {
    await armDwell(site, 1, null);
    log(`armed dwell at ${site.branch} — punch due in ${DWELL_MS / 1000}s`);
    return;
  }

  // A dwell is already running for a DIFFERENT site: the employee has arrived
  // at another branch while one visit was in progress. Start that visit fresh
  // rather than letting the old one punch against the wrong fence.
  if (state.branch && state.branch !== site.branch) {
    await armDwell(site, 1, null);
    log(`arrived at ${site.branch} — restarted the visit (was ${state.branch})`);
  }
}

/**
 * Write a fresh, un-fired dwell for one site and switch to the armed cadence.
 * The ENTER path has no fix yet, so the coordinates are optional.
 */
async function armDwell(
  site: GeoFenceSite,
  samples: number,
  fix: { latitude: number; longitude: number } | null
): Promise<void> {
  await writeDwell({
    branch: site.branch,
    enteredAt: Date.now(),
    lastFixAt: fix ? Date.now() : null,
    latitude: fix?.latitude ?? null,
    longitude: fix?.longitude ?? null,
    samples,
    firedAt: null,
    outcome: null,
    outcomeMessage: null,
  });
  await requestCadence("armed");
}

/* ------------------------------------------------------------------ */
/* 2. The fix stream — CONFIRMS the dwell and punches                   */
/* ------------------------------------------------------------------ */

if (!IS_WEB && !TaskManager.isTaskDefined(DWELL_TASK)) {
  TaskManager.defineTask<LocationFixPayload>(DWELL_TASK, async ({ data, error }) => {
    if (error) {
      log("location task error:", error.message);
      return;
    }
    const fixes = data?.locations ?? [];
    const latest = fixes[fixes.length - 1];
    if (!latest) return;

    try {
      await onFix(latest);
    } catch (err) {
      log("fix handler failed:", err instanceof Error ? err.message : err);
    }
  });
}

/** Guards against two overlapping fixes racing into a double punch. */
let evaluating = false;

/**
 * Field Tracker heartbeat: the app reports the latest fix while signed in, so
 * the web map can show where each phone is. Latest-only, so it is throttled to
 * one report per fix cadence; a missed report is stored on the device and
 * flushed when connectivity returns. Reporting never blocks or aborts the
 * punch state machine.
 */
const PRESENCE_REPORT_MS = 30_000;
let lastPresenceAt = 0;

/** Build the latest-position heartbeat for one fix. */
function presencePayload(
  session: MobileSession,
  fix: Location.LocationObject
): PresencePayload {
  const { latitude, longitude, accuracy } = fix.coords;
  const nearest = nearestSite(sessionSites(session), latitude, longitude);
  return {
    employeeRef: session.employee.erpUserId,
    latitude,
    longitude,
    accuracyMeters: accuracy,
    branch: nearest?.site.branch ?? null,
    timestamp: fix.timestamp ?? Date.now(),
    deviceId: session.deviceId ?? null,
    deviceName: session.deviceName ?? null,
  };
}

async function sendPresenceFix(
  session: MobileSession,
  fix: Location.LocationObject
): Promise<Awaited<ReturnType<typeof deliverPresence>>> {
  return deliverPresence(
    { apiUrl: session.apiUrl, mobileKey: session.mobileKey },
    presencePayload(session, fix)
  );
}

async function onFix(fix: Location.LocationObject): Promise<void> {
  if (evaluating) return;
  evaluating = true;
  try {
    const session = await readSession();
    if (!session) return;

    const { latitude, longitude, accuracy } = fix.coords;
    const sites = sessionSites(session);
    const now = Date.now();

    // ── Field Tracker heartbeat (signed in, in the background) ────────
    // Sent even when no fence is configured — the office still benefits from
    // seeing the phone. `deliverPresence` queues the fix if we are offline.
    if (now - lastPresenceAt >= PRESENCE_REPORT_MS) {
      lastPresenceAt = now;
      await sendPresenceFix(session, fix);
    }

    // The dwell/punch state machine only makes sense when at least one
    // registered fence exists; the heartbeat above already went out.
    if (sites.length === 0) return;

    // The site this fix lands in. The bridge re-derives the same answer and is
    // the final word — but the dwell needs it to know where "here" is, and to
    // notice when the employee has moved to a different branch.
    const match = activeSite(sites, latitude, longitude, accuracy);
    const state = await readDwell();

    // ── Outside every registered site ─────────────────────────────────
    if (!match) {
      if (state) {
        const nearest = nearestSite(sites, latitude, longitude);
        log(
          `left every registered site${
            nearest ? ` (nearest ${nearest.site.branch}, ${Math.round(nearest.distanceMeters)} m)` : ""
          } — visit ended, dwell reset`
        );
        await clearDwell();
        await requestCadence("relaxed");
      }
      return;
    }

    // ── Inside a site, but nothing armed yet ──────────────────────────
    // Happens when the app is opened on site, or when the OS region monitor
    // never fired. Arm here so hands-free clocking still works.
    if (!state) {
      await armDwell(match.site, 1, { latitude, longitude });
      log(`armed dwell at ${match.site.branch} from a fix (no ENTER event seen)`);
      return;
    }

    // ── Did the employee move to another branch mid-visit? ────────────
    // Keep the visit in progress for as long as the fix is still inside *its*
    // site — that is what stops a walk between two overlapping fences from
    // resetting a dwell that is nearly complete.
    const current = state.branch
      ? sites.find((candidate) => candidate.branch === state.branch) ?? null
      : null;
    if (state.branch && !(current && isInsideFence(current, latitude, longitude, accuracy))) {
      log(`moved from ${state.branch} to ${match.site.branch} — new visit`);
      await armDwell(match.site, 1, { latitude, longitude });
      return;
    }
    const site = current ?? match.site;

    if (state.firedAt) return; // one punch per visit

    // ── Still inside: has the dwell elapsed? ──────────────────────────
    const samples = state.samples + 1;
    const elapsedMs = Date.now() - state.enteredAt;
    const dwellSatisfied = elapsedMs >= DWELL_MS && samples >= DWELL_MIN_SAMPLES;

    if (!dwellSatisfied) {
      await writeDwell({
        ...state,
        branch: site.branch,
        lastFixAt: Date.now(),
        latitude,
        longitude,
        samples,
      });
      const metres = distanceToCentre(site, latitude, longitude);
      log(
        `dwelling at ${site.branch} ${Math.round(elapsedMs / 1000)}s / ${DWELL_MS / 1000}s ` +
          `(${samples} fixes, ${metres === null ? "?" : Math.round(metres)} m from centre)`
      );
      return;
    }

    // Auto-clocking is disabled by product policy.
    // The employee clocks in/out themselves using the button on the app.
    return;
  } finally {
    evaluating = false;
  }
}

/** Record what happened, without disturbing the firedAt lock. */
async function patchOutcome(
  outcome: NonNullable<DwellState["outcome"]>,
  message: string
): Promise<void> {
  const state = await readDwell();
  if (!state) return;
  await writeDwell({ ...state, outcome, outcomeMessage: message });
}

/* ------------------------------------------------------------------ */
/* Cadence control                                                     */
/* ------------------------------------------------------------------ */

/**
 * Module-scoped so repeated re-requests within one wake-up are skipped. It is
 * deliberately NOT treated as authoritative: a headless context starts with
 * this null, so the first call after each boot re-requests the interval it
 * needs. Re-requesting is an optimisation, never a requirement.
 */
let cadence: "armed" | "relaxed" | null = null;

function locationOptions(speed: "armed" | "relaxed"): Location.LocationTaskOptions {
  return {
    accuracy: Location.Accuracy.High,
    timeInterval:
      speed === "armed" ? LOCATION_INTERVAL_ARMED_MS : LOCATION_INTERVAL_RELAXED_MS,
    // distanceInterval 0 is deliberate: the Field Tracker needs a fresh fix
    // on a timer even when the employee is standing still. With a minimum
    // distance, Huawei (and several OEM skins) can withhold every update while
    // stationary, leaving the office map showing a stale position.
    distanceInterval: 0,
    // We must keep receiving fixes while stationary — the dwell check depends
    // on the clock, not on movement.
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    activityType: Location.ActivityType.Other,
    foregroundService: {
      notificationTitle: "BioBridge location sharing is on",
      notificationBody: "Sharing your work location with your employer while you are signed in.",
      notificationColor: COLORS.neon,
      // Keep the service alive when the task is swiped away — otherwise
      // location sharing would stop exactly when the app isn't open.
      killServiceOnDestroy: false,
    },
  };
}

/** Switch the background fix cadence. Never throws into a background task. */
async function requestCadence(next: "armed" | "relaxed"): Promise<void> {
  if (cadence === next) return;
  try {
    // Never START the stream from the background — only re-tune a running one.
    if (!(await Location.hasStartedLocationUpdatesAsync(DWELL_TASK))) return;
    await Location.startLocationUpdatesAsync(DWELL_TASK, locationOptions(next));
    cadence = next;
    log(`fix cadence → ${next}`);
  } catch (err) {
    // Worst case we keep the previous interval, which only costs resolution.
    log("cadence change failed:", err instanceof Error ? err.message : err);
  }
}

/* ------------------------------------------------------------------ */
/* Foreground control (called by the app, not by the OS)               */
/* ------------------------------------------------------------------ */

export type TrackingReason =
  | "active"
  | "no-fence"
  | "no-employee"
  | "location-off"
  | "permission-denied"
  | "permission-coarse"
  | "error";

export interface TrackingResult {
  ok: boolean;
  reason: TrackingReason;
  message: string;
}

/**
 * Ask for the permissions this feature needs and start both background tasks.
 * Called on sign-in, on session restore, and from the dashboard's retry.
 */
let inflightPermissionPromise: Promise<boolean> | null = null;

/**
 * Single-flight foreground permission helper so Dashboard, useGeofenceStatus,
 * and startGeofenceTracking never launch competing Android permission dialogs.
 */
export async function ensureForegroundLocationPermission(): Promise<boolean> {
  if (IS_WEB) return false;
  try {
    const existing = await Location.getForegroundPermissionsAsync().catch(() => null);
    if (existing?.status === Location.PermissionStatus.GRANTED) {
      // Approximate location is not enough for a geofence punch. Returning
      // false here lets the UI explain the fix instead of silently starting a
      // stream that will never be accurate enough.
      return existing.android?.accuracy !== "coarse";
    }
  } catch {}

  if (inflightPermissionPromise) {
    return inflightPermissionPromise;
  }

  inflightPermissionPromise = (async () => {
    try {
      const asked = await Location.requestForegroundPermissionsAsync().catch(() => null);
      return (
        asked?.status === Location.PermissionStatus.GRANTED &&
        asked.android?.accuracy !== "coarse"
      );
    } finally {
      inflightPermissionPromise = null;
    }
  })();

  return inflightPermissionPromise;
}

export async function startGeofenceTracking(
  session: MobileSession | null
): Promise<TrackingResult> {
  if (!session) {
    return { ok: false, reason: "no-employee", message: "Sign in to start location sharing." };
  }
  const sites = sessionSites(session);

  if (IS_WEB) {
    return {
      ok: false,
      reason: "error",
      message: "Background location sharing runs only on a phone — this browser preview shows the UI only.",
    };
  }

  try {
    // 1. Foreground permission + precision first via the single-flight helper.
    //    "Approximate" is rejected: it is technically granted but its fixes
    //    are far too imprecise for a geofence punch.
    let access = await getLocationAccess();
    if (access.precision === "coarse") {
      return {
        ok: false,
        reason: "permission-coarse",
        message:
          "Location is set to Approximate on this phone. Open Settings → Apps → BioBridge → Permissions → Location and choose Precise, then retry.",
      };
    }
    if (!access.granted) {
      const granted = await ensureForegroundLocationPermission();
      access = await getLocationAccess();
      if (!granted || !access.granted) {
        if (access.precision === "coarse") {
          return {
            ok: false,
            reason: "permission-coarse",
            message:
              "Location is set to Approximate on this phone. Open Settings → Apps → BioBridge → Permissions → Location and choose Precise, then retry.",
          };
        }
        return {
          ok: false,
          reason: "permission-denied",
          message: "Location permission is required to verify you are on site.",
        };
      }
    }

    // 2. Check provider/services switch AFTER foreground permission is obtained.
    const servicesOn = await Location.hasServicesEnabledAsync().catch(() => true);
    if (!servicesOn) {
      return {
        ok: false,
        reason: "location-off",
        message: "Turn on Location/GPS in your phone Settings to share your work location.",
      };
    }

    // 3. Background permission is optional for a location foreground service,
    // but "Allow all the time" is what keeps Huawei/Honor from freezing the
    // app, and it is required for OS region monitoring. We never redirect the
    // user to Settings here — the dashboard offers that as an explicit action.
    const backgroundGranted = access.background === "always";

    // 4. Region monitoring is the fast path (the OS wakes us on arrival)
    // when background permission is granted and GMS is available.
    if (sites.length > 0 && backgroundGranted) {
      try {
        await Location.startGeofencingAsync(
          GEOFENCE_TASK,
          sites.map((site) => ({
            identifier: regionIdentifier(site, session.employee.employeeId),
            latitude: site.latitude,
            longitude: site.longitude,
            radius: regionRadiusMeters(site),
            notifyOnEnter: true,
            notifyOnExit: true,
          }))
        );
      } catch (err) {
        // Non-fatal: the fix stream below still detects arrival within one
        // interval, just without the immediate ENTER wake-up.
        log("region monitoring unavailable:", err instanceof Error ? err.message : err);
      }
    } else {
      // A fence may have been removed on the web app. Drop any stale region
      // registration so the OS isn't watching a site this session no longer
      // has, while the fix stream keeps the Field Tracker fed.
      try {
        if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK)) {
          await Location.stopGeofencingAsync(GEOFENCE_TASK);
        }
      } catch {
        /* nothing registered */
      }
    }

    let started = false;
    try {
      await Location.startLocationUpdatesAsync(DWELL_TASK, locationOptions("relaxed"));
      cadence = "relaxed";
      started = await isTrackingActive();
    } catch (bgErr) {
      log("background location updates unavailable on this device:", bgErr instanceof Error ? bgErr.message : bgErr);
    }

    if (!started) {
      return {
        ok: false,
        reason: "error",
        message:
          "Background location could not start on this phone. Open Settings → Apps → BioBridge and allow Location all the time, then exempt BioBridge from battery optimisation and retry.",
      };
    }

    const backgroundNote = backgroundGranted
      ? ""
      : " For reliable sharing with the screen off, set Location permission to Allow all the time.";

    return {
      ok: true,
      reason: "active",
      message:
        sites.length === 0
          ? `Sharing your location while signed in — no geofenced site is configured yet, but the Field Tracker still receives this phone.${backgroundNote}`
          : `Sharing your location while signed in — ${sites.length} registered site${
              sites.length === 1 ? "" : "s"
            }.${backgroundNote}`,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "error",
      message: err instanceof Error ? err.message : "Could not start geofence tracking.",
    };
  }
}

/** Stop both tasks and forget the current visit. Safe to call when not running. */
export async function stopGeofenceTracking(): Promise<void> {
  cadence = null;
  await clearDwell();
  // A queued Field Tracker fix belongs to a signed-in employee; signing out
  // must never let it be uploaded afterwards.
  await clearPendingPresence();
  try {
    if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK)) {
      await Location.stopGeofencingAsync(GEOFENCE_TASK);
    }
  } catch {
    /* not running */
  }
  try {
    if (await Location.hasStartedLocationUpdatesAsync(DWELL_TASK)) {
      await Location.stopLocationUpdatesAsync(DWELL_TASK);
    }
  } catch {
    /* not running */
  }
}

/** Is the background fix stream currently running? */
export async function isTrackingActive(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(DWELL_TASK);
  } catch {
    return false;
  }
}

/**
 * Called when the app returns to the foreground and by the dashboard's
 * periodic health check. If the OS (or Huawei's power manager) silently killed
 * the task, this restarts it instead of leaving the Field Tracker stale until
 * the employee happens to sign out and back in.
 */
export async function ensureTrackingHealth(
  session: MobileSession | null
): Promise<TrackingResult> {
  if (!session) {
    return { ok: false, reason: "no-employee", message: "Sign in to start location sharing." };
  }
  if (await isTrackingActive()) {
    return {
      ok: true,
      reason: "active",
      message: "Sharing your location while signed in.",
    };
  }
  log("background fix stream was not running — restarting");
  return startGeofenceTracking(session);
}

export interface LocateNowResult {
  ok: boolean;
  message: string;
  delivery: "sent" | "queued" | "stale" | "rejected" | null;
  accuracyMeters: number | null;
  latitude: number | null;
  longitude: number | null;
}

/**
 * "Locate now" — force one high-accuracy fix and publish it immediately.
 * Gives the employee (and the office) a deterministic recovery action without
 * waiting for the next background interval.
 */
export async function locateAndShareNow(
  session: MobileSession | null
): Promise<LocateNowResult> {
  if (!session) {
    return {
      ok: false,
      message: "Sign in to share your location.",
      delivery: null,
      accuracyMeters: null,
      latitude: null,
      longitude: null,
    };
  }

  if (IS_WEB) {
    return {
      ok: false,
      message: "Live location is only available in the phone app.",
      delivery: null,
      accuracyMeters: null,
      latitude: null,
      longitude: null,
    };
  }

  const access = await getLocationAccess();
  if (access.precision === "coarse") {
    return {
      ok: false,
      message:
        "Location is set to Approximate. Open Settings → Apps → BioBridge → Permissions → Location and choose Precise.",
      delivery: null,
      accuracyMeters: null,
      latitude: null,
      longitude: null,
    };
  }
  if (!access.granted) {
    const granted = await ensureForegroundLocationPermission();
    if (!granted) {
      return {
        ok: false,
        message: "Location permission is needed to locate this phone.",
        delivery: null,
        accuracyMeters: null,
        latitude: null,
        longitude: null,
      };
    }
  }

  const tryFix = async (
    accuracy: Location.Accuracy
  ): Promise<Location.LocationObject | null> => {
    try {
      return await Location.getCurrentPositionAsync({
        accuracy,
        mayShowUserSettingsDialog: false,
      });
    } catch {
      return null;
    }
  };

  let fix = await tryFix(Location.Accuracy.High);
  if (!fix) fix = await tryFix(Location.Accuracy.Balanced);
  if (!fix) {
    try {
      fix = await Location.getLastKnownPositionAsync({ maxAge: 120_000 });
    } catch {
      fix = null;
    }
  }

  if (!fix) {
    return {
      ok: false,
      message:
        "No GPS fix yet. Step near a window or outdoors, check that Location is on, then tap Locate now again.",
      delivery: null,
      accuracyMeters: null,
      latitude: null,
      longitude: null,
    };
  }

  lastPresenceAt = Date.now();
  const delivery = await sendPresenceFix(session, fix);
  const accuracyMeters = fix.coords.accuracy ?? null;

  const message =
    delivery === "sent"
      ? `Location sent to the Field Tracker${
          accuracyMeters === null ? "" : ` (± ${Math.round(accuracyMeters)} m)`
        }.`
      : delivery === "queued"
        ? "No internet — the location is saved on this phone and will upload automatically."
        : delivery === "rejected"
          ? "The office rejected this location. Check that this phone is still bound to your employee profile."
          : "The fix was too old to publish. Tap Locate now again.";

  return {
    ok: delivery === "sent",
    message,
    delivery,
    accuracyMeters,
    latitude: fix.coords.latitude,
    longitude: fix.coords.longitude,
  };
}
