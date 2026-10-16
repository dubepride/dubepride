/**
 * ============================================================================
 *  GET /api/attendance/geofence-activity — the mobile-GPS reporting feed
 * ============================================================================
 *
 *  Powers the "Mobile GPS Clocking" card on Attendance Records (Phase 9):
 *  every GPS-validated punch with its distance, accuracy and verdict, plus a
 *  summary comparing geofence traffic with the biometric/remote channels.
 *
 *  Query parameters
 *    from=YYYY-MM-DD    range start (default: 7 days ago)
 *    to=YYYY-MM-DD      range end, inclusive (default: today)
 *    branch=<name>      governing site (default: all)
 *    verdict=accepted|rejected   verification outcome (default: all)
 *    employeeId=<id>    one employee (default: all)
 *    page=<n>           1-based page (default 1)
 *    pageSize=<n>       rows per page (default 50, max 200)
 *
 *  Server-side protection: requireAdmin — the same guard as the day-grouped
 *  Attendance Records feed it sits beside. Read-only.
 */

import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { listGeofenceActivity } from "@/lib/db";
import { startOfTodayMs } from "@/lib/format";
import type { GeofenceActivityResponse } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };
const DAY_MS = 86_400_000;

/** "2026-10-09" → local midnight epoch ms (null when malformed). */
function parseDay(value: string | null): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export async function GET(request: NextRequest): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;

  const sp = request.nextUrl.searchParams;
  const today = startOfTodayMs();

  const fromMs = parseDay(sp.get("from")) ?? today - 6 * DAY_MS;
  const toDay = parseDay(sp.get("to")) ?? today;
  const toMs = toDay + DAY_MS;

  const branch = (sp.get("branch") ?? "").trim();
  const verdictRaw = (sp.get("verdict") ?? "").trim();
  const verdict: "accepted" | "rejected" | undefined =
    verdictRaw === "accepted" || verdictRaw === "rejected" ? verdictRaw : undefined;
  const employeeRaw = sp.get("employeeId") ?? "";
  const employeeId = /^\d+$/.test(employeeRaw) ? Number(employeeRaw) : undefined;

  const page = Number(sp.get("page") ?? "1");
  const pageSize = Math.min(200, Number(sp.get("pageSize") ?? "50"));

  const result = await listGeofenceActivity({
    fromMs: Math.min(fromMs, toMs),
    toMs: Math.max(fromMs, toMs),
    branch: branch || undefined,
    verdict,
    employeeId: employeeId ?? undefined,
    page: Number.isFinite(page) && page >= 1 ? page : 1,
    pageSize: Number.isFinite(pageSize) && pageSize >= 1 ? pageSize : 50,
  });

  const payload: GeofenceActivityResponse = {
    ok: true,
    rows: result.rows,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    pages: result.pages,
    accepted: result.accepted,
    rejected: result.rejected,
    totalBiometric: result.totalBiometric,
    totalGeofence: result.totalGeofence,
    branches: result.branches,
    generatedAt: result.generatedAt,
  };
  return Response.json(payload, { headers: NO_STORE });
}
