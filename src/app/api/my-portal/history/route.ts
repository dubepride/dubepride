/**
 * ============================================================================
 *  GET /api/my-portal/history — the worker's own punch history (Phase 14)
 * ============================================================================
 *
 *  The employee linked to the signed-in account's most recent punches
 *  (newest first, capped at 30). Rendering this table is gated client-side
 *  by can_view_my_history AND server-side by requirePermission here — a
 *  hand-typed fetch without the capability still gets a 403.
 */

import { currentAccount, forbiddenResponse, requirePermission, unauthorizedResponse } from "@/lib/auth";
import { getDb, getEmployeeRecentPunches, resolveEmployee } from "@/lib/db";
import type { MyPortalHistoryResponse } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(): Promise<Response> {
  const guard = await requirePermission("can_view_my_history");
  if (guard) return guard;

  const account = await currentAccount();
  if (!account) return unauthorizedResponse();
  if (account.permissions.can_view_my_history !== true) return forbiddenResponse();

  const employee =
    account.employeeId != null ? await resolveEmployee(await getDb(), String(account.employeeId)) : null;

  const payload: MyPortalHistoryResponse = {
    ok: true,
    employeeId: employee?.Employee_ID ?? null,
    employeeName: employee?.Full_Name ?? "No linked employee",
    rows: employee ? await getEmployeeRecentPunches(employee.Employee_ID, 30) : [],
    generatedAt: Date.now(),
  };
  return Response.json(payload, { headers: NO_STORE });
}