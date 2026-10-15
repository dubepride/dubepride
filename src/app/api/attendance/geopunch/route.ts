/**
 * ============================================================================
 *  POST /api/attendance/geopunch — Hands-Free Geofenced Mobile Clocking
 * ============================================================================
 *
 *  The optional SECONDARY clock-in channel. The mobile app posts a background
 *  GPS fix; the bridge works out WHICH registered site that fix falls inside
 *  and, when it is within that site's configured radius, writes an ordinary
 *  Pending punch for the ERP sync engine — exactly the row the fingerprint
 *  terminal would have produced.
 *
 *  An employee may travel, so the governing site is the one they are actually
 *  standing in, NOT the branch on their roster row. Resolution order:
 *
 *    1. an explicit device (`terminalRef`) — a device-level override, and the
 *       only case that still resolves a Terminal row;
 *    2. an explicit site (`branchRef`) — validated STRICTLY against that named
 *       branch (an unknown name is a 404; the home branch is never substituted,
 *       which would validate against the wrong fence);
 *    3. otherwise the GPS fix is matched against EVERY registered site that is
 *       mobile-capable and geo-ready — the travelling employee's normal path.
 *
 *  A fix outside every registered site is recorded as an exception against the
 *  NEAREST one, so the audit row still names a real place and carries a
 *  meaningful distance.
 *
 *  The bridge is the authority: the phone never gets to claim a site. Whatever
 *  the app sends, this handler re-derives the site from the coordinates.
 *
 *  Biometric remains the primary/default channel: a location whose
 *  Clocking_Method is 'Biometric' rejects mobile punches outright, and is
 *  never eligible for the automatic GPS match.
 *
 *  Body:
 *    {
 *      "employeeRef":  "ERP-1001",   // ERP id or Employee_ID (required)
 *      "direction":    "IN" | "OUT", // optional → inferred from today's seq
 *      "latitude":     -17.8292,     // required
 *      "longitude":    31.0522,      // required
 *      "accuracyMeters": 12,         // optional device-reported GPS accuracy
 *      "branchRef":    "Branch 5",   // optional explicit site
 *      "terminalRef":  "A4:1F:...",  // optional explicit device (MAC/SN)
 *      "timestamp":    1728748927000 // optional epoch ms (defaults to now)
 *    }
 *
 *  Outcomes (all JSON, no-store):
 *    • inside radius   → 200 { ok:true,  reason:"CLOCKED_IN|CLOCKED_OUT" }
 *                        → Attendance_Logs row Pending for the ERP.
 *    • outside radius  → 200 { ok:false, reason:"OUTSIDE_GEOFENCE" }
 *                        → row written as an EXCEPTION (Denied, not queued).
 *    • biometric-only  → 403 { ok:false, reason:"BIOMETRIC_ONLY" }   (no row)
 *    • not configured  → 409 { ok:false, reason:"GEOFENCE_NOT_CONFIGURED" }
 *    • bad payload     → 400 / 404
 *
 *  Auth: this is a device/mobile ingress (like /api/biometrics/push) — it is
 *  public at the proxy wall, so the handler authenticates EITHER a signed-in
 *  admin session (for console testing) OR the shared `x-mobile-key` secret.
 *  Admin capability checks elsewhere are untouched.
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  The biometric listener (/api/biometrics/push) and the ERP engine
 *  (runErpSync/buildErpPayload) are completely unaffected by this route: it
 *  writes through the same insertPunch() path and adds no new sync states.
 *  ─────────────────────────────────────────────────────────────────────
 */

import type { NextRequest } from "next/server";
import {
  getDb,
  inferDirection,
  insertPunch,
  rankMobileFences,
  findTerminalOnlyFenceAt,
  resolveEmployee,
  resolveGeofenceLocation,
  type GeofenceLocation,
} from "@/lib/db";
import {
  haversineMetersRounded,
  isFiniteCoordinate,
  isValidRadius,
  methodAllowsMobile,
} from "@/lib/geofence";
import { DEFAULT_MOBILE_KEY, isMobileAuthorized } from "@/lib/mobile";
import type {
  GeoPunchDetection,
  GeoPunchReason,
  GeoPunchResponse,
  PunchDirection,
} from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function fail(reason: GeoPunchReason, message: string, status: number): Response {
  const payload: GeoPunchResponse = { ok: false, reason, message, punch: null, geo: null, error: message };
  return json(payload, status);
}

