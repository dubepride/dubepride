/**
 * ============================================================================
 *  GET  /api/connections — every link in the topology
 *  POST /api/connections — record a link by hand
 * ============================================================================
 *
 *  A manually recorded link is marked `verified` and `source = manual`, and
 *  the collector will not overwrite it — only the live state and the evidence
 *  keep updating.
 * ============================================================================
 */

import {
  listConnections,
  upsertConnection,
  deleteConnection,
  updateConnection,
} from "@/lib/repo/connections";
import { getDevice } from "@/lib/repo/devices";
import { getPort } from "@/lib/repo/ports";
import { recordAudit } from "@/lib/repo/audit";
import { recordEvent } from "@/lib/repo/events";
import { fail, ok, readJson, requirePermission } from "@/lib/api";
import type { ConnectionType } from "@/lib/types";

export async function GET(): Promise<Response> {
  const gate = await requirePermission("can_view_topology");
  if (gate.response) return gate.response;

  const connections = await listConnections();
  return ok({ connections, count: connections.length });
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requirePermission("can_edit_inventory");
  if (gate.response) return gate.response;

  const body = await readJson(request);

  const localDeviceId = Number(body.localDeviceId);
  const remoteDeviceId = Number(body.remoteDeviceId);
  if (!Number.isFinite(localDeviceId) || !Number.isFinite(remoteDeviceId)) {
    return fail("Both ends of the link must be named.");
  }
  if (localDeviceId === remoteDeviceId) {
    return fail("A device cannot be cabled to itself.");
  }

  const local = await getDevice(localDeviceId);
  const remote = await getDevice(remoteDeviceId);
  if (!local || !remote) return fail("One of the devices in this link does not exist.", 404);

  const localPortId = typeof body.localPortId === "number" ? body.localPortId : null;
  const remotePortId = typeof body.remotePortId === "number" ? body.remotePortId : null;

  if (localPortId !== null && !(await getPort(localPortId))) {
    return fail("The local port does not exist.");
  }
  if (remotePortId !== null && !(await getPort(remotePortId))) {
    return fail("The remote port does not exist.");
  }

  const type: ConnectionType =
    body.type === "wan" || body.type === "uplink" || body.type === "access" ? body.type : "unknown";

  const { id, created } = await upsertConnection({
    localDeviceId,
    localPortId,
    remoteDeviceId,
    remotePortId,
    type,
    source: "manual",
    confidence: 1,
    verified: true,
    cableId: typeof body.cableId === "string" ? body.cableId : "",
    cableDestination: typeof body.cableDestination === "string" ? body.cableDestination : "",
    notes: typeof body.notes === "string" ? body.notes : "",
    state: "unknown",
    evidence: "Recorded by an administrator.",
  });

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "create",
    entity: "connection",
    entityId: id,
    after: { localDeviceId, remoteDeviceId, localPortId, remotePortId, type },
    note: "A link was recorded by hand and marked as verified.",
  });
  await recordEvent({
    type: "config_changed",
    severity: "info",
    title: `Link recorded: ${local.name} ↔ ${remote.name}`,
    detail: "An administrator recorded this cable.",
    subjectType: "connection",
    subjectId: id,
    source: "console",
  });

  return ok({ id, created }, created ? 201 : 200);
}

export async function PATCH(request: Request): Promise<Response> {
  const gate = await requirePermission("can_edit_inventory");
  if (gate.response) return gate.response;

  const body = await readJson(request);
  const id = Number(body.id);
  if (!Number.isFinite(id)) return fail("That connection id is not valid.");

  await updateConnection(id, {
    localPortId: typeof body.localPortId === "number" ? body.localPortId : undefined,
    remotePortId: typeof body.remotePortId === "number" ? body.remotePortId : undefined,
    cableId: typeof body.cableId === "string" ? body.cableId : undefined,
    cableDestination: typeof body.cableDestination === "string" ? body.cableDestination : undefined,
    notes: typeof body.notes === "string" ? body.notes : undefined,
    verified: typeof body.verified === "boolean" ? body.verified : undefined,
    type:
      body.type === "wan" || body.type === "uplink" || body.type === "access"
        ? body.type
        : undefined,
  });

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "update",
    entity: "connection",
    entityId: id,
    after: body,
    note: "A link record was edited.",
  });

  return ok({ id });
}

export async function DELETE(request: Request): Promise<Response> {
  const gate = await requirePermission("can_edit_inventory");
  if (gate.response) return gate.response;

  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isFinite(id)) return fail("That connection id is not valid.");

  await deleteConnection(id);
  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "delete",
    entity: "connection",
    entityId: id,
    note: "A link record was deleted.",
  });

  return ok({ id, deleted: true });
}
