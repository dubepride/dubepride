/**
 * ============================================================================
 *  /api/employees — master employee directory (Phase 5 → 11)
 * ============================================================================
 *
 *  GET    ?q=… → every row from Employees with its most recent
 *                Attendance_Logs timestamp (Last_Seen). Partial matches on
 *                Full_Name OR ERP_User_ID; empty `q` lists the whole roster.
 *                Clicking a row in the UI routes to /employees/[id].
 *
 *  POST   → create { erpUserId, fullName, department, position, branch,
 *                    shiftId, enrolled, status }
 *  PUT    → update { id, …patch }
 *  DELETE → remove { id } (their punches go with them)
 *
 *  Distinct from GET /api/employees/search (dashboard type-ahead: top 10
 *  + 30-day activity counts). Finger sets are saved through
 *  POST /api/employees/[id]/fingers (the enrolment console).
 */

import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  createEmployee,
  deleteEmployee,
  listEmployees,
  parseFingers,
  updateEmployee,
} from "@/lib/db";
import type { EmployeeDirectoryEntry, EmployeeDirectoryResponse } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/** Parsed create/update fields (absent keys = leave unchanged). */
interface ParsedEmployee {
  erpUserId?: string;
  fullName?: string;
  department?: string;
  position?: string;
  branch?: string;
  shiftId?: number | null;
  enrolled?: boolean;
  status?: string;
}

/** Shared field parsing for create/update — `error` non-null on bad input. */
function parseEmployeeBody(
  body: Record<string, unknown>,
  partial: boolean
): { error: string | null; value: ParsedEmployee } {
  const value: ParsedEmployee = {};

  if (body.erpUserId !== undefined) {
    const v = String(body.erpUserId).trim();
    if (!partial && !v) return { error: "ERP user id is required.", value };
    if (v) value.erpUserId = v;
  }
  if (body.fullName !== undefined) {
    const v = String(body.fullName).trim();
    if (!partial && !v) return { error: "Full name is required.", value };
    if (v) value.fullName = v;
  }
  if (body.department !== undefined) value.department = String(body.department).trim();
  if (body.position !== undefined) value.position = String(body.position).trim();
  if (body.branch !== undefined) value.branch = String(body.branch).trim();
  if (body.status !== undefined) value.status = String(body.status).trim();
  if (body.enrolled !== undefined) value.enrolled = Boolean(body.enrolled);
  if (body.shiftId !== undefined) {
    const raw = body.shiftId;
    if (raw === null) value.shiftId = null;
    else {
      const n = Number(raw);
      if (!Number.isInteger(n)) return { error: "shiftId must be an integer or null.", value };
      value.shiftId = n;
    }
  }
  return { error: null, value };
}

export async function GET(request: NextRequest): Promise<Response> {
  // Admin-only data: proxy already filters, re-check here too.
  const guard = await requireAdmin();
  if (guard) return guard;

  const q = request.nextUrl.searchParams.get("q") ?? "";

  const employees: EmployeeDirectoryEntry[] = (await listEmployees(q)).map((r) => {
    const assigned = (r.Branch_Name ?? "").trim();
    return {
      id: r.Employee_ID,
      erpUserId: r.ERP_User_ID,
      fullName: r.Full_Name,
      enrolled: r.Fingerprint_Enrolled === 1,
      fingers: parseFingers(r.Fingers_Enrolled),
      department: r.Department,
      position: r.Position,
      status: r.Status,
      shiftId: r.Shift_ID ?? null,
      lastSeen: r.Last_Seen ?? null,
      // Assigned branch wins; the punch branch covers legacy/blank records.
      branch: assigned || r.Punch_Branch || null,
      assignedBranch: assigned,
    };
  });

  const payload: EmployeeDirectoryResponse = {
    query: q,
    employees,
    generatedAt: Date.now(),
  };
  return Response.json(payload, { headers: NO_STORE });
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

  const { error, value } = parseEmployeeBody(body, false);
  if (error) return bad(error);
  if (!value.erpUserId) return bad("ERP user id is required.");
  if (!value.fullName) return bad("Full name is required.");

  try {
    const id = await createEmployee({
      erpUserId: value.erpUserId,
      fullName: value.fullName,
      department: value.department ?? "",
      position: value.position ?? "",
      branch: value.branch ?? "",
      shiftId: value.shiftId ?? null,
      enrolled: value.enrolled ?? false,
      status: value.status ?? "Active",
    });
    return Response.json({ ok: true, id }, { headers: NO_STORE });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not create the employee.";
    return bad(
      message.includes("UNIQUE")
        ? `An employee with ERP id "${value.erpUserId}" already exists.`
        : message
    );
  }
}

export async function PUT(request: NextRequest): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("Invalid JSON body.");
  }

  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return bad("A numeric employee id is required.");

  const { error, value } = parseEmployeeBody(body, true);
  if (error) return bad(error);

  try {
    await updateEmployee(id, value);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not update the employee.";
    return bad(message.includes("UNIQUE") ? "That ERP user id is already in use." : message);
  }
}

export async function DELETE(request: NextRequest): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("Invalid JSON body.");
  }

  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return bad("A numeric employee id is required.");

  await deleteEmployee(id);
  return Response.json({ ok: true }, { headers: NO_STORE });
}
