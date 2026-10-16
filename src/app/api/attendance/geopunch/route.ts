/**
 * ============================================================================
 *  POST /api/attendance/geopunch — Hands-Free Geofenced Mobile Clocking
 * ============================================================================
 *
 *  The optional SECONDARY clock-in channel used by the companion app and by
 *  device-facing integrations. The client posts a background GPS fix; the
 *  bridge works out WHICH registered site that fix falls inside and writes an
 *  ordinary Pending punch for the ERP sync engine — exactly the row the
 *  fingerprint terminal would have produced.
 *
 *  An employee may travel, so the governing site is the one they are actually
 *  standing in, NOT the branch on their roster row. Resolution order:
 *
 *    1. an explicit device (`terminalRef`) — a device-level override;
 *    2. an explicit site (`branchRef`) — validated STRICTLY (an unknown name is
 *       a 404; the home branch is never substituted);
 *    3. otherwise the GPS fix is matched against EVERY registered mobile site.
 *
 *  All of the above — the site policy, the Haversine verdict and the audit
 *  write — now lives in src/lib/geo-punch.ts, shared with the browser
 *  self-clock route so the two can never disagree.
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
 *    • outside radius  → 200 { ok:false, reason:"OUTSIDE_GEOFENCE" } (exception)
 *    • biometric-only  → 403 { ok:false, reason:"BIOMETRIC_ONLY" }  (no row)
 *    • not configured  → 409 { ok:false, reason:"GEOFENCE_NOT_CONFIGURED" }
 *    • bad payload     → 400 / 404
 *
 *  Auth: a device/mobile ingress (like /api/biometrics/push) — public at the
 *  proxy wall, so the handler authenticates EITHER a signed-in admin session
 *  (console testing) OR the shared `x-mobile-key` secret. The employee is
 *  named in the body here because the caller is a device, not a browser.
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  The biometric listener (/api/biometrics/push) and the ERP engine are
 *  completely unaffected: this writes through the same insertPunch() path.
 *  ─────────────────────────────────────────────────────────────────────
 */

import type { NextRequest } from "next/server";
import { getDb, resolveEmployee } from "@/lib/db";
import { isFiniteCoordinate } from "@/lib/geofence";
import { DEFAULT_MOBILE_KEY, isMobileAuthorized } from "@/lib/mobile";
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
    body.employeeRef ?? body.employeeId ?? body.erpUserId ?? body.erp_user_id ?? body.id ?? null;
  const ref = rawRef === null || rawRef === undefined ? "" : String(rawRef).trim();
  if (!ref) return json({ ok: false, error: "employeeRef is required." }, 400);

  const employee = await resolveEmployee(await getDb(), ref);
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
  });

  return json(outcome.payload, outcome.status);
}
