/**
 * ============================================================================
 *  POST /api/my-portal/geopunch — browser self-clock (Phase 18)
 * ============================================================================
 *
 *  The signed-in employee's mobile-first, geofenced clock-in from a web
 *  browser (My Portal → "Clock in with GPS"). It is the browser twin of the
 *  companion app's ingress, sharing the same policy engine
 *  (src/lib/geo-punch.ts) so the two can never disagree about a verdict.
 *
 *  Security — the important difference from /api/attendance/geopunch:
 *  this route derives the EMPLOYEE IDENTITY FROM THE SESSION. Any
 *  `employeeRef` in the body is ignored, so a signed-in worker can only ever
 *  punch for themselves. There is also no `branchRef`/`terminalRef` here:
 *  the browser is a travelling employee, and the bridge always re-derives the
 *  governing site from the coordinates.
 *
 *  Body:
 *    {
 *      "latitude": -17.8292,       // required
 *      "longitude": 31.0522,       // required
 *      "accuracyMeters": 12,       // optional device-reported GPS accuracy
 *      "direction": "IN" | "OUT"   // optional → inferred from today's sequence
 *    }
 *
 *  Protection: requires can_remote_clock, is rate-limited per account, uses a
 *  SERVER timestamp (a browser clock is not trusted), and returns the same
 *  GeoPunchResponse the companion app already understands.
 */

import type { NextRequest } from "next/server";
import { currentAccount, forbiddenResponse, requirePermission, unauthorizedResponse } from "@/lib/auth";
import { getDb, resolveEmployee } from "@/lib/db";
import { isFiniteCoordinate } from "@/lib/geofence";
import {
  configuredMaxAccuracyMeters,
  optionalPositiveInt,
  parseDirection,
  performGeoPunch,
} from "@/lib/geo-punch";
import { clientKey, rateLimit } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** Generous but finite: a human clocks a handful of times per shift. */
const LIMIT = 20;
const WINDOW_MS = 60_000;

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...extraHeaders } });
}

export async function POST(request: NextRequest): Promise<Response> {
  const guard = await requirePermission("can_remote_clock");
  if (guard) return guard;

  const account = await currentAccount();
  if (!account) return unauthorizedResponse();
  if (account.permissions.can_remote_clock !== true) return forbiddenResponse();

  if (account.employeeId == null) {
    return json({ ok: false, reason: "GEOFENCE_NOT_CONFIGURED", message: "No roster employee is linked to this account — ask a manager to link one.", punch: null, geo: null, error: "No linked employee." }, 400);
  }

  // ── Rate limit per identity + IP ─────────────────────────────────────
  const rl = rateLimit(clientKey(request.headers, `myportalpunch:${account.accountId}`), LIMIT, WINDOW_MS);
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

  const employee = await resolveEmployee(await getDb(), String(account.employeeId));
  if (!employee) {
    return json({ ok: false, error: "The linked roster employee no longer exists." }, 409);
  }

  const latitude = typeof body.latitude === "number" ? body.latitude : Number(body.latitude);
  const longitude = typeof body.longitude === "number" ? body.longitude : Number(body.longitude);
  if (!isFiniteCoordinate(latitude, longitude)) {
    return json({ ok: false, error: "A valid latitude (-90..90) and longitude (-180..180) are required." }, 400);
  }

  const direction = parseDirection(body.direction);
  if (direction === "!bad") return json({ ok: false, error: 'direction must be "IN" or "OUT".' }, 400);

  const outcome = await performGeoPunch({
    employee,
    latitude,
    longitude,
    accuracyMeters: optionalPositiveInt(body.accuracyMeters ?? body.accuracy),
    direction: direction ?? undefined,
    // Server timestamp — never the browser's clock.
    timestamp: Date.now(),
    maxAccuracyMeters: configuredMaxAccuracyMeters(),
    // Deliberately no branchRef / terminalRef: identity + site are server-side.
  });

  return json(outcome.payload, outcome.status);
}
