/**
 * ============================================================================
 *  GET /api/map/overview — one snapshot for the floating map overlay (Phase 18)
 * ============================================================================
 *
 *  The web app shows a map button in the app chrome on every page. Opening it
 *  needs two things in a single round-trip:
 *
 *    • sites  — the geofenced branches, with centre + radius, so the overlay
 *               can draw every fence, and
 *    • punches — the most recent GPS punch locations, so the overlay can show
 *               where people actually clocked in.
 *
 *  Scope is permission-aware (see src/lib/auth):
 *
 *    "org"  — callers who can see attendance/settings data get EVERY geo-ready
 *             branch (including biometric-only sites, flagged `mobile:false`)
 *             and organisation-wide recent punches.
 *    "self" — everyone else gets the mobile-capable fences and only their OWN
 *             punches (never a colleague's location).
 *
 *  This endpoint is DISPLAY ONLY. The bridge re-derives the governing site from
 *  the submitted coordinates on every punch (src/lib/geo-punch.ts), so nothing
 *  here can move where a punch lands even if a client tampers with the response.
 *
 *  Query parameters
 *    hours=<n>   punches from the last n hours (default 24, clamp 1..168)
 *
 *  Read-only. Requires a signed-in session (401 otherwise). No store.
 */

import type { NextRequest } from "next/server";
import { currentAccount, unauthorizedResponse } from "@/lib/auth";
import { listConfiguredBranches, listGeofenceActivity, listMobileFences } from "@/lib/db";
import type { PermissionsMap } from "@/lib/rbac";
import type {
  ClockingMethod,
  MapOverviewPunch,
  MapOverviewResponse,
  MapOverviewSite,
} from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };
const HOUR_MS = 3_600_000;
const DEFAULT_HOURS = 24;
const MAX_PUNCH_ROWS = 200;

/** Mobile clocking is allowed at Geofence and Both sites only. */
function mobileMethod(method: ClockingMethod): boolean {
  return method === "Geofence" || method === "Both";
}

/** True when this account may see organisation-wide attendance/site data. */
function canSeeOrg(permissions: PermissionsMap): boolean {
  return (
    permissions.can_view_attendance === true ||
    permissions.can_view_exceptions === true ||
    permissions.can_manage_branches === true ||
    permissions.can_view_settings === true ||
    permissions.can_edit_settings === true
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  const account = await currentAccount();
  if (!account) return unauthorizedResponse();

  const org = canSeeOrg(account.permissions);

  const rawHours = Number(request.nextUrl.searchParams.get("hours") ?? "");
  const hours = Number.isFinite(rawHours) && rawHours >= 1 ? Math.min(168, Math.floor(rawHours)) : DEFAULT_HOURS;
  const windowMs = hours * HOUR_MS;
  const now = Date.now();

  // ── Sites ───────────────────────────────────────────────────────────
  const fences = org ? listConfiguredBranches() : listMobileFences();
  const sites: MapOverviewSite[] = fences.map((fence) => ({
    id: fence.id,
    branch: fence.branch,
    method: fence.method,
    latitude: fence.latitude,
    longitude: fence.longitude,
    radiusMeters: fence.radiusMeters,
    mobile: mobileMethod(fence.method),
  }));

  // ── Recent GPS punches (identity-scoped for non-admins) ─────────────
  let punches: MapOverviewPunch[] = [];
  if (org || account.employeeId != null) {
    const activity = listGeofenceActivity({
      fromMs: now - windowMs,
      toMs: now + 60_000,
      employeeId: org ? undefined : account.employeeId ?? undefined,
      page: 1,
      pageSize: MAX_PUNCH_ROWS,
    });
    punches = activity.rows
      .filter((row) => row.latitude != null && row.longitude != null)
      .map((row) => ({
        logId: row.logId,
        employeeId: row.employeeId,
        employeeName: row.employeeName,
        branch: row.branch,
        timestamp: row.timestamp,
        direction: row.direction,
        verifyResult: row.verifyResult,
        latitude: row.latitude as number,
        longitude: row.longitude as number,
        distanceMeters: row.distanceMeters,
        accuracyMeters: row.accuracyMeters,
        insideGeofence: row.insideGeofence,
      }));
  }

  // ── Suggested initial centre: centroid of the visible fences ────────
  let center: { latitude: number; longitude: number } | null = null;
  if (sites.length > 0) {
    const sum = sites.reduce(
      (acc, s) => ({ lat: acc.lat + s.latitude, lng: acc.lng + s.longitude }),
      { lat: 0, lng: 0 }
    );
    center = { latitude: sum.lat / sites.length, longitude: sum.lng / sites.length };
  }

  const payload: MapOverviewResponse = {
    ok: true,
    scope: org ? "org" : "self",
    sites,
    punches,
    center,
    windowMs,
    generatedAt: now,
  };
  return Response.json(payload, { headers: NO_STORE });
}
