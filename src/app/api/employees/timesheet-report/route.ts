/**
 * ============================================================================
 *  GET /api/employees/timesheet-report — custom-period timesheet report
 * ============================================================================
 *
 *  Builds the "report format" behind the Employee Directory's Timesheet
 *  Report action: for every employee (or the ?q-filtered subset) it returns
 *  one row per calendar day in the requested period, computed by the exact
 *  same pairing/worked-time logic as the /employees/[id] timesheet.
 *
 *  Query params (all optional):
 *    from   — inclusive start "YYYY-MM-DD"  (default: 29 days ago)
 *    to     — inclusive end   "YYYY-MM-DD"  (default: today)
 *    q      — directory search filter (name / ERP id; empty = whole roster)
 *
 *  The UI renders this payload as a printable report document (PDF via the
 *  browser's print dialog) — see components/TimesheetReport.tsx.
 */

import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getEmployeeLogs, listEmployees } from "@/lib/db";
import { dateKeyOf } from "@/lib/format";
import { addDays, buildDay } from "@/lib/timesheet";
import type {
  EmployeePunchRow,
  TimesheetDay,
  TimesheetReportDay,
  TimesheetReportEmployee,
  TimesheetReportResponse,
} from "@/lib/types";

const DAY_MS = 86_400_000;
const MAX_SPAN_DAYS = 366;

const NO_STORE = { "Cache-Control": "no-store" };

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/** "2026-10-07" → local midnight ms (validates the calendar date strictly). */
function parseLocalDay(key: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  if (Number.isNaN(d.getTime())) return null;
  if (dateKeyOf(d.getTime()) !== key) return null; // rejects 2026-02-31
  return d.getTime();
}

/** TimesheetDay → wire shape (drops the full punch list, keeps the count). */
function toReportDay(day: TimesheetDay): TimesheetReportDay {
  return {
    dateKey: day.dateKey,
    dayName: day.dayName,
    dateLabel: day.dateLabel,
    dateMs: day.dateMs,
    firstIn: day.firstIn,
    lastOut: day.lastOut,
    workedMs: day.workedMs,
    punches: day.punches.length,
    openShift: day.openShift,
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  // Admin-only data: the proxy already filters; re-check here too.
  const guard = await requireAdmin();
  if (guard) return guard;

  const params = request.nextUrl.searchParams;
  const q = params.get("q") ?? "";
  const now = Date.now();

  const defaultFromKey = dateKeyOf(now - 29 * DAY_MS);
  const fromKey = params.get("from")?.trim() || defaultFromKey;
  const toKey = params.get("to")?.trim() || dateKeyOf(now);

  const fromDay = parseLocalDay(fromKey);
  const toDay = parseLocalDay(toKey);
  if (fromDay === null || toDay === null) {
    return bad("from and to must be valid YYYY-MM-DD dates.");
  }
  if (toDay < fromDay) return bad("The end date is before the start date.");
  const spanDays = Math.round((toDay - fromDay) / DAY_MS) + 1;
  if (spanDays > MAX_SPAN_DAYS) {
    return bad("That period is too long — the limit is 366 days.");
  }
  const toMs = toDay + DAY_MS - 1; // inclusive end of `to` day

  const employees: TimesheetReportEmployee[] = [];
  for (const row of await listEmployees(q)) {
    const logs = await getEmployeeLogs(row.Employee_ID, fromDay, toMs);

    // Bucket by local day so buildDay gets exactly one day's punches.
    const byDay = new Map<string, EmployeePunchRow[]>();
    for (const log of logs) {
      const key = dateKeyOf(log.Timestamp);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(log);
      else byDay.set(key, [log]);
    }

    const days: TimesheetReportDay[] = [];
    let cursor = fromDay;
    let guard = 0; // hard stop against pathological ranges
    while (cursor <= toDay && guard++ <= MAX_SPAN_DAYS) {
      days.push(toReportDay(buildDay(cursor, byDay.get(dateKeyOf(cursor)) ?? [], now)));
      cursor = addDays(cursor, 1);
    }

    const daysWorked = days.reduce((n, d) => n + (d.firstIn !== null ? 1 : 0), 0);
    const punches = days.reduce((n, d) => n + d.punches, 0);
    const workedMs = days.reduce((n, d) => n + d.workedMs, 0);

    employees.push({
      id: row.Employee_ID,
      erpUserId: row.ERP_User_ID,
      fullName: row.Full_Name,
      department: row.Department ?? "",
      position: row.Position ?? "",
      days,
      daysWorked,
      punches,
      workedMs,
    });
  }

  const totals = employees.reduce(
    (acc, e) => ({
      employees: acc.employees + 1,
      daysWorked: acc.daysWorked + e.daysWorked,
      punches: acc.punches + e.punches,
      workedMs: acc.workedMs + e.workedMs,
    }),
    { employees: 0, daysWorked: 0, punches: 0, workedMs: 0 }
  );

  const payload: TimesheetReportResponse = {
    query: q,
    period: { fromKey, toKey, fromMs: fromDay, toMs },
    employees,
    totals,
    generatedAt: now,
  };
  return Response.json(payload, { headers: NO_STORE });
}