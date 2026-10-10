/**
 * GET /api/whos-in — live presence roster (Phase 7, Objective 5).
 *
 * Returns every employee whose LATEST punch today is a Clock In
 * (Direction = 'IN') — i.e. clocked in with no matching Clock Out yet —
 * newest first, each carrying the capturing terminal's Branch_Name so
 * the page can group the roster per branch. Admin-only (the proxy
 * filters unauthenticated callers, requireAdmin re-checks) and
 * cache-free so the 5-second poll always reflects punches captured
 * since the last tick.
 */

import { requireAdmin } from "@/lib/auth";
import { listWhoIsIn } from "@/lib/db";
import type { WhosInPerson, WhosInResponse } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;

  const people: WhosInPerson[] = listWhoIsIn().map((r) => ({
    employeeId: r.Employee_ID,
    erpUserId: r.ERP_User_ID,
    fullName: r.Full_Name,
    department: r.Department,
    branchName: r.Branch_Name,
    locationName: r.Location_Name,
    clockedInAt: r.Clocked_In_At,
  }));

  const payload: WhosInResponse = {
    people,
    count: people.length,
    generatedAt: Date.now(),
  };
  return Response.json(payload, { headers: NO_STORE });
}