/** Coerce an optional positive integer (accuracy) — null when absent/invalid. */
function optionalPositiveInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** Accept epoch ms or a parseable date string; anything odd falls back to now. */
function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value.replace(" ", "T")).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!(await isMobileAuthorized(request))) {
    return json(
      {
        ok: false,
        reason: "BIOMETRIC_ONLY",
        message: `Unauthorized — provide a valid session or the ${DEFAULT_MOBILE_KEY} mobile key.`,
        punch: null,
        geo: null,
        error: "Unauthorized",
      },
      401
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  // ── 1. Employee ─────────────────────────────────────────────────────
  const rawRef =
    body.employeeRef ?? body.employeeId ?? body.erpUserId ?? body.erp_user_id ?? body.id ?? null;
  const ref = rawRef === null || rawRef === undefined ? "" : String(rawRef).trim();
  if (!ref) return json({ ok: false, error: "employeeRef is required." }, 400);

  const employee = resolveEmployee(getDb(), ref);
  if (!employee) return json({ ok: false, error: `No employee matches "${ref}".` }, 404);

  // ── 2. Coordinates ──────────────────────────────────────────────────
  const latitude = typeof body.latitude === "number" ? body.latitude : Number(body.latitude);
  const longitude = typeof body.longitude === "number" ? body.longitude : Number(body.longitude);
  if (!isFiniteCoordinate(latitude, longitude)) {
    return json({ ok: false, error: "A valid latitude (-90..90) and longitude (-180..180) are required." }, 400);
  }
  const accuracyMeters = optionalPositiveInt(
    body.accuracyMeters ?? body.accuracy ?? body.locationAccuracyMeters
  );

  // ── 3. Resolve the governing site (terminal → branchRef → GPS) ───────
  //
  //  Phase 17: an employee may travel, so the DEFAULT path is now to work the
  //  site out from the fix itself. The bridge — never the phone — decides
  //  where a punch happened, which is what makes "clock in at any branch"
  //  tamper-proof: a phone cannot claim a site it is not standing in.
  const terminalRef =
    (typeof body.terminalRef === "string" && body.terminalRef) ||
    (typeof body.terminalMac === "string" && body.terminalMac) ||
    null;
  const branchRef = typeof body.branchRef === "string" ? body.branchRef.trim() : null;

  let location: GeofenceLocation | null = null;
  let detectedBy: GeoPunchDetection = "auto";
  /** Auto path: did the fix land inside a registered site at all? */
  let insideAnySite = true;
  /** Context for a miss — the closest registered site, if there is one. */
  let nearest: { branch: string; distanceMeters: number } | null = null;

  if (terminalRef) {
    // 3a. An explicit device the app scanned — a device-level override.
    detectedBy = "terminal";
    location = resolveGeofenceLocation({ terminalMac: terminalRef });
    if (!location) {
      return json({ ok: false, error: `No device matches "${terminalRef}".` }, 404);
    }
  } else if (branchRef) {
    // 3b. An explicitly named site. STRICT on purpose: an unknown name is a
    //     404 rather than a silent fall back to the employee's home branch,
    //     which would validate the punch against the wrong fence.
    detectedBy = "branchRef";
    location = resolveGeofenceLocation({ branchName: branchRef });
    if (!location) {
      return json({ ok: false, error: `No branch named "${branchRef}".` }, 404);
    }
  } else {
    // 3c. THE TRAVELLING EMPLOYEE: match the fix against every registered
    //     site. Mobile-capable and geo-ready sites only — a biometric-only
    //     plant is never opened to GPS punches by this path.
    const ranked = rankMobileFences(latitude, longitude);
    if (ranked.length === 0) {
      const terminalOnly = findTerminalOnlyFenceAt(latitude, longitude);
      if (terminalOnly) {
        return fail(
          "BIOMETRIC_ONLY",
          `You are inside ${terminalOnly.site.branch}, which requires the physical biometric terminal (mobile clocking is disabled there).`,
          403
        );
      }
      return fail(
        "GEOFENCE_NOT_CONFIGURED",
        "No registered site has mobile clocking configured yet — ask an administrator to add a branch with its coordinates.",
        409
      );
    }
    const hit = ranked.find((match) => match.withinGeofence) ?? null;
    if (hit === null) {
      const terminalOnly = findTerminalOnlyFenceAt(latitude, longitude);
      if (terminalOnly) {
        return fail(
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
      const chosen = hit;
      insideAnySite = true;
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
    }
  }

  // ── 4. Crucial policy check: biometric-only locations reject the app ──
  if (!methodAllowsMobile(location.method)) {
    return fail(
      "BIOMETRIC_ONLY",
      `Mobile clocking is disabled for ${location.label} — this location requires the physical biometric terminal.`,
      403
    );
  }

  // ── 5. The geofence must be configured to validate anything ───────────
  if (
    !isFiniteCoordinate(location.latitude, location.longitude) ||
    !isValidRadius(location.radiusMeters)
  ) {
    return fail(
      "GEOFENCE_NOT_CONFIGURED",
      `${location.label} allows geofenced clocking but has no GPS centre/radius configured yet.`,
      409
    );
  }

  const siteLat = Number(location.latitude);
  const siteLng = Number(location.longitude);
  const radiusMeters = Number(location.radiusMeters);

  // ── 6. Haversine distance + verdict ──────────────────────────────────
  const distanceMeters = haversineMetersRounded(latitude, longitude, siteLat, siteLng);
  const withinGeofence = distanceMeters <= radiusMeters;

  const timestamp = parseTimestamp(body.timestamp ?? body.time ?? body.punchTime);
  let direction: PunchDirection;
  if (body.direction !== undefined) {
    const d = String(body.direction).toUpperCase();
    if (d !== "IN" && d !== "OUT") return json({ ok: false, error: 'direction must be "IN" or "OUT".' }, 400);
    direction = d;
  } else {
    direction = inferDirection(employee.Employee_ID, timestamp);
  }

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

  const geo = {
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

  // ── 7a. Inside the radius → a normal Pending punch for the ERP ────────
  if (withinGeofence) {
    const logId = insertPunch({
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
      // Phase 17 — the site that actually validated this punch, so reports can
      // answer "who clocked in where" without parsing the JSON audit blob.
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
    return json(payload);
  }

  // ── 7b. Outside the radius → log an EXCEPTION (not queued for the ERP) ─
  //   Denied + Failed keeps the attempt auditable (dashboard feed / reports)
  //   while guaranteeing it never counts as attendance or reaches the ERP.
  const logId = insertPunch({
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
        : `Rejected — you are outside every registered site. Logged as an exception.`,
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
  return json(payload);
}
