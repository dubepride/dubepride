/**
 * ============================================================================
 *  GET /api/employees/search?q=… — dashboard employee search (Objective 4)
 * ============================================================================
 *
 *  Powers the type-ahead on the dashboard: partial matches on Full_Name or
 *  ERP_User_ID, each hit annotated with 30-day activity so the admin can
 *  spot the right person instantly. Clicking a hit routes to
 *  /employees/[id] (the weekly timesheet).
 */

import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { searchEmployees } from "@/lib/db";
import type { EmployeeSearchResponse, EmployeeSearchResult } from "@/lib/types";

export async function GET(request: NextRequest): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;

  const q = request.nextUrl.searchParams.get("q") ?? "";

  const results: EmployeeSearchResult[] = searchEmployees(q, 10).map((r) => ({
    id: r.Employee_ID,
    erpUserId: r.ERP_User_ID,
    fullName: r.Full_Name,
    department: r.Department,
    enrolled: r.Fingerprint_Enrolled === 1,
    punches30d: Number(r.Punches_30d ?? 0),
    lastPunch: r.Last_Punch ?? null,
  }));

  const payload: EmployeeSearchResponse = { query: q, results, generatedAt: Date.now() };
  return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
}
