/**
 * ============================================================================
 *  net/auto-discover.ts — the automatic map
 * ============================================================================
 *
 *  The requirement is that the console maps the network on its own, without an
 *  operator pressing "scan". This module is that scan:
 *
 *    1. read the neighbour table (cheap; every device the host has talked to),
 *    2. sweep the authorised ranges (the only part that sends packets),
 *    3. link what was found to the default gateway.
 *
 *  It is deliberately conservative. The sweep only ever touches address ranges
 *  an administrator registered, it is rate-limited, and it stops at a time
 *  budget. ARP-only discovery still works when no range is registered.
 * ============================================================================
 */

import { getNumberSetting } from "../settings";
import { listScanTargets } from "../repo/discovery";
import { deviceByIp } from "../repo/devices";
import os from "node:os";
import {
  detectDefaultGateway,
  listLocalInterfaces,
  parseCidr,
  readArpTable,
  sweepAuthorisedRanges,
  usableArpEntries,
} from "./discovery";
import { ingestObservedHost, markObservedRole } from "./ingest";
import { fingerprintHost } from "./fingerprint";
import { readNetbiosName } from "./netbios";
import { inferStarTopology, type InferredTopology } from "./topology-infer";

export interface AutoDiscoveryResult {
  addressesScanned: number;
  responded: number;
  created: number;
  updated: number;
  /** Devices that gained a service fingerprint or a name this pass. */
  enriched: number;
  inferred: InferredTopology;
  /** True when no authorised range is registered, so nothing was swept. */
  arpOnly: boolean;
}

/**
 * Ask the devices that are still unclassified what they are.
 *
 * Only hosts without a verdict are probed, and only a bounded number of them
 * at once. A device is enriched when a port answers or a NetBIOS name comes
 * back; a silent device is left exactly as it was.
 */
async function enrichUnknownHosts(
  hosts: Map<string, string>,
  concurrency = 8
): Promise<number> {
  const queue = [...hosts.entries()];
  let cursor = 0;
  let enriched = 0;

  const worker = async (): Promise<void> => {
    while (cursor < queue.length) {
      const [ip, mac] = queue[cursor];
      cursor += 1;

      const device = await deviceByIp(ip);
      if (!device) continue;
      if (device.category !== "unknown" && device.classificationEvidence) continue;

      const [fingerprint, netbios] = await Promise.all([
        fingerprintHost(ip),
        device.hostname ? Promise.resolve(device.hostname) : readNetbiosName(ip),
      ]);
      if (fingerprint.openPorts.length === 0 && !netbios) continue;

      await ingestObservedHost({
        ip,
        mac: mac || device.mac,
        hostname: netbios ?? device.hostname ?? undefined,
        openPorts: fingerprint.openPorts,
        source: "active_scan",
      });
      enriched += 1;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return enriched;
}

/** Run one automatic discovery pass. Safe to call repeatedly. */
export async function runAutoDiscovery(): Promise<AutoDiscoveryResult> {
  const targets = (await listScanTargets()).filter((target) => target.enabled);
  const networks = targets.map((target) => parseCidr(target.cidr));

  const arp = await readArpTable();
  const entries = usableArpEntries(arp, networks);

  let created = 0;
  let updated = 0;
  const record = (result: { created: boolean }): void => {
    if (result.created) created += 1;
    else updated += 1;
  };

  const observed = new Map<string, string>();
  for (const entry of entries) {
    observed.set(entry.ip, entry.mac);
    record(await ingestObservedHost({ ip: entry.ip, mac: entry.mac, source: "arp" }));
  }

  let addressesScanned = 0;
  let responded = 0;

  if (targets.length > 0) {
    const result = await sweepAuthorisedRanges({
      rateLimitPerSecond: await getNumberSetting("discovery.rateLimitPerSecond", 50),
      timeoutMs: 1000,
      maxDurationMs: 120_000,
    });
    addressesScanned = result.addressesScanned;
    responded = result.hits.length;

    for (const hit of result.hits) {
      const mac = observed.get(hit.ip) ?? "";
      observed.set(hit.ip, mac);
      record(
        await ingestObservedHost({
          ip: hit.ip,
          mac,
          hostname: hit.hostname,
          source: "active_scan",
        })
      );
    }

    // The sweep's own packets create neighbour entries. Reading the table a
    // second time is what gives a host found only by ICMP its MAC address —
    // and therefore its vendor, its name and its icon.
    for (const entry of usableArpEntries(await readArpTable(), networks)) {
      if (observed.get(entry.ip)) continue;
      observed.set(entry.ip, entry.mac);
      record(await ingestObservedHost({ ip: entry.ip, mac: entry.mac, source: "arp" }));
    }
  }

  const enriched = await enrichUnknownHosts(observed);

  // Two roles are facts, not inferences: the default route and this host.
  const gatewayIp = await detectDefaultGateway();
  if (gatewayIp) {
    const gateway = await deviceByIp(gatewayIp);
    const vendor = gateway?.manufacturer?.trim();
    await markObservedRole(
      gatewayIp,
      "router",
      "This is the default gateway in the host's routing table — every packet leaving the subnet is sent here.",
      vendor ? `${vendor} router` : "Network router"
    );
  }
  for (const iface of listLocalInterfaces()) {
    if (iface.family !== "IPv4" || iface.internal) continue;
    await markObservedRole(
      iface.address,
      "desktop",
      "This is an address of the machine running the console, reported by the operating system.",
      os.hostname()
    );
  }

  const inferred = await inferStarTopology();

  return {
    addressesScanned,
    responded,
    created,
    updated,
    enriched,
    inferred,
    arpOnly: targets.length === 0,
  };
}
