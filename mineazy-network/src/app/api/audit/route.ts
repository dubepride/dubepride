/**
 * ============================================================================
 *  GET /api/audit — the administrative audit trail
 * ============================================================================
 *
 *  Who changed what, and when. Read-only: the trail is append-only and is
 *  written by the server, never by the browser.
 * ============================================================================
 */

import { listAudit } from "@/lib/repo/audit";
import { requirePermission, ok, intParam } from "@/lib/api";

export async function GET(request: Request): Promise<Response> {
  const gate = await requirePermission("can_view_reports");
  if (gate.response) return gate.response;

  const entries = await listAudit(intParam(request, "limit", 200));
  return ok({ entries, count: entries.length });
}
