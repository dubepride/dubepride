/**
 * ============================================================================
 *  GET /api/reports — live Reports & Analytics payload
 * ============================================================================
 *
 *  The /reports page used to render a static mock dataset. This endpoint
 *  replaces it with aggregates derived from the real Attendance_Logs,
 *  Employees, Terminals and Shifts tables:
 *
 *    trends      — one point per day for the last `days` calendar days
 *    branches    — exception totals grouped by the punch's branch
 *    events      — most recent exceptions (capped for the table)
 *    attendance  — every employee × day row for the CSV exports
 *    summary     — headline KPIs / rates
 *
 *  Query parameters
 *    days=<n>   rolling window, 1–31 (default 7)
 *
 *  Admin-only, cache-free. The page also polls /api/dashboard for today's
 *  roster counters, so its quick-stat tiles always match the dashboard.
 */

import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getReports } from "@/lib/db";
import type { ReportsResponse } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;

  const raw = request.nextUrl.searchParams.get("days");
  const parsed = raw !== null && /^\d+$/.test(raw) ? Number(raw) : 7;

  const payload: ReportsResponse = await getReports(parsed);
  return Response.json(payload, { headers: NO_STORE });
}
