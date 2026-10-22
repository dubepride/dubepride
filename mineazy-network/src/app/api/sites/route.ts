/**
 * ============================================================================
 *  GET  /api/sites — the monitored estates
 *  POST /api/sites — create a site
 * ============================================================================
 */

import { listSites, listLocations, createSite } from "@/lib/repo/sites";
import { listDevices } from "@/lib/repo/devices";
import { recordAudit } from "@/lib/repo/audit";
import { fail, ok, readJson, requirePermission } from "@/lib/api";

export async function GET(): Promise<Response> {
  const gate = await requirePermission("can_view_topology");
  if (gate.response) return gate.response;

  const [sites, locations, devices] = await Promise.all([
    listSites(),
    listLocations(),
    listDevices(),
  ]);

  return ok({
    sites: sites.map((site) => {
      const siteLocations = locations.filter((location) => location.siteId === site.id);
      const locationIds = new Set(siteLocations.map((location) => location.id));
      const siteDevices = devices.filter(
        (device) => device.siteId === site.id || (device.locationId !== null && locationIds.has(device.locationId))
      );
      return {
        ...site,
        locations: siteLocations,
        deviceCount: siteDevices.length,
        devices: siteDevices.map((device) => ({
          id: device.id,
          name: device.name,
          state: device.healthState,
          category: device.category,
        })),
      };
    }),
  });
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requirePermission("can_edit_inventory");
  if (gate.response) return gate.response;

  const body = await readJson(request);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return fail("A site name is required.");

  const id = await createSite(name, typeof body.description === "string" ? body.description : "");

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "create",
    entity: "site",
    entityId: id,
    after: { name },
    note: "A site was created.",
  });

  return ok({ id, name }, 201);
}
