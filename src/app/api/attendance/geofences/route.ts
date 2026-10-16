/**
 * ============================================================================
 *  GET /api/attendance/geofences — sites for the browser clock-in map
 * ============================================================================
 *
 *  Returns every site a browser self-clock may be validated against: mobile-
 *  capable (Clocking_Method Geofence/Both) AND geo-ready (a usable centre +
 *  radius). It exists so My Portal can draw the fences and show how far the
 *  worker is from the nearest one.
 *
 *  This list is DISPLAY ONLY. The bridge re-derives the governing site from
 *  the submitted coordinates on every punch (src/lib/geo-punch.ts), so a
 *  client that edits this list in memory cannot change where a punch lands.
 *
 *  Server-side protection: requires can_remote_clock — the same capability the
 *  punch route demands, so a worker who cannot clock cannot enumerate sites.
 */

import { requirePermission } from "@/lib/auth";
import { listMobileFences } from "@/lib/db";
import type { GeofencesResponse, GeoFenceSite } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(): Promise<Response> {
  const guard = await requirePermission("can_remote_clock");
  if (guard) return guard;

  const sites: GeoFenceSite[] = (await listMobileFences()).map((fence) => ({
    id: fence.id,
    branch: fence.branch,
    method: fence.method,
    latitude: fence.latitude,
    longitude: fence.longitude,
    radiusMeters: fence.radiusMeters,
  }));

  const payload: GeofencesResponse = { ok: true, sites, generatedAt: Date.now() };
  return Response.json(payload, { headers: NO_STORE });
}
