/**
 * ============================================================================
 *  POST /api/tablet/clock — Record Attendance Punch from Tablet Station
 * ============================================================================
 *
 *  Commits a verified punch from the work tablet / phone station directly
 *  into SQLite. Attributed to the tablet station's assigned branch with
 *  verifyMethod = "Tablet Station", ready for live dashboard & ERP sync.
 */

import { type NextRequest, NextResponse } from "next/server";
import { currentAccount, forbiddenResponse, requirePermission, unauthorizedResponse } from "@/lib/auth";
import {
  getDb,
  inferDirection,
  insertPunch,
  resolveEmployee,
  verifyEmployeeMobilePin,
} from "@/lib/db";
import type { PunchDirection } from "@/lib/types";

export async function POST(request: NextRequest): Promise<Response> {
  const guard = await requirePermission("can_view_tablet_station");
  if (guard) return guard;

  const account = await currentAccount();
  if (!account) return unauthorizedResponse();
  if (account.permissions.can_view_tablet_station !== true && !account.permissions.can_view_dashboard) {
    return forbiddenResponse();
  }

  let body: { employeeRef?: string; direction?: string; pin?: string };
  try {
    body = (await request.json()) as { employeeRef?: string; direction?: string; pin?: string };
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON payload." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const ref = (body.employeeRef ?? "").trim();
  if (!ref) {
    return NextResponse.json(
      { ok: false, error: "Employee Number is required." },
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
      { ok: false, error: `Cannot clock: ${employee.Full_Name} is marked as ${employee.Status}.` },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }

  // If a PIN is supplied, verify it against the employee's record
  if (body.pin) {
    const validPin = await verifyEmployeeMobilePin(employee, body.pin.trim());
    if (!validPin) {
      return NextResponse.json(
        { ok: false, error: "Incorrect 4-digit PIN." },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }
  }

  const timestamp = Date.now();
  let direction: PunchDirection;
  if (body.direction === "IN" || body.direction === "OUT") {
    direction = body.direction;
  } else {
    direction = await inferDirection(employee.Employee_ID, timestamp);
  }

  // Tablet branch takes precedence, then employee branch, then unassigned
  const targetBranch = account.branchName || employee.Branch_Name || "Main Office";

  const punchId = await insertPunch({
    employeeRef: employee.ERP_User_ID,
    timestamp,
    terminalId: null,
    erpSyncStatus: "Pending",
    verifyResult: "Verified",
    verifyMethod: "Tablet Station",
    direction,
    branchName: targetBranch,
    rawPayload: `TABLET id=${employee.Employee_ID}&emp=${employee.ERP_User_ID}&station=${account.name}&branch=${targetBranch}&dir=${direction}`,
  });

  const clockTime = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));

  return NextResponse.json(
    {
      ok: true,
      punch: {
        punchId,
        employeeId: employee.Employee_ID,
        erpUserId: employee.ERP_User_ID,
        employeeName: employee.Full_Name,
        timestamp,
        direction,
        branch: targetBranch,
        clockTime,
      },
      message: `${employee.Full_Name} clocked ${direction === "IN" ? "IN" : "OUT"} at ${clockTime}.`,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
