/**
 * ============================================================================
 *  GET    /api/devices/:id — one device with everything known about it
 *  PATCH  /api/devices/:id — an administrator edits the record
 *  DELETE /api/devices/:id — remove the device from the inventory
 * ============================================================================
 *
 *  The GET payload is the whole evidence for one asset: its identity, its
 *  ports, the links it takes part in, the incidents that mention it, the
 *  upstream path back to the gateway, and the traffic counters the collector
 *  has actually read. Nothing here is invented — a field that was never
 *  observed stays empty.
 *
 *  PATCH is the only way an administrator may change a name or a category.
 *  The repository locks those two fields once they are set, so a later
 *  rediscovery can never silently undo the decision.
 * ============================================================================
 */

import { deleteDevice, getDevice, updateDevice } from "@/lib/repo/devices";
import { listPorts } from "@/lib/repo/ports";
import { connectionsForDevice } from "@/lib/repo/connections";
import { listIncidents } from "@/lib/repo/incidents";
import { samplesSince } from "@/lib/repo/traffic";
import { recordAudit } from "@/lib/repo/audit";
import { recordEvent } from "@/lib/repo/events";
import { traceUpstreamPath } from "@/lib/topology";
import { fail, ok, readJson, requirePermission } from "@/lib/api";
import type { Criticality, DeviceCategory, MonitorMethod } from "@/lib/types";

type Params = { params: Promise<{ id: string }> };

/** Read the numeric device id out of the route parameters. */
async function resolveId(params: Params["params"]): Promise<number | null> {
  const { id } = await params;
  const numeric = Number(id);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

const CATEGORIES: readonly DeviceCategory[] = [
  "internet",
  "router",
  "gateway",
  "switch",
  "desktop",
  "laptop",
  "printer",
  "server",
  "nvr",
  "camera",
  "access_point",
  "nas",
  "voip_phone",
  "industrial",
  "unknown",
];

const MONITOR_METHODS: readonly MonitorMethod[] = ["snmp", "icmp", "tcp", "http", "none"];

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const gate = await requirePermission("can_view_topology");
  if (gate.response) return gate.response;

  const id = await resolveId(params);
  if (id === null) return fail("Invalid device id.", 400);

  const device = await getDevice(id);
  if (!device) return fail("That device no longer exists.", 404);

  const ports = await listPorts(id);
  const connections = await connectionsForDevice(id);
  const incidents = (await listIncidents({ state: "all", limit: 200 })).filter(
    (incident) => incident.deviceId === id || incident.affected.includes(id)
  );
  const trace = await traceUpstreamPath(id);

  // One hour of per-port counters. The first sample of a counter pair has no
  // previous value, so its rate is null — that is reported as "no rate yet",
  // never as zero traffic.
  const since = Date.now() - 60 * 60 * 1000;
  const traffic = (
    await Promise.all(ports.map((port) => samplesSince("port", port.id, since, 120)))
  )
    .flat()
    .sort((a, b) => a.sampledAt - b.sampledAt);

  return ok({
    device,
    ports,
    connections,
    incidents,
    trace,
    traffic,
    latestSample: traffic.length > 0 ? traffic[traffic.length - 1] : null,
  });
}

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  const gate = await requirePermission("can_edit_inventory");
  if (gate.response) return gate.response;

  const id = await resolveId(params);
  if (id === null) return fail("Invalid device id.", 400);

  const current = await getDevice(id);
  if (!current) return fail("That device no longer exists.", 404);

  const body = await readJson(request);
  const patch: Parameters<typeof updateDevice>[1] = {};

  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.hostname === "string") patch.hostname = body.hostname;
  if (typeof body.category === "string") {
    const category = body.category.toLowerCase() as DeviceCategory;
    if (!CATEGORIES.includes(category)) return fail(`Unknown category "${body.category}".`);
    patch.category = category;
  }
  if (typeof body.manufacturer === "string") patch.manufacturer = body.manufacturer;
  if (typeof body.model === "string") patch.model = body.model;
  if (typeof body.serial === "string") patch.serial = body.serial;
  if (typeof body.mgmtIp === "string") patch.mgmtIp = body.mgmtIp;
  if (typeof body.mac === "string") patch.mac = body.mac;
  if (typeof body.os === "string") patch.os = body.os;
  if (typeof body.notes === "string") patch.notes = body.notes;
  if (typeof body.criticality === "string") {
    const criticality = body.criticality.toLowerCase() as Criticality;
    if (criticality !== "critical" && criticality !== "important" && criticality !== "standard") {
      return fail(`Unknown criticality "${body.criticality}".`);
    }
    patch.criticality = criticality;
  }
  if (typeof body.monitoringEnabled === "boolean") patch.monitoringEnabled = body.monitoringEnabled;
  if (typeof body.monitorMethod === "string") {
    const method = body.monitorMethod.toLowerCase() as MonitorMethod;
    if (!MONITOR_METHODS.includes(method)) return fail(`Unknown monitor method "${body.monitorMethod}".`);
    patch.monitorMethod = method;
  }
  if (typeof body.pollIntervalSeconds === "number") patch.pollIntervalSeconds = body.pollIntervalSeconds;
  if (typeof body.failureThreshold === "number") patch.failureThreshold = body.failureThreshold;
  // null explicitly unassigns the device from a site or a location.
  if (body.siteId === null || typeof body.siteId === "number") patch.siteId = body.siteId;
  if (body.locationId === null || typeof body.locationId === "number") {
    patch.locationId = body.locationId;
  }

  if (Object.keys(patch).length === 0) return fail("Nothing to change.");

  try {
    await updateDevice(id, patch);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not update the device.");
  }

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "update",
    entity: "device",
    entityId: id,
    before: {
      name: current.name,
      category: current.category,
      mgmtIp: current.mgmtIp,
      monitoringEnabled: current.monitoringEnabled,
    },
    after: {
      name: patch.name ?? current.name,
      category: patch.category ?? current.category,
      mgmtIp: patch.mgmtIp ?? current.mgmtIp,
      monitoringEnabled: patch.monitoringEnabled ?? current.monitoringEnabled,
    },
    note: "The device record was edited by an administrator.",
  });
  await recordEvent({
    type: "config_changed",
    severity: "info",
    title: `${patch.name ?? current.name} updated`,
    detail: "An administrator edited the device record.",
    subjectType: "device",
    subjectId: id,
    source: "console",
  });

  return ok({ id, device: await getDevice(id) });
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  const gate = await requirePermission("can_edit_inventory");
  if (gate.response) return gate.response;

  const id = await resolveId(params);
  if (id === null) return fail("Invalid device id.", 400);

  const current = await getDevice(id);
  if (!current) return fail("That device no longer exists.", 404);

  await deleteDevice(id);

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "delete",
    entity: "device",
    entityId: id,
    before: { name: current.name, mgmtIp: current.mgmtIp, category: current.category },
    note: "The device was removed from the inventory.",
  });
  await recordEvent({
    type: "config_changed",
    severity: "minor",
    title: `${current.name} removed from the inventory`,
    detail: "An administrator deleted this device and its port records.",
    subjectType: "device",
    subjectId: null,
    source: "console",
  });

  return ok({ id, deleted: true });
}
