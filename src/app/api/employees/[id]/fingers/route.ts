/**
 * ============================================================================
 *  POST /api/employees/[id]/fingers — enrolment console save (hand map)
 * ============================================================================
 *
 *  Body: { fingers: number[] }  — the FULL desired finger set, indexes
 *  0‥4 (thumb → index → middle → ring → little). The console posts the
 *  whole set after every capture so the call stays idempotent.
 *
 *  Behaviour:
 *    • validates / dedupes / sorts the indexes
 *    • stores the canonical form in Employees.Fingers_Enrolled
 *    • keeps Fingerprint_Enrolled in sync (1 as soon as one finger is
 *      captured, 0 when the set empties) — the simulator and dashboard
 *      "ready to clock" logic key off that flag
 *
 *  `id` accepts either the internal Employee_ID or the ERP_User_ID.
 */

import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getDb, parseFingers, resolveEmployee, updateEmployee } from "@/lib/db";
import type { FingersSaveResponse } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status, headers: NO_STORE });
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;

  const { id } = await ctx.params;
  const employee = resolveEmployee(getDb(), id);
  if (!employee) {
    return bad(`No employee matches "${id}".`, 404);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("Invalid JSON body.");
  }

  const raw = body.fingers;
  if (!Array.isArray(raw)) return bad("fingers must be an array of 0‥4 indexes.");

  const fingers: number[] = [];
  for (const item of raw) {
    const n = Number(item);
    if (!Number.isInteger(n) || n < 0 || n > 4) {
      return bad(`Invalid finger index "${String(item)}" — expected 0‥4.`);
    }
    fingers.push(n);
  }
  const stored = parseFingers(fingers.join(","));

  try {
    updateEmployee(employee.Employee_ID, { fingers: stored });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not save the finger set.";
    return bad(message, 500);
  }

  const payload: FingersSaveResponse = {
    ok: true,
    fingers: stored,
    enrolled: stored.length > 0,
  };
  return Response.json(payload, { headers: NO_STORE });
}
