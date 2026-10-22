/**
 * ============================================================================
 *  GET    /api/locations/:id — one physical location
 *  PATCH  /api/locations/:id — rename or move a location
 *  DELETE /api/locations/:id — remove a location
 * ============================================================================
 *
 *  Deleting a location never deletes devices: the devices that pointed at it
 *  fall back to "Unassigned" so the inventory stays intact.
 * ============================================================================
 */

import {
  deleteLocation,
  getLocation,
  updateLocation,
} from "@/lib/repo/sites";
import { listDevices } from "@/lib/repo/devices";
import { recordAudit } from "@/lib/repo/audit";
import { fail, ok, readJson, requirePermission } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

async function resolveId(params: Params["params"]): Promise<number | null> {
  const { id } = await params;
  const numeric = Number(id);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const gate = await requirePermission("can_view_topology");
  if (gate.response) return gate.response;

  const id = await resolveId(params);
  if (id === null) return fail("Invalid location id.", 400);

  const location = await getLocation(id);
  if (!location) return fail("That location no longer exists.", 404);

  const devices = (await listDevices()).filter((device) => device.locationId === id);

  return ok({
    location,
    devices: devices.map((device) => ({
      id: device.id,
      name: device.name,
      state: device.healthState,
      category: device.category,
    })),
    deviceCount: devices.length,
  });
}

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  const gate = await requirePermission("can_edit_inventory");
  if (gate.response) return gate.response;

  const id = await resolveId(params);
  if (id === null) return fail("Invalid location id.", 400);

  const current = await getLocation(id);
  if (!current) return fail("That location no longer exists.", 404);

  const body = await readJson(request);
  const patch: Parameters<typeof updateLocation>[1] = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.building === "string") patch.building = body.building;
  if (typeof body.room === "string") patch.room = body.room;
  if (typeof body.notes === "string") patch.notes = body.notes;
  if (body.siteId === null || typeof body.siteId === "number") patch.siteId = body.siteId;

  if (Object.keys(patch).length === 0) return fail("Nothing to change.");

  try {
    await updateLocation(id, patch);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The location could not be updated.");
  }

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "update",
    entity: "location",
    entityId: id,
    before: {
      name: current.name,
      siteId: current.siteId,
      building: current.building,
      room: current.room,
    },
    after: {
      name: patch.name?.trim() || current.name,
      siteId: patch.siteId === undefined ? current.siteId : patch.siteId,
      building: patch.building ?? current.building,
      room: patch.room ?? current.room,
    },
    note: "The location was edited.",
  });

  return ok({ id, location: await getLocation(id) });
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  const gate = await requirePermission("can_edit_inventory");
  if (gate.response) return gate.response;

  const id = await resolveId(params);
  if (id === null) return fail("Invalid location id.", 400);

  const current = await getLocation(id);
  if (!current) return fail("That location no longer exists.", 404);

  const affected = (await listDevices()).filter((device) => device.locationId === id);
  await deleteLocation(id);

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "delete",
    entity: "location",
    entityId: id,
    before: { name: current.name, siteId: current.siteId },
    after: { unassignedDevices: affected.length },
    note: "The location was removed; its devices are now unassigned.",
  });

  return ok({ id, deleted: true, unassignedDevices: affected.length });
}
