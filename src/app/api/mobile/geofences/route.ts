/**
 * ============================================================================
 *  GET /api/mobile/geofences — live geofence & employee feed for mobile app
 * ============================================================================
 *
 *  Provides the mobile app with real-time configurations, including:
 *    1. All mobile-capable sites with their current coordinates and radii.
 *    2. Updated radius resizing and relocation done in the web admin.
 *    3. The authenticated employee's live profile, home branch geofence,
 *       and current day attendance status (?employeeId= & ?employeeRef=).
 *
 *  Headers:
 *    x-mobile-key: <MOBILE_PUNCH_KEY>
 */

import type { NextRequest } from "next/server";
import {
  employeeById,
  employeeDayStatus,
  getDb,
  listMobileFences,
  resolveEmployee,
  resolveGeofenceLocation,
} from "@/lib/db";
import { isFiniteCoordinate, isValidRadius } from "@/lib/geofence";
import { DEFAULT_MOBILE_KEY, isMobileAuthorized } from "@/lib/mobile";
import type { GeoFenceSite, MobileGeofenceConfig, PunchDirection } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

export async function GET(request: NextRequest): Promise<Response> {
  if (!(await isMobileAuthorized(request))) {
    return Response.json(
      {
        ok: false,
        error: `Unauthorized — send the x-mobile-key header (expected "${DEFAULT_MOBILE_KEY}" unless MOBILE_PUNCH_KEY is set).`,
      },
      { status: 401, headers: NO_STORE }
    );
  }

  const fences = await listMobileFences();
  const sites: GeoFenceSite[] = fences.map((fence) => ({
    id: fence.id,
    branch: fence.branch,
    method: fence.method,
    latitude: fence.latitude,
    longitude: fence.longitude,
    radiusMeters: fence.radiusMeters,
  }));

  let homeGeofence: MobileGeofenceConfig | null = null;
  let employeeDto: {
    employeeId: number;
    erpUserId: string;
    fullName: string;
    department: string;
    branch: string;
    status: string;
    boundDeviceId: string | null;
    boundDeviceName: string | null;
    boundDeviceAt: number | null;
  } | null = null;
  let dayStatus: {
    clockedIn: boolean;
    lastPunchAt: number | null;
    lastDirection: PunchDirection | null;
  } | null = null;

  const rawEmpId = request.nextUrl.searchParams.get("employeeId") ?? "";
  const employeeRef =
    request.nextUrl.searchParams.get("employeeRef") ||
    request.nextUrl.searchParams.get("empNumber") ||
    rawEmpId ||
    "";

  const numericId = Number(rawEmpId);
  let employee =
    Number.isInteger(numericId) && numericId > 0
      ? await employeeById(numericId)
      : null;

  if (!employee && employeeRef.trim()) {
    employee = await resolveEmployee(await getDb(), employeeRef.trim());
  }

  if (employee) {
    employeeDto = {
      employeeId: employee.Employee_ID,
      erpUserId: employee.ERP_User_ID,
      fullName: employee.Full_Name,
      department: employee.Department,
      branch: employee.Branch_Name,
      status: employee.Status,
      boundDeviceId: employee.Bound_Device_ID ?? null,
      boundDeviceName: employee.Bound_Device_Name ?? null,
      boundDeviceAt: employee.Bound_Device_At ?? null,
    };
    dayStatus = await employeeDayStatus(employee.Employee_ID);

    const home = await resolveGeofenceLocation({ employeeBranch: employee.Branch_Name });
    if (home) {
      homeGeofence = {
        configured:
          isFiniteCoordinate(home.latitude, home.longitude) && isValidRadius(home.radiusMeters),
        method: home.method,
        label: home.label,
        branch: home.branch,
        latitude: home.latitude,
        longitude: home.longitude,
        radiusMeters: home.radiusMeters,
      };
    }
  }

  return Response.json(
    {
      ok: true,
      fences: sites,
      sites,
      geofence: homeGeofence,
      employee: employeeDto,
      dayStatus,
      generatedAt: Date.now(),
    },
    { headers: NO_STORE }
  );
}
