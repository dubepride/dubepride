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
 *      relaxed  every 120 s  · idling, nobody on site
 *      armed    every  30 s  · someone is dwelling → punch lands 3:00–3:30
 *
 *  The ENTER event re-requests the armed cadence; the punch (or leaving the
 *  site) re-requests the relaxed one.
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

import { sendOrQueue } from "@/lib/api";
import {
  DWELL_MIN_SAMPLES,
  DWELL_MS,
  DWELL_TASK,
  GEOFENCE_TASK,
  LOCATION_DISTANCE_M,
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
import { clearDwell, readDwell, readSession, writeDwell } from "@/lib/storage";
import { COLORS } from "@/theme";
import type { DwellState, GeoFenceSite, GeoPunchPayload, MobileSession } from "@/lib/types";

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

async function onFix(fix: Location.LocationObject): Promise<void> {
  if (evaluating) return;
  evaluating = true;
  try {
    const session = await readSession();
    if (!session) return;

    const sites = sessionSites(session);
    if (sites.length === 0) return;

    const { latitude, longitude, accuracy } = fix.coords;
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

    // ── Dwell satisfied → punch ───────────────────────────────────────
    // Stamp `firedAt` FIRST: this is the optimistic lock that makes a
    // duplicate impossible even if the OS wakes us twice.
    await writeDwell({
      ...state,
      branch: site.branch,
      lastFixAt: Date.now(),
      latitude,
      longitude,
      samples,
      firedAt: Date.now(),
    });

    const payload: GeoPunchPayload = {
      employeeRef: session.employee.erpUserId,
      latitude,
      longitude,
      accuracyMeters: accuracy === null ? null : Math.round(accuracy),
      // NO branchRef (Phase 17): the bridge matches the coordinates against
      // every registered site and decides where this punch happened, so the
      // phone cannot claim a branch it is not standing in.
      //
      // The punch time is NOW — the moment the dwell completed — and this is
      // the timestamp the offline queue must preserve verbatim.
      timestamp: Date.now(),
    };

    log(`dwell complete at ${site.branch} after ${Math.round(elapsedMs / 1000)}s — sending punch`);

    try {
      const dispatch = await sendOrQueue(session, payload);
      if (dispatch.queued) {
        log("no network — punch queued on the device");
        await patchOutcome("Queued", dispatch.message);
      } else {
        log(`punch accepted: ${dispatch.message}`);
        await patchOutcome("Sent", dispatch.message);
      }
    } catch (err) {
      // A policy rejection (wrong branch, mobile clocking switched off since
      // sign-in…). Nothing to queue — the bridge has already answered.
      const message = err instanceof Error ? err.message : "Punch rejected";
      log("punch rejected:", message);
      await patchOutcome("Rejected", message);
    } finally {
      await requestCadence("relaxed");
    }
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
    accuracy: Location.Accuracy.Balanced,
    timeInterval:
      speed === "armed" ? LOCATION_INTERVAL_ARMED_MS : LOCATION_INTERVAL_RELAXED_MS,
    distanceInterval: LOCATION_DISTANCE_M,
    // We must keep receiving fixes while stationary — the dwell check depends
    // on the clock, not on movement.
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    activityType: Location.ActivityType.Other,
    foregroundService: {
      notificationTitle: "BIOBRIDGE clocking is on",
      notificationBody: "Watching registered sites so you can be clocked in hands-free.",
      notificationColor: COLORS.neon,
      // Keep the service alive when the task is swiped away — otherwise
      // hands-free clocking would stop exactly when the app isn't open.
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
export async function startGeofenceTracking(
  session: MobileSession | null
): Promise<TrackingResult> {
  if (!session) {
    return { ok: false, reason: "no-employee", message: "Sign in to start hands-free clocking." };
  }
  // Phase 17 — the phone watches EVERY registered site, not just the
  // employee's roster branch: an employee may travel, and the punch is judged
  // against whichever fence they are physically inside.
  const sites = sessionSites(session);
  if (sites.length === 0) {
    return {
      ok: false,
      reason: "no-fence",
      message:
        "No branch has mobile clocking set up yet — use the manual button or the fingerprint terminal.",
    };
  }

  if (IS_WEB) {
    return {
      ok: false,
      reason: "error",
      message: "Hands-free clocking runs only on a phone — this browser preview shows the UI only.",
    };
  }

  try {
    if (!(await Location.hasServicesEnabledAsync())) {
      return {
        ok: false,
        reason: "location-off",
        message: "Turn on Location Services to use hands-free clocking.",
      };
    }

    // Foreground permission first — Android refuses to even prompt for
    // background access until foreground is granted.
    let foreground = await Location.getForegroundPermissionsAsync();
    if (foreground.status !== Location.PermissionStatus.GRANTED) {
      foreground = await Location.requestForegroundPermissionsAsync();
    }
    if (foreground.status !== Location.PermissionStatus.GRANTED) {
      return {
        ok: false,
        reason: "permission-denied",
        message: "Location permission is required to verify you are on site.",
      };
    }

    let background = await Location.getBackgroundPermissionsAsync();
    if (background.status !== Location.PermissionStatus.GRANTED) {
      background = await Location.requestBackgroundPermissionsAsync();
    }
    if (background.status !== Location.PermissionStatus.GRANTED) {
      return {
        ok: false,
        reason: "permission-denied",
        message: 'Set location access to "Allow all the time" for automatic clocking.',
      };
    }

    // Region monitoring is the fast path (the OS wakes us on arrival), one
    // region per registered site. Its radius is clamped because Android
    // rejects anything under 100 m — the verdict itself still uses the
    // configured radius. Android caps a single app at 100 regions, far above
    // any realistic branch list; if registration is ever refused the fix
    // stream below still detects arrival within one interval.
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

    await Location.startLocationUpdatesAsync(DWELL_TASK, locationOptions("relaxed"));
    cadence = "relaxed";

    return {
      ok: true,
      reason: "active",
      message: `Watching ${sites.length} registered site${sites.length === 1 ? "" : "s"} — clock in wherever you are.`,
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
