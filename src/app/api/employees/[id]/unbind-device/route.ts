/**
 * ============================================================================
 *  POST /api/employees/[id]/unbind-device — Reset Mobile Device Binding
 * ============================================================================
 *
 *  Allows an administrator to unbind the hardware device currently locked to
 *  an employee (e.g. when the employee replaces or loses their phone).
 *  On the employee's next login on their new phone, the new phone will bind
 *  automatically.
 */

import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getDb, resolveEmployee, unbindEmployeeDevice } from "@/lib/db";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;

  const { id } = await ctx.params;
  const employee = await resolveEmployee(await getDb(), id);
  if (!employee) {
    return Response.json(
      { ok: false, error: `No employee matches "${id}".` },
      { status: 404, headers: NO_STORE }
    );
  }

  await unbindEmployeeDevice(employee.Employee_ID);

  return Response.json(
    {
      ok: true,
      employeeId: employee.Employee_ID,
      message: `Mobile device binding reset for ${employee.Full_Name} (${employee.ERP_User_ID}). Their next sign-in will register their new device.`,
    },
    { headers: NO_STORE }
  );
}
