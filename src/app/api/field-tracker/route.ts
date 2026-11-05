/**
 * ============================================================================
 *  GET /api/field-tracker — live device map snapshot (Field Tracker)
 * ============================================================================
 *
 *  Returns every tracked phone inside the organisation's geofences, with the
 *  SERVER deciding which fence a fix falls inside. The page never trusts a
 *  client-reported branch: `listFieldTracker()` re-derives containment from
 *  the fix and the live fence geometry on every request.
 *
 *  Access is gated by the dedicated `can_view_live_map` capability — a user
 *  without it gets 403 even though they hold a valid session. The proxy also
 *  blocks the /field-tracker page itself.
 *
 *  Query parameters
 *    branch=<name>     only devices inside this fence (case-insensitive)
 *    q=<text>          filter by employee number or name
 *    includeOffsite=1  also return tracked devices outside every fence
 *
 *  Read-only, cache-free (the page polls). One opportunistic retention sweep
 *  runs here so stale rows cannot accumulate.
 */

import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth";
import { listFieldTracker, purgeEmployeePresence } from "@/lib/db";
import type { FieldTrackerResponse } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest): Promise<Response> {
  const guard = await requirePermission("can_view_live_map");
  if (guard) return guard;

  await purgeEmployeePresence();

  const params = request.nextUrl.searchParams;
  const branch = params.get("branch");
  const query = params.get("q");
  const includeOffsite = ["1", "true", "yes"].includes(
    (params.get("includeOffsite") ?? "").trim().toLowerCase()
  );

  const snapshot = await listFieldTracker({
    branch,
    query,
    includeOffsite,
  });

  const payload: FieldTrackerResponse = {
    ok: true,
    scope: "org",
    sites: snapshot.sites,
    devices: snapshot.devices,
    counts: snapshot.counts,
    staleAfterMs: snapshot.staleAfterMs,
    presenceWindowMs: snapshot.presenceWindowMs,
    generatedAt: Date.now(),
  };
  return Response.json(payload, { headers: NO_STORE });
}
