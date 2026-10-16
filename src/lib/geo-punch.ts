/**
 * ============================================================================
 *  geo-punch.ts — the geofenced punch policy engine (Phase 18)
 * ============================================================================
 *
 *  The single implementation of "is this GPS fix allowed to punch, and where?"
 *  shared by BOTH ingress routes so the two can never disagree:
 *
 *    • POST /api/attendance/geopunch     — device/mobile ingress (companion
 *                                          app, `x-mobile-key`, or an admin
 *                                          session). Identity comes from the
 *                                          request body.
 *    • POST /api/my-portal/geopunch      — the signed-in employee's browser
 *                                          self-clock. Identity comes from the
 *                                          SESSION, never the body.
 *
 *  Everything security-relevant lives here and depends on NOTHING from Next:
 *
 *    1. Resolve the governing site — an explicit device, a strict `branchRef`,
 *       or (the travelling employee's normal path) the GPS fix matched against
 *       every registered mobile-capable site.
 *    2. Refuse a biometric-only site outright.
 *    3. Refuse a site with no usable centre/radius.
 *    4. Haversine distance + verdict.
 *    5. Inside  → ordinary Pending punch for the ERP sync engine.
 *       Outside → an auditable Denied/Failed exception, never queued.
 *
 *  The bridge is the authority: callers re-derive the site from the
 *  coordinates, so no client can claim a site it is not standing in. The
 *  biometric listener (/api/biometrics/push) and the ERP engine are untouched
 *  — this writes through the same insertPunch() path and adds no sync states.
 */

import {
  findTerminalOnlyFenceAt,
  inferDirection,
  insertPunch,
  rankMobileFences,
  resolveGeofenceLocation,
  type GeofenceLocation,
} from "@/lib/db";
import {
  haversineMetersRounded,
  isFiniteCoordinate,
  isValidRadius,
  methodAllowsMobile,
} from "@/lib/geofence";
import type {
  EmployeeRow,
  GeoPunchDetection,
  GeoPunchGeo,
  GeoPunchReason,
  GeoPunchResponse,
  PunchDirection,
} from "@/lib/types";

/** Coerce an optional positive integer (accuracy) — null when absent/invalid. */
export function optionalPositiveInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** Accept epoch ms or a parseable date string; anything odd falls back to now. */
export function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value.replace(" ", "T")).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

/** Parse+validate a body `direction`; returns null for absent, "!bad" for junk. */
export function parseDirection(value: unknown): PunchDirection | null | "!bad" {
  if (value === undefined || value === null || value === "") return null;
  const d = String(value).toUpperCase();
  return d === "IN" || d === "OUT" ? d : "!bad";
}

export interface GeoPunchInput {
  /** The already-resolved roster employee (routes own identity resolution). */
  employee: EmployeeRow;
  latitude: number;
  longitude: number;
  accuracyMeters?: number | null;
  /** Validated direction, or null/undefined to infer from the day sequence. */
  direction?: PunchDirection | null;
  timestamp?: number;
  /** Explicit device override (companion app scanning a terminal QR). */
  terminalRef?: string | null;
  /** Strict explicit site — an unknown name is a 404, never a fallback. */
  branchRef?: string | null;
  /**
   * Optional GPS accuracy ceiling in metres. 0 / undefined disables the gate
   * (the default, so existing behaviour is unchanged). When set and the
   * reported accuracy exceeds it, the punch is refused rather than silently
   * accepted on a reading too coarse to trust.
   */
  maxAccuracyMeters?: number;
}

/**
 * Deployment-wide accuracy ceiling from GEOFENCE_MAX_ACCURACY_METERS. Unset or
 * non-positive → 0, meaning "do not gate on accuracy".
 */
