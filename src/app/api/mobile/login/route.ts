/**
 * ============================================================================
 *  POST /api/mobile/login — BIOBRIDGE companion app sign-in (Phase 16/17)
 * ============================================================================
 *
 *  Turns "Employee ID + PIN" into the things the phone actually needs before
 *  it can clock anyone hands-free:
 *
 *    1. a confirmed roster identity (the `employeeRef` it must quote), and
 *    2. EVERY registered site its punches may be judged against.
 *
 *  Body:
 *    {
 *      "employeeId": "ERP-1001",   // ERP_User_ID or the numeric Employee_ID
 *      "pin":        "0000"        // personal PIN, else MOBILE_DEFAULT_PIN
 *    }
 *
 *  Headers:
 *    x-mobile-key: <MOBILE_PUNCH_KEY>   ← required, same shared secret the
 *                                         phone sends to /attendance/geopunch
 *
 *  Outcomes (all JSON, no-store):
 *    200 → { ok:true, employee:{…}, geofence:{…}|null, fences:[…] }
 *    400 → malformed body / missing fields
 *    401 → missing or wrong x-mobile-key, OR unknown employee / wrong PIN
 *          (one message for both, so the endpoint is not an ID oracle)
 *    403 → the employee is Inactive
 *
 *  ── Why a LIST of fences (Phase 17) ─────────────────────────────────────
 *  An employee travels. The fence that governs a punch is therefore the one
 *  they are physically inside, not the branch on their roster row, so sign-in
 *  returns every site that is both mobile-capable (Clocking_Method Geofence or
 *  Both) and geo-ready (centre + radius). `geofence` is the employee's own
 *  branch, reported for display only.
 *
 *  This removed two old hard gates: a biometric-only home branch used to 403
 *  and a missing branch used to 404. Both are now irrelevant — you may clock in
 *  wherever you are — so the app signs in and simply has nothing to watch when
 *  no site is configured yet. The bridge remains the authority: the punch
 *  endpoint re-derives the governing site from each GPS fix and never trusts
 *  the phone's claim.
 *
 *  Biometric remains the primary channel — this route only ever *reads*
 *  configuration, it never writes a punch row.
 */

import type { NextRequest } from "next/server";
import {
  getDb,
  listMobileFences,
  resolveEmployee,
  resolveGeofenceLocation,
  verifyEmployeeMobilePin,
} from "@/lib/db";
import { isFiniteCoordinate, isValidRadius } from "@/lib/geofence";
import { DEFAULT_MOBILE_KEY, hasValidMobileKey } from "@/lib/mobile";
import type { MobileLoginResponse } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function POST(request: NextRequest): Promise<Response> {
  // ── 1. Shared secret (no session accepted here — this is a credential
  //       exchange, not a console action) ─────────────────────────────────
  if (!hasValidMobileKey(request)) {
    return json(
      {
        ok: false,
        error: `Unauthorized — send the x-mobile-key header (expected "${DEFAULT_MOBILE_KEY}" unless MOBILE_PUNCH_KEY is set).`,
      },
      401
    );
  }

  // ── 2. Payload ──────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const rawId = body.employeeId ?? body.employeeRef ?? body.erpUserId ?? body.id ?? null;
  const employeeRef = rawId === null || rawId === undefined ? "" : String(rawId).trim();
  const pin = typeof body.pin === "string" ? body.pin.trim() : "";
  if (!employeeRef || !pin) {
    return json({ ok: false, error: "employeeId and pin are required." }, 400);
  }

  // ── 3. Identity ─────────────────────────────────────────────────────
  // One failure message for "no such employee" and "wrong PIN" alike.
  const employee = await resolveEmployee(await getDb(), employeeRef);
  if (!employee || !await verifyEmployeeMobilePin(employee, pin)) {
    return json({ ok: false, error: "Invalid employee ID or PIN." }, 401);
  }

  if (employee.Status !== "Active") {
    return json(
      { ok: false, error: `${employee.Full_Name} is no longer an active employee.` },
      403
    );
  }

  // ── 4. Every site this phone may clock in at ─────────────────────────
  // Mobile-capable AND geo-ready, across the whole Branches table — this is
  // what makes "clock in wherever you are" work without a rebuild.
  const fences = await listMobileFences();

  // The roster branch is display-only now: it feeds the "Home site" row and
  // the offline-queue badge. It gates nothing.
  const home = await resolveGeofenceLocation({ employeeBranch: employee.Branch_Name });
  const homeConfigured = home
    ? isFiniteCoordinate(home.latitude, home.longitude) && isValidRadius(home.radiusMeters)
    : false;

  const firstName = employee.Full_Name.split(" ")[0];
  const payload: MobileLoginResponse = {
    ok: true,
    message:
      fences.length > 0
        ? `Welcome, ${firstName}`
        : `Welcome, ${firstName} — no site has mobile clocking set up yet, so use the fingerprint terminal.`,
    employee: {
      employeeId: employee.Employee_ID,
      erpUserId: employee.ERP_User_ID,
      fullName: employee.Full_Name,
      department: employee.Department,
      branch: employee.Branch_Name,
    },
    geofence: home
      ? {
          configured: homeConfigured,
          method: home.method,
          label: home.label,
          branch: home.branch,
          latitude: home.latitude,
          longitude: home.longitude,
          radiusMeters: home.radiusMeters,
        }
      : null,
    fences,
    generatedAt: Date.now(),
  };
  return json(payload);
}
