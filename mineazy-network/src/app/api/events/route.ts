/**
 * ============================================================================
 *  GET /api/events — the operational event history
 * ============================================================================
 *
 *  Append-only, filterable and paginated. The Event History screen reads
 *  this; the export in Reports reads the same rows.
 * ============================================================================
 */

import { listEvents } from "@/lib/repo/events";
import { requirePermission, ok, stringParam, intParam, numberParam } from "@/lib/api";

export async function GET(request: Request): Promise<Response> {
  const gate = await requirePermission("can_view_reports");
  if (gate.response) return gate.response;

  const sinceParam = stringParam(request, "since");
  const since = sinceParam ? Number(sinceParam) : undefined;

  const events = await listEvents({
    limit: intParam(request, "limit", 200),
    since: Number.isFinite(since) ? since : undefined,
    type: stringParam(request, "type") ?? undefined,
    severity: stringParam(request, "severity") ?? undefined,
    subjectType: stringParam(request, "subjectType") ?? undefined,
    subjectId: numberParam(request, "subjectId") ?? undefined,
  });

  return ok({ events, count: events.length });
}