export function configuredMaxAccuracyMeters(): number {
  const raw = Number(process.env.GEOFENCE_MAX_ACCURACY_METERS ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
}

/**
 * The route-ready result. `payload` is usually a GeoPunchResponse; the two
 * "no such site/device" refusals keep the historical bare `{ ok, error }`
 * shape so the companion app's existing handling is unchanged.
 */
export interface GeoPunchOutcome {
  status: number;
  payload: GeoPunchResponse | { ok: false; error: string };
}

const NO_ROW = { punch: null, geo: null } as const;

function refusal(
  reason: GeoPunchReason,
  message: string,
  status: number
): GeoPunchOutcome {
  return {
    status,
    payload: { ok: false, reason, message, ...NO_ROW, error: message },
  };
}

function bareError(message: string, status: number): GeoPunchOutcome {
  return { status, payload: { ok: false, error: message } };
}

/**
 * Run the full geofence policy for one fix. Pure with respect to HTTP: it
 * only reads the DB (sites/terminals) and, on a decision, writes exactly one
 * Attendance_Logs row through insertPunch().
 */
export async function performGeoPunch(input: GeoPunchInput): Promise<GeoPunchOutcome> {
  const { employee, latitude, longitude } = input;
  const accuracyMeters = input.accuracyMeters ?? null;
  const terminalRef = input.terminalRef?.trim() || null;
  const branchRef = input.branchRef?.trim() || null;

  // ── 0. Optional accuracy gate (off by default) ───────────────────────
  const maxAccuracy =
    input.maxAccuracyMeters && input.maxAccuracyMeters > 0
      ? input.maxAccuracyMeters
      : configuredMaxAccuracyMeters();
  if (maxAccuracy > 0 && accuracyMeters !== null && accuracyMeters > maxAccuracy) {
    return refusal(
      "LOW_ACCURACY",
      `GPS accuracy is ±${accuracyMeters} m, coarser than the ${maxAccuracy} m limit this site accepts. Move to an open area and try again.`,
      422
    );
  }

  // ── 1. Resolve the governing site (terminal → branchRef → GPS) ───────
  let location: GeofenceLocation | null = null;
  let detectedBy: GeoPunchDetection = "auto";
  let insideAnySite = true;
  let nearest: { branch: string; distanceMeters: number } | null = null;

  if (terminalRef) {
    detectedBy = "terminal";
    location = await resolveGeofenceLocation({ terminalMac: terminalRef });
    if (!location) return bareError(`No device matches "${terminalRef}".`, 404);
  } else if (branchRef) {
    detectedBy = "branchRef";
    location = await resolveGeofenceLocation({ branchName: branchRef });
    if (!location) return bareError(`No branch named "${branchRef}".`, 404);
  } else {
    const ranked = await rankMobileFences(latitude, longitude);
    if (ranked.length === 0) {
      const terminalOnly = await findTerminalOnlyFenceAt(latitude, longitude);
      if (terminalOnly) {
        return refusal(
          "BIOMETRIC_ONLY",
          `You are inside ${terminalOnly.site.branch}, which requires the physical biometric terminal (mobile clocking is disabled there).`,
          403
        );
      }
      return refusal(
        "GEOFENCE_NOT_CONFIGURED",
        "No registered site has mobile clocking configured yet — ask an administrator to add a branch with its coordinates.",
        409
      );
    }
    const hit = ranked.find((match) => match.withinGeofence) ?? null;
    if (hit === null) {
      const terminalOnly = await findTerminalOnlyFenceAt(latitude, longitude);
      if (terminalOnly) {
        return refusal(
          "BIOMETRIC_ONLY",
          `You are inside ${terminalOnly.site.branch}, which requires the physical biometric terminal (mobile clocking is disabled there).`,
          403
        );
      }
      const chosen = ranked[0];
      insideAnySite = false;
      nearest = { branch: chosen.site.branch, distanceMeters: chosen.distanceMeters };
      location = {
        kind: "branch",
        id: chosen.site.id,
        label: chosen.site.branch,
        branch: chosen.site.branch,
        method: chosen.site.method,
        latitude: chosen.site.latitude,
        longitude: chosen.site.longitude,
        radiusMeters: chosen.site.radiusMeters,
      };
    } else {
      insideAnySite = true;
      nearest = { branch: hit.site.branch, distanceMeters: hit.distanceMeters };
      location = {
        kind: "branch",
        id: hit.site.id,
        label: hit.site.branch,
        branch: hit.site.branch,
        method: hit.site.method,
        latitude: hit.site.latitude,
        longitude: hit.site.longitude,
        radiusMeters: hit.site.radiusMeters,
      };
    }
  }

  // ── 2. Biometric-only sites reject the app outright ──────────────────
  if (!methodAllowsMobile(location.method)) {
    return refusal(
      "BIOMETRIC_ONLY",
      `Mobile clocking is disabled for ${location.label} — this location requires the physical biometric terminal.`,
      403
    );
  }

  // ── 3. The geofence must be configured to validate anything ──────────
  if (
    !isFiniteCoordinate(location.latitude, location.longitude) ||
    !isValidRadius(location.radiusMeters)
  ) {
    return refusal(
      "GEOFENCE_NOT_CONFIGURED",
      `${location.label} allows geofenced clocking but has no GPS centre/radius configured yet.`,
      409
    );
  }

  const siteLat = Number(location.latitude);
  const siteLng = Number(location.longitude);
  const radiusMeters = Number(location.radiusMeters);

  // ── 4. Haversine distance + verdict ──────────────────────────────────
  const distanceMeters = haversineMetersRounded(latitude, longitude, siteLat, siteLng);
  const withinGeofence = distanceMeters <= radiusMeters;

  const timestamp = input.timestamp ?? Date.now();
  const direction = input.direction ?? await inferDirection(employee.Employee_ID, timestamp);

  const rawPayload = JSON.stringify({
    channel: "geofence-mobile",
    latitude,
    longitude,
    accuracyMeters,
    distanceMeters,
    radiusMeters,
    withinGeofence,
    location: location.label,
    branch: location.branch,
    method: location.method,
    detectedBy,
    insideAnySite,
    nearestBranch: nearest?.branch ?? null,
    nearestDistanceMeters: nearest?.distanceMeters ?? null,
  });

  const geo: GeoPunchGeo = {
    latitude,
    longitude,
    accuracyMeters,
    distanceMeters,
    radiusMeters,
    withinGeofence,
    method: location.method,
    location: location.label,
    branch: location.branch,
    detectedBy,
    insideAnySite,
    nearestBranch: nearest?.branch ?? null,
    nearestDistanceMeters: nearest?.distanceMeters ?? null,
  };

  // ── 5a. Inside the radius → a normal Pending punch for the ERP ────────
  if (withinGeofence) {
    const logId = await insertPunch({
      employeeRef: employee.ERP_User_ID,
      timestamp,
      terminalId: location.kind === "terminal" ? location.id : null,
      verifyResult: "Verified",
      verifyMethod: "Geofence",
      direction,
      rawPayload,
      erpSyncStatus: "Pending",
      latitude,
      longitude,
      locationAccuracyMeters: accuracyMeters,
      geofenceDistanceMeters: distanceMeters,
      branchName: location.branch,
    });

    const payload: GeoPunchResponse = {
      ok: true,
      reason: direction === "IN" ? "CLOCKED_IN" : "CLOCKED_OUT",
      message: `${employee.Full_Name} clocked ${direction === "IN" ? "in" : "out"} — ${distanceMeters} m from ${location.label} (within ${radiusMeters} m).`,
      punch: {
        logId,
        employeeId: employee.Employee_ID,
        employeeName: employee.Full_Name,
        erpUserId: employee.ERP_User_ID,
        timestamp,
        direction,
        verifyMethod: "Geofence",
        syncStatus: "Pending",
        verifyResult: "Verified",
      },
      geo,
    };
    return { status: 200, payload };
  }

  // ── 5b. Outside the radius → auditable exception (never queued) ───────
  const logId = await insertPunch({
    employeeRef: employee.ERP_User_ID,
    timestamp,
    terminalId: location.kind === "terminal" ? location.id : null,
    verifyResult: "Denied",
    verifyMethod: "Geofence",
    direction,
    rawPayload,
    erpSyncStatus: "Failed",
    latitude,
    longitude,
    locationAccuracyMeters: accuracyMeters,
    geofenceDistanceMeters: distanceMeters,
    branchName: location.branch,
  });

  const payload: GeoPunchResponse = {
    ok: false,
    reason: "OUTSIDE_GEOFENCE",
    message: insideAnySite
      ? `Rejected — ${distanceMeters} m from ${location.label}, outside the ${radiusMeters} m geofence. Logged as an exception.`
      : nearest
        ? `Rejected — you are outside every registered site (nearest is ${nearest.branch}, ${nearest.distanceMeters} m away). Logged as an exception.`
        : "Rejected — you are outside every registered site. Logged as an exception.",
    punch: {
      logId,
      employeeId: employee.Employee_ID,
      employeeName: employee.Full_Name,
      erpUserId: employee.ERP_User_ID,
      timestamp,
      direction,
      verifyMethod: "Geofence",
      syncStatus: "Failed",
      verifyResult: "Denied",
    },
    geo,
  };
  return { status: 200, payload };
}
