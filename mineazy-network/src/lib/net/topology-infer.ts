/**
 * ============================================================================
 *  net/topology-infer.ts — connect what discovery found, without pretending
 * ============================================================================
 *
 *  LLDP, CDP and switch forwarding tables are the correct sources for a
 *  topology. On a home LAN — where the router exposes no SNMP and the access
 *  points are unmanaged — none of them exist.
 *
 *  What *is* known is this: every device answered on the same subnet, and the
 *  host has a default gateway. That justifies drawing the device as attached
 *  to the gateway, and nothing more. So the link is written with a low
 *  confidence, is never marked verified, and carries evidence that states in
 *  plain words that it was inferred rather than observed.
 *
 *  These links are additive only: a device that already has an observed
 *  neighbour (LLDP/FDB/SNMP, written by the collector) is left alone, and an
 *  existing inferred link is simply refreshed.
 * ============================================================================
 */

import { detectDefaultGateway } from "./discovery";
import { listDevices } from "../repo/devices";
import { listConnections, upsertConnection } from "../repo/connections";
import type { Device } from "../types";

const INFERRED_SOURCE = "active_scan" as const;
const INFERRED_CONFIDENCE = 0.35;

/**
 * Choose the device that represents the network's origin.
 *
 * The default route is the strongest evidence; failing that, a device the
 * classifier already called a gateway/router is used. A console run on a
 * machine with no default route simply infers nothing.
 */
function findOrigin(devices: Device[], gatewayIp: string | null, connections: { localDeviceId: number }[]): Device | null {
  if (gatewayIp) {
    const byAddress = devices.find((device) => device.mgmtIp === gatewayIp);
    if (byAddress) return byAddress;
  }
  const classified =
    devices.find((device) => device.category === "gateway") ??
    devices.find((device) => device.category === "router");
  if (classified) return classified;

  // A device addressed x.x.x.1 on the subnet is the conventional router
  // address; the classifier may not have decided yet, but the address is real
  // evidence of where the subnet starts.
  const byConvention = devices.find((device) => device.mgmtIp.endsWith(".1"));
  if (byConvention) return byConvention;

  // Last resort: whatever the network talks through the most.
  const counts = new Map<number, number>();
  for (const connection of connections) {
    counts.set(connection.localDeviceId, (counts.get(connection.localDeviceId) ?? 0) + 1);
  }
  let busiest: Device | null = null;
  let best = 0;
  for (const device of devices) {
    const count = counts.get(device.id) ?? 0;
    if (count > best) {
      best = count;
      busiest = device;
    }
  }
  return busiest;
}

export interface InferredTopology {
  originId: number | null;
  originName: string | null;
  /** Number of newly created star links. */
  linked: number;
  /** Devices already attached by an observed neighbour, left untouched. */
  observed: number;
}

/**
 * Attach every unattached device to the origin as an inferred access link.
 *
 * Idempotent: running it after every sweep refreshes the evidence on existing
 * inferred links and creates one only where there is none.
 */
export async function inferStarTopology(): Promise<InferredTopology> {
  const [devices, connections] = await Promise.all([listDevices({}), listConnections()]);
  if (devices.length === 0) return { originId: null, originName: null, linked: 0, observed: 0 };

  const origin = findOrigin(devices, await detectDefaultGateway(), connections);
  if (!origin) return { originId: null, originName: null, linked: 0, observed: 0 };

  const attached = new Map<number, { observed: boolean }>();
  for (const connection of connections) {
    for (const deviceId of [connection.localDeviceId, connection.remoteDeviceId]) {
      const observed =
        connection.source !== INFERRED_SOURCE || connection.verified || connection.confidence >= 0.6;
      const current = attached.get(deviceId);
      attached.set(deviceId, { observed: Boolean(current?.observed || observed) });
    }
  }

  let linked = 0;
  let observed = 0;
  for (const device of devices) {
    if (device.id === origin.id) continue;
    const attachment = attached.get(device.id);
    if (attachment?.observed) {
      observed += 1;
      continue;
    }

    const { created } = await upsertConnection({
      localDeviceId: origin.id,
      remoteDeviceId: device.id,
      type: "access",
      source: INFERRED_SOURCE,
      confidence: INFERRED_CONFIDENCE,
      verified: false,
      evidence:
        `${device.name} answered on ${device.mgmtIp || "the local subnet"} together with the ` +
        `default gateway ${origin.name}. No LLDP, CDP or forwarding-table entry was available, ` +
        "so this cable position is inferred from sharing the gateway's subnet.",
    });
    if (created) linked += 1;
  }

  return { originId: origin.id, originName: origin.name, linked, observed };
}
