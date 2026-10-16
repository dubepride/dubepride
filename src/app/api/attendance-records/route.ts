/**
 * ============================================================================
 *  GET /api/attendance-records — day-grouped attendance log (Phase 11)
 * ============================================================================
 *
 *  Powers /attendance-records: one row per employee × calendar day with
 *  clock in/out, worked time and status, paginated and filterable.
 *
 *  Query parameters
 *    from=YYYY-MM-DD   range start (default: 7 days ago)
 *    to=YYYY-MM-DD     range end, inclusive (default: today)
 *    department=…      exact Department match (default: all)
 *    shift=<id>        Shifts.Shift_ID (default: all)
 *    page=<n>          1-based page (default 1)
 *    pageSize=<n>      rows per page (default 25, max 200)
 */

import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { listAttendanceRecords, listEmployees, listShifts } from "@/lib/db";
import { startOfTodayMs } from "@/lib/format";
import type { AttendanceRecordsResponse } from "@/lib/types";

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
  const toMs = toDay + DAY_MS; // exclusive upper bound covers the whole end day

  const department = (sp.get("department") ?? "").trim();
  const shiftRaw = sp.get("shift") ?? "";
  const shiftId = /^\d+$/.test(shiftRaw) ? Number(shiftRaw) : null;

  const page = Number(sp.get("page") ?? "1");
  const pageSize = Math.min(200, Number(sp.get("pageSize") ?? "25"));

  const result = await listAttendanceRecords({
    fromMs: Math.min(fromMs, toMs),
    toMs: Math.max(fromMs, toMs),
    department: department || undefined,
    shiftId,
    page: Number.isFinite(page) && page >= 1 ? page : 1,
    pageSize: Number.isFinite(pageSize) && pageSize >= 1 ? pageSize : 25,
  });

  // Filter metadata — distinct roster departments + the shift catalogue.
  const departments = [...new Set((await listEmployees("")).map((e) => e.Department).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b)
  );
  const shifts = (await listShifts()).map((s) => ({ id: s.Shift_ID, name: s.Name }));

  const payload: AttendanceRecordsResponse = {
    ...result,
    departments,
    shifts,
    generatedAt: Date.now(),
  };
  return Response.json(payload, { headers: NO_STORE });
}
