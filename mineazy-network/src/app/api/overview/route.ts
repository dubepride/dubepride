/**
 * ============================================================================
 *  GET /api/overview — the dashboard payload
 * ============================================================================
 *
 *  One request powers the Overview page: state counts, incident counts, the
 *  busiest links, the newest events and the collector's own heartbeat (so
 *  the console can say honestly whether monitoring is running).
 * ============================================================================
 */

import { deviceCountsByState, deviceCountsByCategory, listDevices } from "@/lib/repo/devices";
import { listConnections } from "@/lib/repo/connections";
import { listIncidents } from "@/lib/repo/incidents";
import { listEvents } from "@/lib/repo/events";
import { listAllPorts } from "@/lib/repo/ports";
import { activeIncidentSummary } from "@/lib/incidents";
import { collectorHeartbeat } from "../../../collector/worker";
import { isDemoMode } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { formatBandwidth } from "@/lib/traffic";
import { requirePermission, ok } from "@/lib/api";

export async function GET(): Promise<Response> {
  const gate = await requirePermission("can_view_topology");
  if (gate.response) return gate.response;

  const [states, categories, devices, connections, incidents, events, ports, summary, heartbeat] =
    await Promise.all([
      deviceCountsByState(),
      deviceCountsByCategory(),
      listDevices(),
      listConnections(),
      listIncidents({ state: "active", limit: 25 }),
      listEvents({ limit: 25 }),
      listAllPorts(),
      activeIncidentSummary(),
      collectorHeartbeat(),
    ]);

  const names = new Map(devices.map((device) => [device.id, device.name]));

  const busiestLinks = connections
    .map((connection) => {
      const localPort = ports.find((port) => port.id === connection.localPortId);
      const remotePort = ports.find((port) => port.id === connection.remotePortId);
      const port = localPort ?? remotePort;
      const owner = port ? devices.find((device) => device.id === port.deviceId) : undefined;
      const rate = Math.max(port?.inRateBps ?? 0, port?.outRateBps ?? 0);
      return {
        connectionId: connection.id,
        state: connection.state,
        deviceName: owner?.name ?? null,
        portName: port?.ifName ?? null,
        speedBps: port?.speedBps ?? null,
        rateBps: port?.inRateBps === null && port?.outRateBps === null ? null : rate,
        rateLabel: formatBandwidth(
          port?.inRateBps === null && port?.outRateBps === null ? null : rate
        ),
      };
    })
    .filter((link) => link.rateBps !== null)
    .sort((a, b) => (b.rateBps ?? 0) - (a.rateBps ?? 0))
    .slice(0, 8);

  const downLinks = connections.filter((connection) => connection.state === "down").length;

  return ok({
    states,
    categories,
    devices: devices.length,
    monitored: devices.filter((device) => device.monitoringEnabled).length,
    connections: connections.length,
    downLinks,
    ports: ports.length,
    incidents: summary,
    activeIncidents: incidents.map((incident) => ({
      ...incident,
      deviceName: incident.deviceId ? names.get(incident.deviceId) ?? null : null,
    })),
    events,
    busiestLinks,
    collector: heartbeat,
    collectorMode: await getSetting("collector.mode", "real"),
    demoMode: isDemoMode(),
  });
}
