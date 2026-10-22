/**
 * ============================================================================
 *  GET  /api/discovery/targets — the authorised scan ranges
 *  POST /api/discovery/targets — authorise a new range
 * ============================================================================
 *
 *  Adding a range here is the ONLY way to authorise the collector to touch
 *  an address. The CIDR is validated before it is stored.
 * ============================================================================
 */

import { listScanTargets, createScanTarget } from "@/lib/repo/discovery";
import { parseCidr } from "@/lib/net/discovery";
import { recordAudit } from "@/lib/repo/audit";
import { recordEvent } from "@/lib/repo/events";
import { fail, ok, readJson, requirePermission } from "@/lib/api";

export async function GET(): Promise<Response> {
  const gate = await requirePermission("can_view_topology");
  if (gate.response) return gate.response;

  const targets = await listScanTargets();
  return ok({ targets, count: targets.length });
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requirePermission("can_run_discovery");
  if (gate.response) return gate.response;

  const body = await readJson(request);
  const cidr = typeof body.cidr === "string" ? body.cidr.trim() : "";
  if (!cidr) return fail("A CIDR range is required (for example 192.168.1.0/24).");

  let block;
  try {
    block = parseCidr(cidr);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "That CIDR range is not valid.");
  }

  let id: number;
  try {
    id = await createScanTarget(
      block.size === 1 ? `${block.network}/32` : `${block.network}/${block.prefix}`,
      typeof body.description === "string" ? body.description : ""
    );
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The range could not be registered.");
  }

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "create",
    entity: "scan_target",
    entityId: id,
    after: { cidr: `${block.network}/${block.prefix}` },
    note: "A scan range was authorised.",
  });
  await recordEvent({
    type: "config_changed",
    severity: "info",
    title: `Scan range authorised: ${block.network}/${block.prefix}`,
    detail: `The collector may now sweep ${block.size} address(es) in this range.`,
    subjectType: "system",
    subjectId: null,
    source: "console",
  });

  return ok({ id, cidr: `${block.network}/${block.prefix}`, size: block.size }, 201);
}
