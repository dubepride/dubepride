/**
 * ============================================================================
 *  POST /api/attendance/geopunch — Hands-Free Geofenced Mobile Clocking
 * ============================================================================
 *
 *  The optional SECONDARY clock-in channel. The mobile app posts a background
 *  GPS fix; the bridge validates it against the employee's assigned site (or
 *  an explicitly referenced device/branch) and, when the fix is inside the
 *  configured radius, writes an ordinary Pending punch for the ERP sync
 *  engine — exactly the row the fingerprint terminal would have produced.
 *
 *  Biometric remains the primary/default channel: a location whose
 *  Clocking_Method is 'Biometric' rejects mobile punches outright.
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
import { currentAccount } from "@/lib/auth";
import {
  getDb,
  inferDirection,
  insertPunch,
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
import type { GeoPunchReason, GeoPunchResponse, PunchDirection } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

/** Default shared secret for the mobile app (override with MOBILE_PUNCH_KEY). */
const DEFAULT_MOBILE_KEY = "biobridge-mobile";

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

/**
 * Authenticate the caller: a valid admin session OR the shared mobile key.
 * (Admins keep console-testing ability; the app can't hold a session cookie.)
 */
async function isAuthorized(request: NextRequest): Promise<boolean> {
  const key = request.headers.get("x-mobile-key") ?? request.headers.get("x-api-key");
  const expected = process.env.MOBILE_PUNCH_KEY?.trim() || DEFAULT_MOBILE_KEY;
  if (key && key === expected) return true;
  const account = await currentAccount();
  return account !== null;
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!(await isAuthorized(request))) {
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

  // ── 3. Resolve the governing location (device → branch → home branch) ─
  const terminalRef =
    (typeof body.terminalRef === "string" && body.terminalRef) ||
    (typeof body.terminalMac === "string" && body.terminalMac) ||
    null;
  const branchRef = typeof body.branchRef === "string" ? body.branchRef : null;

  const location: GeofenceLocation | null = resolveGeofenceLocation({
    terminalMac: terminalRef,
    branchName: branchRef,
    employeeBranch: employee.Branch_Name,
  });
  if (!location) {
    return json(
      {
        ok: false,
        error: `No site is assigned to ${employee.Full_Name} — set a branch (or pass branchRef/terminalRef).`,
      },
      404
    );
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
  });

  const payload: GeoPunchResponse = {
    ok: false,
    reason: "OUTSIDE_GEOFENCE",
    message: `Rejected — ${distanceMeters} m from ${location.label}, outside the ${radiusMeters} m geofence. Logged as an exception.`,
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
