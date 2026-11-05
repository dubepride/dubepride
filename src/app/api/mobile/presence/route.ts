/**
 * ============================================================================
 *  /api/mobile/presence — Field Tracker heartbeat (Phases 16/17 extension)
 * ============================================================================
 *
 *  The companion app reports the phone's latest location while an employee is
 *  signed in, so the Field Tracker map can show where people are. This is a
 *  LATEST-POSITION feed — there is deliberately no movement history.
 *
 *  POST   store the newest fix (throttled to one row per employee)
 *  DELETE drop the row immediately (called on sign-out)
 *
 *  Headers:
 *    x-mobile-key: <MOBILE_PUNCH_KEY>
 *
 *  Body (POST):
 *    {
 *      "employeeRef": "ERP-1001",        // ERP_User_ID or numeric Employee_ID
 *      "deviceId": "abc123",             // physical device (binding-checked)
 *      "latitude": -20.15, "longitude": 28.58,
 *      "accuracyMeters": 12,             // optional
 *      "branch": "Belmont",              // optional display hint
 *      "timestamp": 1730000000000        // optional fix time (clamped)
 *    }
 *
 *  Body (DELETE):
 *    { "employeeRef": "ERP-1001", "deviceId": "abc123" }
 *    (or `?employeeRef=…&deviceId=…` on the query string)
 *
 *  The server never trusts the reported branch for containment — the map
 *  re-derives it from the coordinates against live fence geometry. The
 *  branch here is a display hint only.
 */

import type { NextRequest } from "next/server";
import {
  clearEmployeePresence,
  getDb,
  resolveEmployee,
  upsertEmployeePresence,
  PRESENCE_WINDOW_MS,
} from "@/lib/db";
import { isFiniteCoordinate } from "@/lib/geofence";
import { DEFAULT_MOBILE_KEY, hasValidMobileKey } from "@/lib/mobile";
import { optionalPositiveInt, parseTimestamp } from "@/lib/geo-punch";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/** Pull a string identity out of the body or query string. */
function identityFrom(request: NextRequest, body: Record<string, unknown>): string {
  const raw =
    body.employeeRef ??
    body.employeeNumber ??
    body.empNumber ??
    body.employeeId ??
    body.erpUserId ??
    body.id ??
    request.nextUrl.searchParams.get("employeeRef") ??
    request.nextUrl.searchParams.get("employeeNumber") ??
    request.nextUrl.searchParams.get("employeeId") ??
    null;
  return raw === null || raw === undefined ? "" : String(raw).trim();
}

function deviceFrom(request: NextRequest, body: Record<string, unknown>): string | null {
  const raw =
    body.deviceId ??
    body.deviceMac ??
    body.hardwareId ??
    request.headers.get("x-device-id") ??
    request.nextUrl.searchParams.get("deviceId") ??
    null;
  const deviceId = raw === null || raw === undefined ? "" : String(raw).trim();
  return deviceId || null;
}

/**
 * Resolve the employee and enforce the 1-to-1 device binding that sign-in
 * established. Returns either the employee or a ready-to-return response.
 */
async function authorize(
  request: NextRequest,
  body: Record<string, unknown>
): Promise<{ employeeId: number } | { response: Response }> {
  if (!hasValidMobileKey(request)) {
    return {
      response: json(
        {
          ok: false,
          error: `Unauthorized — send the x-mobile-key header (expected "${DEFAULT_MOBILE_KEY}" unless MOBILE_PUNCH_KEY is set).`,
        },
        401
      ),
    };
  }

  const ref = identityFrom(request, body);
  if (!ref) {
    return { response: json({ ok: false, error: "employeeRef is required." }, 400) };
  }

  const employee = await resolveEmployee(await getDb(), ref);
  if (!employee) {
    return { response: json({ ok: false, error: `No employee matches "${ref}".` }, 404) };
  }
  if (employee.Status !== "Active") {
    return {
      response: json(
        { ok: false, error: `${employee.Full_Name} is no longer an active employee.` },
        403
      ),
    };
  }

  const deviceId = deviceFrom(request, body);
  const boundId = (employee.Bound_Device_ID ?? "").trim();
  if (boundId && deviceId && boundId !== deviceId) {
    return {
      response: json(
        {
          ok: false,
          reason: "UNAUTHORIZED_DEVICE",
          error: `Wrong Device: employee ${employee.ERP_User_ID} is bound to another phone.`,
        },
        403
      ),
    };
  }

  return { employeeId: employee.Employee_ID };
}

export async function POST(request: NextRequest): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const auth = await authorize(request, body);
  if ("response" in auth) return auth.response;

  const latitude = typeof body.latitude === "number" ? body.latitude : Number(body.latitude);
  const longitude = typeof body.longitude === "number" ? body.longitude : Number(body.longitude);
  if (!isFiniteCoordinate(latitude, longitude)) {
    return json(
      { ok: false, error: "A valid latitude (-90..90) and longitude (-180..180) are required." },
      400
    );
  }

  const now = Date.now();
  const rawTimestamp = parseTimestamp(body.timestamp ?? body.time ?? body.fixTime);
  // Never let a phone claim a future fix, and ignore fixes older than the
  // tracked window so a delayed offline queue cannot masquerade as "live".
  const timestamp = Math.min(rawTimestamp, now);
  if (now - timestamp > PRESENCE_WINDOW_MS) {
    return json({ ok: true, recorded: false, reason: "stale" });
  }

  const branchRaw = body.branch ?? body.branchName ?? body.site;
  const branchName =
    typeof branchRaw === "string" && branchRaw.trim() ? branchRaw.trim() : null;
  const deviceNameRaw = body.deviceName ?? body.deviceModel ?? request.headers.get("x-device-name");
  const deviceName =
    deviceNameRaw === null || deviceNameRaw === undefined || String(deviceNameRaw).trim() === ""
      ? null
      : String(deviceNameRaw).trim();

  const result = await upsertEmployeePresence({
    employeeId: auth.employeeId,
    latitude,
    longitude,
    accuracyMeters: optionalPositiveInt(
      body.accuracyMeters ?? body.accuracy ?? body.locationAccuracyMeters
    ),
    branchName,
    deviceId: deviceFrom(request, body),
    deviceName,
    timestamp,
  });

  return json({ ok: true, recorded: result.recorded, reason: result.reason ?? null });
}

export async function DELETE(request: NextRequest): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // DELETE with only query parameters is fine.
  }

  const auth = await authorize(request, body);
  if ("response" in auth) return auth.response;

  await clearEmployeePresence(auth.employeeId);
  return json({ ok: true, cleared: true });
}
