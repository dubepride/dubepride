/**
 * ============================================================================
 *  GET /api/switches — every switch with its port inventory
 * ============================================================================
 *
 *  A switch is a first-class object in Mineazy Network: the list shows how
 *  many of its ports are up, how many are down and how many are still
 *  unresolved (up, but nothing is known to be plugged into them).
 * ============================================================================
 */

import { listDevices } from "@/lib/repo/devices";
import { listPorts, portSummary } from "@/lib/repo/ports";
import { connectionsForDevice } from "@/lib/repo/connections";
import { requirePermission, ok } from "@/lib/api";
import type { Device, NetworkPort } from "@/lib/types";

export interface SwitchView {
  device: Device;
  ports: NetworkPort[];
  summary: {
    total: number;
    active: number;
    withConnection: number;
    unresolved: number;
    down: number;
  };
  connections: number;
}

export async function GET(): Promise<Response> {
  const gate = await requirePermission("can_view_topology");
  if (gate.response) return gate.response;

  const devices = await listDevices({ category: "switch" });
  const switches: SwitchView[] = [];

  for (const device of devices) {
    const [ports, summary, connections] = await Promise.all([
      listPorts(device.id),
      portSummary(device.id),
      connectionsForDevice(device.id),
    ]);
    switches.push({ device, ports, summary, connections: connections.length });
  }

  return ok({ switches, count: switches.length });
}
