/**
 * ============================================================================
 *  POST /api/attendance/geopunch — Geofenced Mobile Clocking
 * ============================================================================
 *
 *  The mobile clock-in channel used by the companion app and by
 *  device-facing integrations. The client posts a GPS fix; the
 *  bridge works out WHICH registered site that fix falls inside and writes an
 *  ordinary Pending punch for the ERP sync engine — exactly the row the
 *  fingerprint terminal would have produced.
 */

import type { NextRequest } from "next/server";
import { after } from "next/server";
import {
  bindEmployeeDevice,
  getDb,
  resolveEmployee,
} from "@/lib/db";
import { runErpSync } from "@/lib/erp";
import { isFiniteCoordinate } from "@/lib/geofence";
import { DEFAULT_MOBILE_KEY, isMobileAuthorized } from "@/lib/mobile";
import { isBackgroundServicesRunning } from "@/lib/mock-generator";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import {
  optionalPositiveInt,
  parseDirection,
  parseTimestamp,
  performGeoPunch,
} from "@/lib/geo-punch";

const NO_STORE = { "Cache-Control": "no-store" };

/** Per-IP ceiling for the device ingress; a phone clocks a few times a shift. */
const LIMIT = 60;
const WINDOW_MS = 60_000;

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...extraHeaders } });
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

  // ── Rate limit per caller IP (cheap, before any DB work) ─────────────
  const rl = rateLimit(clientKey(request.headers, "geopunch"), LIMIT, WINDOW_MS);
  if (!rl.allowed) {
    return json(
      {
        ok: false,
        reason: "RATE_LIMITED",
        message: `Too many clock attempts — wait ${rl.retryAfterSeconds}s and try again.`,
        punch: null,
        geo: null,
        error: "Rate limited.",
      },
      429,
      { "Retry-After": String(rl.retryAfterSeconds) }
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
    body.employeeRef ??
    body.employeeNumber ??
    body.empNumber ??
    body.employeeId ??
    body.erpUserId ??
    body.erp_user_id ??
    body.id ??
    null;
  const ref = rawRef === null || rawRef === undefined ? "" : String(rawRef).trim();
  if (!ref) return json({ ok: false, error: "employeeRef is required." }, 400);

  const employee = await resolveEmployee(await getDb(), ref);
  if (!employee) return json({ ok: false, error: `No employee matches "${ref}".` }, 404);

  // ── 1b. Hardware Device Verification (Anti-Buddy Clocking) ───────────
  const rawDeviceId =
    body.deviceId ??
    body.deviceMac ??
    body.hardwareId ??
    request.headers.get("x-device-id") ??
    null;
  const deviceId = rawDeviceId ? String(rawDeviceId).trim() : null;
  const rawDeviceName =
    body.deviceName ??
    body.deviceModel ??
    request.headers.get("x-device-name") ??
    null;
  const deviceName = rawDeviceName ? String(rawDeviceName).trim() : null;

  if (deviceId) {
    const boundId = (employee.Bound_Device_ID ?? "").trim();
    if (!boundId) {
      await bindEmployeeDevice(employee.Employee_ID, deviceId, deviceName);
      employee.Bound_Device_ID = deviceId;
      employee.Bound_Device_Name = deviceName;
    }
  }

  // ── 2. Coordinates ──────────────────────────────────────────────────
  const latitude = typeof body.latitude === "number" ? body.latitude : Number(body.latitude);
  const longitude = typeof body.longitude === "number" ? body.longitude : Number(body.longitude);
  if (!isFiniteCoordinate(latitude, longitude)) {
    return json({ ok: false, error: "A valid latitude (-90..90) and longitude (-180..180) are required." }, 400);
  }
  const accuracyMeters = optionalPositiveInt(
    body.accuracyMeters ?? body.accuracy ?? body.locationAccuracyMeters
  );

  // ── 3. Direction (validated before the engine runs) ──────────────────
  const direction = parseDirection(body.direction ?? body.punchDirection);
  if (direction === "!bad") {
    return json({ ok: false, error: 'direction must be "IN" or "OUT".' }, 400);
  }

  // ── 4. Run the shared geofence policy + write the row ────────────────
  const outcome = await performGeoPunch({
    employee,
    latitude,
    longitude,
    accuracyMeters,
    direction: direction ?? undefined,
    timestamp: parseTimestamp(body.timestamp ?? body.time ?? body.punchTime),
    terminalRef:
      (typeof body.terminalRef === "string" && body.terminalRef) ||
      (typeof body.terminalMac === "string" && body.terminalMac) ||
      null,
    branchRef: typeof body.branchRef === "string" ? body.branchRef : null,
    deviceId,
    deviceName,
  });

  // Automatically drain Pending records to the ERP after acknowledging the punch
  if (outcome.payload.ok && !isBackgroundServicesRunning()) {
    after(async () => {
      try {
        await runErpSync("Auto");
      } catch (err) {
        console.error("[geopunch] post-ack ERP sync failed:", err);
      }
    });
  }

  return json(outcome.payload, outcome.status);
}
