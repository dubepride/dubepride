/**
 * ============================================================================
 *  GET    /api/sites/:id — one monitored estate
 *  PATCH  /api/sites/:id — rename or describe a site
 *  DELETE /api/sites/:id — remove a site
 * ============================================================================
 *
 *  Deleting a site never deletes devices or locations: they fall back to
 *  "Unassigned" / "no site" so the inventory stays intact.
 * ============================================================================
 */

import { deleteSite, getSite, listLocations, updateSite } from "@/lib/repo/sites";
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
  if (id === null) return fail("Invalid site id.", 400);

  const site = await getSite(id);
  if (!site) return fail("That site no longer exists.", 404);

  const locations = (await listLocations()).filter((location) => location.siteId === id);
  const locationIds = new Set(locations.map((location) => location.id));
  const devices = (await listDevices()).filter(
    (device) => device.siteId === id || (device.locationId !== null && locationIds.has(device.locationId))
  );

  return ok({
    site,
    locations,
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
  if (id === null) return fail("Invalid site id.", 400);

  const current = await getSite(id);
  if (!current) return fail("That site no longer exists.", 404);

  const body = await readJson(request);
  const patch: Parameters<typeof updateSite>[1] = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.description === "string") patch.description = body.description;

  if (Object.keys(patch).length === 0) return fail("Nothing to change.");

  try {
    await updateSite(id, patch);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The site could not be updated.");
  }

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "update",
    entity: "site",
    entityId: id,
    before: { name: current.name, description: current.description },
    after: {
      name: patch.name?.trim() || current.name,
      description: patch.description ?? current.description,
    },
    note: "The site was edited.",
  });

  return ok({ id, site: await getSite(id) });
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  const gate = await requirePermission("can_edit_inventory");
  if (gate.response) return gate.response;

  const id = await resolveId(params);
  if (id === null) return fail("Invalid site id.", 400);

  const current = await getSite(id);
  if (!current) return fail("That site no longer exists.", 404);

  await deleteSite(id);

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "delete",
    entity: "site",
    entityId: id,
    before: { name: current.name },
    note: "The site was removed; its locations and devices are now unassigned.",
  });

  return ok({ id, deleted: true });
}
