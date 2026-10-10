/**
 * ============================================================================
 *  GET /api/my-portal — the worker clocking hub orientation (Phase 14)
 * ============================================================================
 *
 *  Returns the signed-in System Account plus the roster identity linked to
 *  it (Employee_ID on the account row — set when the account was created)
 *  and the "am I clocked in today?" status derived from their punches.
 *
 *  Server-side protection: requires can_view_my_portal.
 */

import { currentAccount, forbiddenResponse, requirePermission, unauthorizedResponse } from "@/lib/auth";
import { employeeDayStatus, getDb, resolveEmployee } from "@/lib/db";
import type { MyPortalResponse } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(): Promise<Response> {
  const guard = await requirePermission("can_view_my_portal");
  if (guard) return guard;

  const account = await currentAccount();
  if (!account) return unauthorizedResponse();
  if (account.permissions.can_view_my_portal !== true) return forbiddenResponse();

  const employee =
    account.employeeId != null ? resolveEmployee(getDb(), String(account.employeeId)) : null;

  const status = employee ? employeeDayStatus(employee.Employee_ID) : undefined;

  const payload: MyPortalResponse = {
    ok: true,
    account: {
      accountId: account.accountId,
      name: account.name,
      email: account.email,
      levelName: account.levelName,
      branchName: account.branchName,
    },
    employee: employee
      ? {
          id: employee.Employee_ID,
          erpUserId: employee.ERP_User_ID,
          fullName: employee.Full_Name,
          department: employee.Department,
          position: employee.Position,
          branch: employee.Branch_Name || null,
          enrolled: employee.Fingerprint_Enrolled === 1,
        }
      : null,
    status: status ?? { clockedIn: false, lastPunchAt: null, lastDirection: null },
    generatedAt: Date.now(),
  };
  return Response.json(payload, { headers: NO_STORE });
}