/**
 * ============================================================================
 *  GET    /api/ports/:id — one switch interface
 *  PATCH  /api/ports/:id — label / describe a port
 *  DELETE /api/ports/:id — remove the port record
 * ============================================================================
 *
 *  A port is one real interface on a device. Its counters, link state and
 *  speed come from the collector's SNMP reads — this endpoint never presents
 *  a cumulative octet counter as a speed. If no rate has been calculated yet
 *  (the first sample of a counter pair has nothing to difference against),
 *  the rates are null and the UI says "Traffic unavailable" rather than
 *  inventing a number.
 *
 *  Label, notes and description are administrator-owned: the collector fills
 *  in blanks but never overwrites them.
 * ============================================================================
 */

import { deletePort, getPort, updatePort } from "@/lib/repo/ports";
import { getDevice } from "@/lib/repo/devices";
import { connectionsForDevice } from "@/lib/repo/connections";
import { latestObservations } from "@/lib/repo/observations";
import { samplesSince } from "@/lib/repo/traffic";
import { recordAudit } from "@/lib/repo/audit";
import { recordEvent } from "@/lib/repo/events";
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
  if (id === null) return fail("Invalid port id.", 400);

  const port = await getPort(id);
  if (!port) return fail("That port no longer exists.", 404);

  const device = await getDevice(port.deviceId);
  const connections = (await connectionsForDevice(port.deviceId)).filter(
    (connection) => connection.localPortId === id || connection.remotePortId === id
  );
  const observations = await latestObservations(port.deviceId, 12);
  const traffic = await samplesSince("port", id, Date.now() - 60 * 60 * 1000, 120);

  return ok({
    port,
    device: device ? { id: device.id, name: device.name, category: device.category } : null,
    connections,
    observations,
    traffic,
    latestSample: traffic.length > 0 ? traffic[traffic.length - 1] : null,
  });
}

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  const gate = await requirePermission("can_edit_inventory");
  if (gate.response) return gate.response;

  const id = await resolveId(params);
  if (id === null) return fail("Invalid port id.", 400);

  const current = await getPort(id);
  if (!current) return fail("That port no longer exists.", 404);

  const body = await readJson(request);
  const patch: Parameters<typeof updatePort>[1] = {};
  if (typeof body.label === "string") patch.label = body.label;
  if (typeof body.notes === "string") patch.notes = body.notes;
  if (typeof body.description === "string") patch.description = body.description;

  if (Object.keys(patch).length === 0) return fail("Nothing to change.");

  try {
    await updatePort(id, patch);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The port could not be updated.");
  }

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "update",
    entity: "port",
    entityId: id,
    before: { label: current.label, notes: current.notes, description: current.description },
    after: {
      label: patch.label ?? current.label,
      notes: patch.notes ?? current.notes,
      description: patch.description ?? current.description,
    },
    note: "The port was labelled or described by an administrator.",
  });
  await recordEvent({
    type: "config_changed",
    severity: "info",
    title: `Port updated: ${current.ifName}`,
    detail: `An administrator edited the port record on device ${current.deviceId}.`,
    subjectType: "port",
    subjectId: id,
    source: "console",
  });

  return ok({ id, port: await getPort(id) });
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  const gate = await requirePermission("can_edit_inventory");
  if (gate.response) return gate.response;

  const id = await resolveId(params);
  if (id === null) return fail("Invalid port id.", 400);

  const current = await getPort(id);
  if (!current) return fail("That port no longer exists.", 404);

  await deletePort(id);

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "delete",
    entity: "port",
    entityId: id,
    before: { ifName: current.ifName, deviceId: current.deviceId },
    note: "The port record was removed.",
  });

  return ok({ id, deleted: true });
}
