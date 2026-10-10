/**
 * ============================================================================
 *  POST /api/attendance/punch — manual admin punch (Phase 11 "Ready to Clock")
 * ============================================================================
 *
 *  Lets an administrator simulate a biometric punch from the dashboard's
 *  test widget: pick an employee, a direction (IN/OUT) and optionally a
 *  terminal, and the bridge writes a Verified punch exactly the way the
 *  HTTP push listener would — as Pending, ready for the next ERP sync.
 *
 *  Body: {
 *    employeeRef?: string   // ERP id or Employee_ID (default: first roster row)
 *    direction?:   "IN" | "OUT"   // omitted → inferred from today's sequence
 *    terminalId?:  number         // omitted → first ONLINE terminal
 *  }
 */

import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  allEmployees,
  allTerminalRows,
  inferDirection,
  insertPunch,
  resolveEmployee,
  getDb,
} from "@/lib/db";
import type { PunchDirection } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

export async function POST(request: NextRequest): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("Invalid JSON body.");
  }

  const roster = allEmployees();
  if (roster.length === 0) return bad("The roster is empty — nothing to punch.", 409);

  // ── Employee ──────────────────────────────────────────────────────
  const refRaw = body.employeeRef;
  const ref = refRaw === undefined || refRaw === null || refRaw === "" ? null : String(refRaw);
  const employee = ref ? resolveEmployee(getDb(), ref) : roster[0];
  if (!employee) return bad(`No employee matches "${ref}".`);

  // ── Terminal ──────────────────────────────────────────────────────
  const terminals = allTerminalRows();
  let terminalId: number | null = null;
  if (body.terminalId !== undefined && body.terminalId !== null) {
    const n = Number(body.terminalId);
    if (!Number.isInteger(n)) return bad("terminalId must be an integer.");
    if (!terminals.some((t) => t.Terminal_ID === n)) return bad(`Unknown terminal ${n}.`);
    terminalId = n;
  } else {
    const online = terminals.filter((t) => t.Status === "Online");
    terminalId = (online[0] ?? terminals[0])?.Terminal_ID ?? null;
  }

  // ── Direction ─────────────────────────────────────────────────────
  const timestamp = Date.now();
  let direction: PunchDirection;
  if (body.direction !== undefined) {
    const d = String(body.direction).toUpperCase();
    if (d !== "IN" && d !== "OUT") return bad('direction must be "IN" or "OUT".');
    direction = d;
  } else {
    direction = inferDirection(employee.Employee_ID, timestamp);
  }

  insertPunch({
    employeeRef: employee.ERP_User_ID,
    timestamp,
    terminalId,
    verifyResult: "Verified",
    verifyMethod: "Manual",
    direction,
    rawPayload: `MANUAL id=${employee.Employee_ID}&by=admin&dir=${direction}`,
  });

  const terminal = terminals.find((t) => t.Terminal_ID === terminalId);

  return Response.json(
    {
      ok: true,
      punch: {
        employeeId: employee.Employee_ID,
        employeeName: employee.Full_Name,
        erpUserId: employee.ERP_User_ID,
        timestamp,
        direction,
        terminalId,
        terminalName: terminal?.Location_Name ?? null,
        branch: terminal?.Branch_Name ?? null,
      },
    },
    { headers: NO_STORE }
  );
}
