/**
 * ============================================================================
 *  GET /api/reports — exportable reports (CSV) + the summary figures
 * ============================================================================
 *
 *  Every report is generated from the stored evidence, never from a cached
 *  summary, so a report always matches what the console shows at that moment.
 * ============================================================================
 */

import { listDevices } from "@/lib/repo/devices";
import { listAllPorts } from "@/lib/repo/ports";
import { listConnections } from "@/lib/repo/connections";
import { listIncidents } from "@/lib/repo/incidents";
import { listEvents } from "@/lib/repo/events";
import { listAudit } from "@/lib/repo/audit";
import { listLocations } from "@/lib/repo/sites";
import { formatBandwidth } from "@/lib/traffic";
import { requirePermission, ok, stringParam } from "@/lib/api";

/** Escape one CSV cell. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(cell).join(",")];
  for (const row of rows) lines.push(row.map(cell).join(","));
  return lines.join("\r\n");
}

export async function GET(request: Request): Promise<Response> {
  const gate = await requirePermission("can_view_reports");
  if (gate.response) return gate.response;

  const kind = stringParam(request, "kind") ?? "summary";

  const devices = await listDevices();
  const ports = await listAllPorts();
  const connections = await listConnections();
  const locations = await listLocations();
  const locationNames = new Map(locations.map((location) => [location.id, location.name]));
  const deviceNames = new Map(devices.map((device) => [device.id, device.name]));

  if (kind === "devices") {
    const csv = toCsv(
      [
        "Name",
        "Hostname",
        "Category",
        "Manufacturer",
        "Model",
        "Serial",
        "Management IP",
        "MAC",
        "Location",
        "Criticality",
        "Monitored",
        "Method",
        "Poll seconds",
        "Failure threshold",
        "Health state",
        "Health reason",
        "Discovery source",
        "Confidence",
        "Last observed",
        "Simulated",
      ],
      devices.map((device) => [
        device.name,
        device.hostname,
        device.category,
        device.manufacturer,
        device.model,
        device.serial,
        device.mgmtIp,
        device.mac,
        device.locationId !== null ? locationNames.get(device.locationId) ?? "" : "",
        device.criticality,
        device.monitoringEnabled ? "yes" : "no",
        device.monitorMethod,
        device.pollIntervalSeconds,
        device.failureThreshold,
        device.healthState,
        device.healthReason,
        device.discoverySource,
        device.classificationConfidence,
        device.lastObservedAt ? new Date(device.lastObservedAt).toISOString() : "",
        device.simulated ? "yes" : "no",
      ])
    );
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="mineazy-devices-${Date.now()}.csv"`,
      },
    });
  }

  if (kind === "ports") {
    const csv = toCsv(
      [
        "Device",
        "Interface",
        "Port number",
        "Description",
        "Label",
        "Admin state",
        "Oper state",
        "Speed",
        "Duplex",
        "VLAN",
        "In octets",
        "Out octets",
        "In rate",
        "Out rate",
        "In errors",
        "Out errors",
        "Managed",
        "Source",
        "Last polled",
      ],
      ports.map((port) => [
        deviceNames.get(port.deviceId) ?? port.deviceId,
        port.ifName,
        port.portNumber ?? "",
        port.description,
        port.label,
        port.adminState,
        port.operState,
        port.speedBps ? `${port.speedBps} bps` : "",
        port.duplex ?? "",
        port.vlan ?? "",
        port.inOctets ?? "",
        port.outOctets ?? "",
        formatBandwidth(port.inRateBps),
        formatBandwidth(port.outRateBps),
        port.inErrors ?? "",
        port.outErrors ?? "",
        port.managed ? "yes" : "no",
        port.source,
        port.lastPolledAt ? new Date(port.lastPolledAt).toISOString() : "",
      ])
    );
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="mineazy-ports-${Date.now()}.csv"`,
      },
    });
  }

  if (kind === "connections") {
    const csv = toCsv(
      [
        "Connection",
        "Local device",
        "Local port",
        "Remote device",
        "Remote port",
        "Type",
        "Source",
        "Confidence",
        "Verified",
        "State",
        "Evidence",
        "Cable id",
        "Cable destination",
        "Last observed",
      ],
      connections.map((connection) => [
        connection.id,
        deviceNames.get(connection.localDeviceId) ?? connection.localDeviceId,
        ports.find((port) => port.id === connection.localPortId)?.ifName ?? "",
        deviceNames.get(connection.remoteDeviceId) ?? connection.remoteDeviceId,
        ports.find((port) => port.id === connection.remotePortId)?.ifName ?? "",
        connection.type,
        connection.source,
        connection.confidence,
        connection.verified ? "yes" : "no",
        connection.state,
        connection.evidence,
        connection.cableId,
        connection.cableDestination,
        connection.lastObservedAt ? new Date(connection.lastObservedAt).toISOString() : "",
      ])
    );
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="mineazy-connections-${Date.now()}.csv"`,
      },
    });
  }

  if (kind === "incidents") {
    const incidents = await listIncidents({ state: "all", limit: 1000 });
    const csv = toCsv(
      [
        "Id",
        "Key",
        "Severity",
        "State",
        "Title",
        "Device",
        "Started",
        "Recovered",
        "Acknowledged by",
        "Assigned to",
        "Affected devices",
        "Fault location",
        "Confidence",
        "Evidence",
        "Notes",
      ],
      incidents.map((incident) => [
        incident.id,
        incident.key,
        incident.severity,
        incident.state,
        incident.title,
        incident.deviceId ? deviceNames.get(incident.deviceId) ?? incident.deviceId : "",
        new Date(incident.startedAt).toISOString(),
        incident.recoveredAt ? new Date(incident.recoveredAt).toISOString() : "",
        incident.acknowledgedBy ?? "",
        incident.assignedTo ?? "",
        incident.affected.map((id) => deviceNames.get(id) ?? id).join("; "),
        incident.faultLocation,
        incident.confidence,
        incident.evidence.replace(/\r?\n/g, " | "),
        incident.notes.replace(/\r?\n/g, " | "),
      ])
    );
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="mineazy-incidents-${Date.now()}.csv"`,
      },
    });
  }

  if (kind === "events") {
    const events = await listEvents({ limit: 2000 });
    const csv = toCsv(
      ["At", "Type", "Severity", "Title", "Detail", "Subject type", "Subject id", "Source"],
      events.map((event) => [
        new Date(event.at).toISOString(),
        event.type,
        event.severity,
        event.title,
        event.detail.replace(/\r?\n/g, " | "),
        event.subjectType,
        event.subjectId ?? "",
        event.source,
      ])
    );
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="mineazy-events-${Date.now()}.csv"`,
      },
    });
  }

  if (kind === "audit") {
    const entries = await listAudit(1000);
    const csv = toCsv(
      ["At", "User", "Action", "Entity", "Entity id", "Before", "After", "Note"],
      entries.map((entry) => [
        new Date(entry.at).toISOString(),
        entry.userName,
        entry.action,
        entry.entity,
        entry.entityId,
        entry.before,
        entry.after,
        entry.note,
      ])
    );
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="mineazy-audit-${Date.now()}.csv"`,
      },
    });
  }

  // The default: a summary the Reports screen renders on the server.
  const incidents = await listIncidents({ state: "all", limit: 1000 });
  const events = await listEvents({ limit: 500 });

  return ok({
    devices: devices.length,
    monitored: devices.filter((device) => device.monitoringEnabled).length,
    ports: ports.length,
    connections: connections.length,
    downLinks: connections.filter((connection) => connection.state === "down").length,
    incidents: incidents.length,
    openIncidents: incidents.filter((incident) => incident.state !== "resolved").length,
    events: events.length,
    states: devices.reduce<Record<string, number>>((acc, device) => {
      acc[device.healthState] = (acc[device.healthState] ?? 0) + 1;
      return acc;
    }, {}),
  });
}
