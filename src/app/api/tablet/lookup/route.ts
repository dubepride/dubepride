/**
 * ============================================================================
 *  GET /api/tablet/lookup — Instant Employee Lookup for Tablet Station
 * ============================================================================
 *
 *  Called by the shared tablet / work phone station when a worker enters their
 *  Employee Number (e.g. EMP1003 or 1003). Returns their profile, department,
 *  branch, shift schedule, and today's clock status so they can punch in/out.
 */

import { type NextRequest, NextResponse } from "next/server";
import { currentAccount, requirePermission, unauthorizedResponse, forbiddenResponse } from "@/lib/auth";
import { employeeDayStatus, getDb, hasPersonalMobilePin, inferDirection, queryOne, resolveEmployee } from "@/lib/db";
import type { ShiftRow } from "@/lib/types";

export async function GET(request: NextRequest): Promise<Response> {
  const guard = await requirePermission("can_view_tablet_station");
  if (guard) return guard;

  const account = await currentAccount();
  if (!account) return unauthorizedResponse();
  if (account.permissions.can_view_tablet_station !== true && !account.permissions.can_view_dashboard) {
    return forbiddenResponse();
  }

  const { searchParams } = new URL(request.url);
  const ref = searchParams.get("ref")?.trim() || "";
  if (!ref) {
    return NextResponse.json(
      { ok: false, error: "Please enter an Employee Number." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const db = await getDb();
  const employee = await resolveEmployee(db, ref);
  if (!employee) {
    return NextResponse.json(
      { ok: false, error: `Employee "${ref}" not found in system.` },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    );
  }

  if (employee.Status && employee.Status !== "Active") {
    return NextResponse.json(
      { ok: false, error: `Employee ${employee.Full_Name} (${employee.ERP_User_ID}) is marked as ${employee.Status}.` },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Fetch shift details if assigned
  let shift: ShiftRow | null = null;
  if (employee.Shift_ID != null) {
    shift =
      (await queryOne<ShiftRow>(
        db,
        "SELECT * FROM Shifts WHERE Shift_ID = ? LIMIT 1",
        employee.Shift_ID
      )) ?? null;
  }

  // Fetch today's punch state & infer next direction
  const now = Date.now();
  const dayStatus = await employeeDayStatus(employee.Employee_ID);
  const nextDirection = await inferDirection(employee.Employee_ID, now);
  const hasPin = await hasPersonalMobilePin(employee.Employee_ID);

  return NextResponse.json(
    {
      ok: true,
      employee: {
        id: employee.Employee_ID,
        erpUserId: employee.ERP_User_ID,
        fullName: employee.Full_Name,
        department: employee.Department || "General",
        position: employee.Position || "Staff",
        branch: employee.Branch_Name || account.branchName || "Unassigned",
        shiftName: shift?.Name ?? "Standard Shift",
        shiftHours: shift ? `${shift.Start_Time} → ${shift.End_Time}` : "08:00 → 17:00",
        hasPin,
      },
      status: {
        clockedIn: dayStatus.clockedIn,
        lastPunchAt: dayStatus.lastPunchAt,
        lastDirection: dayStatus.lastDirection,
        nextDirection,
      },
      stationBranch: account.branchName || employee.Branch_Name || null,
      serverTime: now,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
