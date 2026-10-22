/**
 * ============================================================================
 *  GET  /api/locations — sites and their physical locations
 *  POST /api/locations — create a location
 * ============================================================================
 */

import {
  listSites,
  listLocations,
  createLocation,
  deviceCountsByLocation,
} from "@/lib/repo/sites";
import { listDevices } from "@/lib/repo/devices";
import { recordAudit } from "@/lib/repo/audit";
import { fail, ok, readJson, requirePermission } from "@/lib/api";

export async function GET(): Promise<Response> {
  const gate = await requirePermission("can_view_topology");
  if (gate.response) return gate.response;

  const [sites, locations, counts, devices] = await Promise.all([
    listSites(),
    listLocations(),
    deviceCountsByLocation(),
    listDevices(),
  ]);

  const deviceByLocation = new Map<number, { id: number; name: string; state: string }[]>();
  for (const device of devices) {
    if (device.locationId === null) continue;
    const list = deviceByLocation.get(device.locationId) ?? [];
    list.push({ id: device.id, name: device.name, state: device.healthState });
    deviceByLocation.set(device.locationId, list);
  }

  return ok({
    sites,
    locations: locations.map((location) => ({
      ...location,
      deviceCount: counts[location.id] ?? 0,
      devices: deviceByLocation.get(location.id) ?? [],
    })),
    unassigned: devices.filter((device) => device.locationId === null).length,
  });
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requirePermission("can_edit_inventory");
  if (gate.response) return gate.response;

  const body = await readJson(request);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return fail("A location name is required.");

  const id = await createLocation({
    name,
    siteId: typeof body.siteId === "number" ? body.siteId : null,
    building: typeof body.building === "string" ? body.building : "",
    room: typeof body.room === "string" ? body.room : "",
    notes: typeof body.notes === "string" ? body.notes : "",
  });

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "create",
    entity: "location",
    entityId: id,
    after: { name },
    note: "A location was created.",
  });

  return ok({ id, name }, 201);
}
