/**
 * ============================================================================
 *  GET    /api/discovery/targets/:id — one authorised range
 *  PATCH  /api/discovery/targets/:id — enable, disable or rename a range
 *  DELETE /api/discovery/targets/:id — withdraw the authorisation
 * ============================================================================
 *
 *  The list of enabled ranges IS the collector's licence to send packets.
 *  Removing a range revokes that licence immediately — the collector re-reads
 *  the list before every sweep.
 * ============================================================================
 */

import {
  deleteScanTarget,
  getScanTarget,
  updateScanTarget,
} from "@/lib/repo/discovery";
import { parseCidr } from "@/lib/net/discovery";
import { recordAudit } from "@/lib/repo/audit";
import { recordEvent } from "@/lib/repo/events";
import { fail, ok, readJson, requirePermission } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

async function resolveId(params: Params["params"]): Promise<number | null> {
  const { id } = await params;
  const numeric = Number(id);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const gate = await requirePermission("can_view_topology");
  if (gate.response) return gate.response;

  const id = await resolveId(params);
  if (id === null) return fail("Invalid range id.", 400);

  const target = await getScanTarget(id);
  if (!target) return fail("That range is no longer registered.", 404);

  let size: number | null = null;
  try {
    size = parseCidr(target.cidr).size;
  } catch {
    size = null;
  }

  return ok({ target, size });
}

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  const gate = await requirePermission("can_run_discovery");
  if (gate.response) return gate.response;

  const id = await resolveId(params);
  if (id === null) return fail("Invalid range id.", 400);

  const current = await getScanTarget(id);
  if (!current) return fail("That range is no longer registered.", 404);

  const body = await readJson(request);
  const patch: Parameters<typeof updateScanTarget>[1] = {};
  if (typeof body.description === "string") patch.description = body.description;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

  if (Object.keys(patch).length === 0) return fail("Nothing to change.");

  await updateScanTarget(id, patch);

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "update",
    entity: "scan_target",
    entityId: id,
    before: { cidr: current.cidr, enabled: current.enabled, description: current.description },
    after: {
      cidr: current.cidr,
      enabled: patch.enabled ?? current.enabled,
      description: patch.description ?? current.description,
    },
    note: patch.enabled === false
      ? "The scan range was disabled — the collector may no longer sweep it."
      : "The scan range was changed.",
  });
  await recordEvent({
    type: "config_changed",
    severity: patch.enabled === false ? "minor" : "info",
    title: `Scan range updated: ${current.cidr}`,
    detail:
      patch.enabled === false
        ? "The range is disabled; the collector will not sweep it."
        : "The range was changed.",
    subjectType: "system",
    subjectId: null,
    source: "console",
  });

  return ok({ id, target: await getScanTarget(id) });
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  const gate = await requirePermission("can_run_discovery");
  if (gate.response) return gate.response;

  const id = await resolveId(params);
  if (id === null) return fail("Invalid range id.", 400);

  const current = await getScanTarget(id);
  if (!current) return fail("That range is no longer registered.", 404);

  await deleteScanTarget(id);

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "delete",
    entity: "scan_target",
    entityId: id,
    before: { cidr: current.cidr, enabled: current.enabled },
    note: "The scan range was withdrawn — the collector may no longer sweep it.",
  });
  await recordEvent({
    type: "config_changed",
    severity: "minor",
    title: `Scan range withdrawn: ${current.cidr}`,
    detail: "The range is no longer authorised; the collector will not sweep it.",
    subjectType: "system",
    subjectId: null,
    source: "console",
  });

  return ok({ id, deleted: true });
}
