/**
 * ============================================================================
 *  GET  /api/discovery — the authorised ranges, the job history and the
 *                        local interface inventory
 *  POST /api/discovery — run a discovery job
 * ============================================================================
 *
 *  Discovery is ALWAYS bounded by the authorised ranges in `Scan_Targets`.
 *  A job that would touch an address outside them is refused by
 *  `lib/net/discovery.ts` before a single packet is sent.
 * ============================================================================
 */

import { listScanTargets, listJobs, startJob, finishJob } from "@/lib/repo/discovery";
import { sweepAuthorisedRanges, readArpTable, localIpv4Networks, listLocalInterfaces, parseCidr, usableArpEntries } from "@/lib/net/discovery";
import { classifyDevice, vendorFromMac } from "@/lib/net/classify";
import { upsertDiscoveredDevice, deviceByIp } from "@/lib/repo/devices";
import { recordEvent } from "@/lib/repo/events";
import { recordAudit } from "@/lib/repo/audit";
import { getNumberSetting } from "@/lib/settings";
import { fail, ok, readJson, requirePermission } from "@/lib/api";

export async function GET(): Promise<Response> {
  const gate = await requirePermission("can_view_topology");
  if (gate.response) return gate.response;

  const [targets, jobs, arp] = await Promise.all([
    listScanTargets(),
    listJobs(25),
    readArpTable(),
  ]);

  return ok({
    targets,
    jobs,
    arp: arp.slice(0, 200),
    arpCount: arp.length,
    localNetworks: localIpv4Networks(),
    interfaces: listLocalInterfaces(),
  });
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requirePermission("can_run_discovery");
  if (gate.response) return gate.response;

  const body = await readJson(request);
  const kind = typeof body.kind === "string" ? body.kind : "sweep";

  const targets = await listScanTargets();
  const enabled = targets.filter((target) => target.enabled);
  if (enabled.length === 0) {
    return fail(
      "No authorised scan range is registered. Add one on the Discovery screen before running a sweep."
    );
  }

  const jobId = await startJob(kind, enabled.map((target) => target.cidr).join(", "));

  try {
    if (kind === "arp") {
      const arp = await readArpTable();
      // The neighbour table is not an inventory. Multicast, broadcast and
      // link-local entries — and anything outside the authorised ranges —
      // are dropped before a device row can be created from them.
      const entries = usableArpEntries(
        arp,
        enabled.map((target) => parseCidr(target.cidr))
      );
      let created = 0;
      for (const entry of entries) {
        const vendor = vendorFromMac(entry.mac);
        const classification = classifyDevice({ mac: entry.mac });
        const { created: isNew } = await upsertDiscoveredDevice({
          ip: entry.ip,
          mac: entry.mac,
          manufacturer: vendor ?? undefined,
          category: classification.category,
          source: "arp",
          confidence: classification.confidence,
        });
        if (isNew) created += 1;
      }
      const ignored = arp.length - entries.length;
      const summary = `${arp.length} neighbour entr${arp.length === 1 ? "y" : "ies"} read, ${entries.length} usable (${ignored} ignored), ${created} new device(s).`;
      await finishJob(jobId, "completed", summary);
      await recordEvent({
        type: "discovery_completed",
        severity: "info",
        title: "ARP discovery completed",
        detail: summary,
        subjectType: "system",
        subjectId: null,
        source: "console",
      });
      await recordAudit({
        userId: gate.account.id,
        userName: gate.account.username,
        action: "run",
        entity: "discovery",
        entityId: jobId,
        after: { kind },
        note: summary,
      });
      return ok({ jobId, kind, arp: arp.length, created, summary });
    }

    const result = await sweepAuthorisedRanges({
      rateLimitPerSecond: await getNumberSetting("discovery.rateLimitPerSecond", 50),
      timeoutMs: 1000,
      maxDurationMs: 120_000,
    });

    // A sweep only carries an address. The neighbour table supplies the MAC,
    // which is what the classifier needs for a vendor, so merge the two.
    const macByIp = new Map(
      usableArpEntries(await readArpTable(), enabled.map((target) => parseCidr(target.cidr))).map(
        (entry) => [entry.ip, entry.mac] as const
      )
    );

    let created = 0;
    let updated = 0;
    for (const hit of result.hits) {
      const existing = await deviceByIp(hit.ip);
      // A scan must never overwrite what SNMP or an administrator established.
      if (existing && !["arp", "active_scan", "unknown"].includes(existing.discoverySource)) {
        continue;
      }

      const mac = macByIp.get(hit.ip) ?? existing?.mac ?? "";
      const classification = classifyDevice({ hostname: hit.hostname, mac });
      const { created: isNew } = await upsertDiscoveredDevice({
        ip: hit.ip,
        mac,
        hostname: hit.hostname ?? undefined,
        manufacturer: vendorFromMac(mac) ?? undefined,
        category: classification.category,
        confidence: classification.confidence,
        source: "active_scan",
      });
      if (isNew) created += 1;
      else updated += 1;
    }

    const summary =
      `${result.addressesScanned} address(es) scanned, ${result.hits.length} responded, ` +
      `${created} new device(s), ${updated} updated` +
      (result.truncated ? " (the sweep was truncated by the safety limit)" : "") +
      (result.refused > 0 ? `, ${result.refused} address(es) refused as unauthorised` : "") +
      ".";

    await finishJob(jobId, "completed", summary);
    await recordEvent({
      type: "discovery_completed",
      severity: "info",
      title: "Discovery sweep completed",
      detail: summary,
      subjectType: "system",
      subjectId: null,
      source: "console",
    });
    await recordAudit({
      userId: gate.account.id,
      userName: gate.account.username,
      action: "run",
      entity: "discovery",
      entityId: jobId,
      after: { kind },
      note: summary,
    });

    return ok({ jobId, kind, ...result, created, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishJob(jobId, "failed", "", message);
    return fail(`The discovery job failed: ${message}`, 500);
  }
}
