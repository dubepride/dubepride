/**
 * ============================================================================
 *  GET /api/employees/[id] — employee profile + weekly timesheet (Obj. 4)
 * ============================================================================
 *
 *  `id` accepts either the internal Employee_ID or the ERP_User_ID.
 *
 *  Returns:
 *    • employee    — header fields for the profile card
 *    • weeks[]     — punches grouped by week (Week 1 … Week 8), each week
 *                    holding Monday→Saturday days with the full punch
 *                    sequence (Morning in → Lunch out → Return in →
 *                    Knock off out) in chronological order
 *    • stats       — window aggregates (punches, days, hours, branches)
 *
 *  Window = the current week plus the previous 7 (8 calendar weeks).
 */

import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getDb, getEmployeeLogs, parseFingers, resolveEmployee } from "@/lib/db";
import { buildTimesheet, startOfWeekMs } from "@/lib/timesheet";
import type { EmployeeProfileResponse } from "@/lib/types";

const WEEK_MS = 7 * 86_400_000;

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;

  const { id } = await ctx.params;
  const employee = await resolveEmployee(await getDb(), id);
  if (!employee) {
    return Response.json(
      { ok: false, error: `No employee matches "${id}".` },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    );
  }

  const now = Date.now();
  const fromMs = startOfWeekMs(now) - 7 * WEEK_MS; // 8 weeks incl. current
  const toMs = now;

  const logs = await getEmployeeLogs(employee.Employee_ID, fromMs, toMs);
  const weeks = buildTimesheet(logs, { fromMs, toMs, now });

  // Window aggregates (derived from the same grouped data the UI renders).
  const daysPresent = weeks.reduce(
    (sum, w) => sum + w.totals.daysWorked,
    0
  );
  const workedMs = weeks.reduce((sum, w) => sum + w.totals.workedMs, 0);
  const branchesUsed = Array.from(
    new Set(
      logs
        .map((l) => l.Branch_Name)
        .filter((b): b is string => Boolean(b))
    )
  ).sort();

  const payload: EmployeeProfileResponse = {
    employee: {
      id: employee.Employee_ID,
      erpUserId: employee.ERP_User_ID,
      fullName: employee.Full_Name,
      department: employee.Department,
      enrolled: employee.Fingerprint_Enrolled === 1,
      fingers: parseFingers(employee.Fingers_Enrolled),
      createdAt: employee.Created_At,
    },
    weeks,
    stats: {
      punchesInWindow: logs.length,
      daysPresent,
      workedMs,
      branchesUsed,
      lastPunch: logs.length > 0 ? logs[logs.length - 1].Timestamp : null,
    },
    window: { fromMs, toMs },
    generatedAt: now,
  };
  return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
}
