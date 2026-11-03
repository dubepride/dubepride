/**
 * ============================================================================
 *  GET /api/attendance/geofences — sites for the browser clock-in map & mobile
 * ============================================================================
 *
 *  Returns every site a self-clock may be validated against: mobile-
 *  capable (Clocking_Method Geofence/Both) AND geo-ready (a usable centre +
 *  radius).
 *
 *  Authorized via can_remote_clock permission OR mobile client with x-mobile-key.
 */

import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth";
import { listMobileFences } from "@/lib/db";
import { hasValidMobileKey } from "@/lib/mobile";
import type { GeofencesResponse, GeoFenceSite } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

export async function GET(request: NextRequest): Promise<Response> {
  if (!hasValidMobileKey(request)) {
    const guard = await requirePermission("can_remote_clock");
    if (guard) return guard;
  }

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
