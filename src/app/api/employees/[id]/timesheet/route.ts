/**
 * ============================================================================
 *  GET /api/employees/[id]/timesheet — individual employee timesheet export
 * ============================================================================
 *
 *  One employee, one custom period. Backs the "Timesheet Export" panel on the
 *  Employee Directory and the employee's own timesheet page:
 *
 *    ?from=YYYY-MM-DD&to=YYYY-MM-DD   inclusive custom range (max 366 days)
 *    ?all=1                           every record for the employee
 *    ?format=csv                      text/csv download (UTF-8 + BOM)
 *                                     default: application/json preview
 *
 *  `id` accepts either the internal Employee_ID or the ERP_User_ID and is
 *  resolved server-side, so a manipulated id can never widen the scope beyond
 *  the single resolved employee.
 *
 *  The payload is built by the exact same pairing / worked-time logic the
 *  weekly timesheet uses (lib/timesheet.buildDay), so first-in, last-out,
 *  hours and the chronological In → Out sequence always agree with the UI.
 */

import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  getDb,
  getEmployeeFirstLog,
  getEmployeeLogs,
  parseFingers,
  resolveEmployee,
} from "@/lib/db";
import { dateKeyOf } from "@/lib/format";
import {
  buildExportDays,
  exportFilename,
  exportTotals,
  timesheetExportToCsv,
} from "@/lib/timesheet-export";
import type { EmployeeTimesheetExport } from "@/lib/types";

const DAY_MS = 86_400_000;
/** Explicit custom ranges are capped like the roster-wide report. */
const MAX_SPAN_DAYS = 366;
/** "All records" spans the employee's whole history — still sanity-bounded. */
const MAX_ALL_DAYS = 3660;

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

/** Local midnight of the day containing `ms`. */
function localMidnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  // Admin-only data: the proxy already filters; re-check here too.
  const guard = await requireAdmin();
  if (guard) return guard;

  const { id } = await ctx.params;
  const employee = resolveEmployee(getDb(), id);
  if (!employee) {
    return bad(`No employee matches "${id}".`, 404);
  }

  const params = request.nextUrl.searchParams;
  const format = (params.get("format") ?? "json").toLowerCase();
  const all = params.get("all") === "1";
  const now = Date.now();

  let fromDay: number;
  let toDay: number;

  if (all) {
    const earliest = getEmployeeFirstLog(employee.Employee_ID);
    fromDay = localMidnight(earliest ?? now - 29 * DAY_MS);
    toDay = localMidnight(now);
    const span = Math.round((toDay - fromDay) / DAY_MS) + 1;
    if (span > MAX_ALL_DAYS) {
      return bad("The employee's record history is too large to export at once.");
    }
  } else {
    const fromKey = params.get("from")?.trim();
    const toKey = params.get("to")?.trim();
    if (!fromKey || !toKey) {
      return bad("Provide from and to (YYYY-MM-DD), or all=1 for every record.");
    }
    const parsedFrom = parseLocalDay(fromKey);
    const parsedTo = parseLocalDay(toKey);
    if (parsedFrom === null || parsedTo === null) {
      return bad("from and to must be valid YYYY-MM-DD dates.");
    }
    if (parsedTo < parsedFrom) {
      return bad("The start date must not be later than the end date.");
    }
    const span = Math.round((parsedTo - parsedFrom) / DAY_MS) + 1;
    if (span > MAX_SPAN_DAYS) {
      return bad("That period is too long — the limit is 366 days.");
    }
    fromDay = parsedFrom;
    toDay = parsedTo;
  }

  const toMs = toDay + DAY_MS - 1; // inclusive end of the `to` day
  const spanDays = Math.round((toDay - fromDay) / DAY_MS) + 1;

  const logs = getEmployeeLogs(employee.Employee_ID, fromDay, toMs);
  const days = buildExportDays(logs, fromDay, toMs, now);

  const payload: EmployeeTimesheetExport = {
    employee: {
      id: employee.Employee_ID,
      erpUserId: employee.ERP_User_ID,
      fullName: employee.Full_Name,
      department: employee.Department ?? "",
      position: employee.Position ?? "",
      branch: employee.Branch_Name ?? "",
      status: employee.Status ?? "",
      enrolled: employee.Fingerprint_Enrolled === 1,
      fingers: parseFingers(employee.Fingers_Enrolled),
      shiftId: employee.Shift_ID ?? null,
    },
    period: {
      fromKey: dateKeyOf(fromDay),
      toKey: dateKeyOf(toDay),
      fromMs: fromDay,
      toMs,
      days: spanDays,
    },
    days,
    totals: exportTotals(days),
    generatedAt: now,
  };

  if (format === "csv") {
    // UTF-8 BOM so Excel detects the encoding; CRLF per RFC 4180.
    const csv = "\uFEFF" + timesheetExportToCsv(payload);
    const filename = exportFilename(
      employee.Full_Name,
      payload.period.fromKey,
      payload.period.toKey,
      "csv"
    );
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        ...NO_STORE,
      },
    });
  }

  return Response.json(payload, { headers: NO_STORE });
}
