/**
 * ============================================================================
 *  net/ingest.ts — turn an observation into a device record
 * ============================================================================
 *
 *  Both the Discovery screen and the collector's automatic scan use this, so a
 *  device found by either route is classified, named and stored the same way.
 * ============================================================================
 */

import { classifyDevice, suggestedName, vendorFromMac } from "./classify";
import { classifyFromPorts } from "./fingerprint";
import { deviceByIp, upsertDiscoveredDevice } from "../repo/devices";
import type { DeviceCategory, DiscoverySource } from "../types";

export interface ObservedHost {
  ip: string;
  /** Empty when only an address was seen — the scan's ICMP reply, say. */
  mac: string;
  hostname?: string | null;
  source: DiscoverySource;
  /** TCP service ports that answered, when a fingerprint was taken. */
  openPorts?: number[];
}

/**
 * Store one observed host.
 *
 * The category comes from the strongest evidence available: an open service
 * port first, then the classifier's OUI/hostname rules. The name comes from
 * whatever was actually learned — never from a guess about what the device
 * "probably" is.
 */
export async function ingestObservedHost(host: ObservedHost): Promise<{
  id: number;
  created: boolean;
}> {
  const manufacturer = vendorFromMac(host.mac);
  const base = classifyDevice({
    hostname: host.hostname ?? undefined,
    mac: host.mac,
  });
  const fromPorts = host.openPorts
    ? classifyFromPorts({
        openPorts: host.openPorts,
        manufacturer,
        hostname: host.hostname,
      })
    : null;
  const classification = fromPorts ?? base;

  return upsertDiscoveredDevice({
    ip: host.ip,
    mac: host.mac,
    hostname: host.hostname ?? undefined,
    manufacturer: manufacturer ?? undefined,
    category: classification.category,
    confidence: classification.confidence,
    classificationEvidence: classification.evidence,
    source: host.source,
    displayName: suggestedName({
      category: classification.category,
      manufacturer,
      hostname: host.hostname,
      mac: host.mac,
      ip: host.ip,
    }),
  });
}

/**
 * Record a role that is certain from where the address sits, not from a probe.
 *
 * Two addresses carry their role with them: the host's default gateway (every
 * off-subnet packet is sent there) and the addresses of the machine running
 * the console. Both are facts the operating system reports, so the category is
 * "confirmed" and the evidence says which fact it came from.
 */
export async function markObservedRole(
  ip: string,
  category: DeviceCategory,
  evidence: string,
  name?: string
): Promise<boolean> {
  const device = await deviceByIp(ip);
  if (!device || device.category === category) return false;

  await upsertDiscoveredDevice({
    ip,
    mac: device.mac,
    category,
    confidence: "confirmed",
    classificationEvidence: evidence,
    // Only used for roles proven by the operating system (the gateway, this
    // host); a name an administrator locked is never touched.
    displayName: name,
    source: device.discoverySource,
  });
  return true;
}
