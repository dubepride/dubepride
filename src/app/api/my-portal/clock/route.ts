/**
 * ============================================================================
 *  POST /api/my-portal/clock — remote clock in / out (Phase 14)
 * ============================================================================
 *
 *  The worker's big Remote Clocking button. Inserts a punch for the
 *  employee linked to the signed-in account using the same single write
 *  path as the fingerprint terminals (insertPunch → Pending row → ERP sync
 *  drains it), with the direction inferred from the employee's day
 *  sequence (IN → OUT → IN …).
 *
 *  Server-side protection: requires can_remote_clock. Accounts without a
 *  linked employee get a clear 400.
 */

import type { NextRequest } from "next/server";
import { currentAccount, forbiddenResponse, requirePermission, unauthorizedResponse } from "@/lib/auth";
import {
  getDb,
  inferDirection,
  insertPunch,
  resolveEmployee,
} from "@/lib/db";
import type { MyPortalClockResponse } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status, headers: NO_STORE });
}

export async function POST(_request: NextRequest): Promise<Response> {
  const guard = await requirePermission("can_remote_clock");
  if (guard) return guard;

  const account = await currentAccount();
  if (!account) return unauthorizedResponse();
  if (account.permissions.can_remote_clock !== true) return forbiddenResponse();

  if (account.employeeId == null) {
    return bad("No roster employee is linked to this account — ask a manager to link one.");
  }

  const employee = await resolveEmployee(await getDb(), String(account.employeeId));
  if (!employee) {
    return bad("The linked roster employee no longer exists.", 409);
  }

  const timestamp = Date.now();
  const direction = await inferDirection(employee.Employee_ID, timestamp);

  await insertPunch({
    employeeRef: String(employee.Employee_ID),
    timestamp,
    terminalId: null,
    verifyResult: "Verified",
    verifyMethod: "Remote Portal",
    direction,
  });

  const clock = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));

  const payload: MyPortalClockResponse = {
    ok: true,
    punch: {
      employeeName: employee.Full_Name,
      timestamp,
      direction,
      terminalName: null,
    },
    message: `${employee.Full_Name} clocked ${direction === "IN" ? "in" : "out"} at ${clock}.`,
  };
  return Response.json(payload, { headers: NO_STORE });
}