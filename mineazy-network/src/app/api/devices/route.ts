/**
 * ============================================================================
 *  GET  /api/devices — the device inventory
 *  POST /api/devices — add a device by hand
 * ============================================================================
 *
 *  A manually created device is administrator-owned: its name and category
 *  are locked, so a later rediscovery can never overwrite them.
 * ============================================================================
 */

import { createDevice, listDevices } from "@/lib/repo/devices";
import { recordAudit } from "@/lib/repo/audit";
import { recordEvent } from "@/lib/repo/events";
import { defaultPollSeconds } from "@/lib/settings";
import {
  fail,
  ok,
  readJson,
  requirePermission,
  stringParam,
} from "@/lib/api";
import type { DeviceCategory } from "@/lib/types";

export async function GET(request: Request): Promise<Response> {
  const gate = await requirePermission("can_view_topology");
  if (gate.response) return gate.response;

  const devices = await listDevices({
    category: stringParam(request, "category") ?? undefined,
    state: stringParam(request, "state") ?? undefined,
    siteId: stringParam(request, "siteId") ? Number(stringParam(request, "siteId")) : undefined,
    locationId: stringParam(request, "locationId")
      ? Number(stringParam(request, "locationId"))
      : undefined,
    search: stringParam(request, "q") ?? undefined,
    monitoredOnly: stringParam(request, "monitored") === "true",
  });

  return ok({ devices, count: devices.length });
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requirePermission("can_edit_inventory");
  if (gate.response) return gate.response;

  const body = await readJson(request);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return fail("A device name is required.");

  const category = (typeof body.category === "string" ? body.category : "unknown") as DeviceCategory;
  const id = await createDevice({
    name,
    hostname: typeof body.hostname === "string" ? body.hostname : "",
    category,
    manufacturer: typeof body.manufacturer === "string" ? body.manufacturer : "",
    model: typeof body.model === "string" ? body.model : "",
    serial: typeof body.serial === "string" ? body.serial : "",
    siteId: typeof body.siteId === "number" ? body.siteId : null,
    locationId: typeof body.locationId === "number" ? body.locationId : null,
    mgmtIp: typeof body.mgmtIp === "string" ? body.mgmtIp : "",
    mac: typeof body.mac === "string" ? body.mac : "",
    os: typeof body.os === "string" ? body.os : "",
    notes: typeof body.notes === "string" ? body.notes : "",
    criticality:
      body.criticality === "critical" || body.criticality === "important" || body.criticality === "standard"
        ? body.criticality
        : "standard",
    monitoringEnabled: body.monitoringEnabled !== false,
    monitorMethod:
      body.monitorMethod === "snmp" ||
      body.monitorMethod === "icmp" ||
      body.monitorMethod === "tcp" ||
      body.monitorMethod === "http" ||
      body.monitorMethod === "none"
        ? body.monitorMethod
        : "icmp",
    pollIntervalSeconds:
      typeof body.pollIntervalSeconds === "number" ? body.pollIntervalSeconds : await defaultPollSeconds(),
    failureThreshold: typeof body.failureThreshold === "number" ? body.failureThreshold : 3,
    discoverySource: "manual",
    classificationConfidence: "confirmed",
  });

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "create",
    entity: "device",
    entityId: id,
    after: { name, category },
    note: "Added the device to the inventory by hand.",
  });
  await recordEvent({
    type: "device_discovered",
    severity: "info",
    title: `${name} added to the inventory`,
    detail: "An administrator added this device manually.",
    subjectType: "device",
    subjectId: id,
    source: "console",
  });

  return ok({ id }, 201);
}
