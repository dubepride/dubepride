/**
 * ============================================================================
 *  /api/settings/branches/[id] — rename / delete a site (Phase 13, tab 1)
 * ============================================================================
 *
 *  PATCH  → { name } rename. Employees/Terminals carrying the old name are
 *           updated too, so the denormalised Branch_Name columns never
 *           drift from the Branches table.
 *  DELETE → remove the site; records that referenced it fall back to
 *           "Unassigned" ("").
 *
 *  Both handlers require can_manage_branches (server-side, on top of the
 *  session wall).
 */

import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth";
import { deleteBranch, renameBranch, setBranchClocking } from "@/lib/db";
import {
  hasClockingConfig,
  readClockingConfig,
  validateClockingConfig,
} from "@/lib/geofence";

const NO_STORE = { "Cache-Control": "no-store" };

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status, headers: NO_STORE });
}

function branchIdOf(ctx: { params: Promise<{ id: string }> }): Promise<number> {
  return ctx.params.then(({ id }) => Number(id));
}

export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const guard = await requirePermission("can_manage_branches");
  if (guard) return guard;

  const branchId = await branchIdOf(ctx);
  if (!Number.isInteger(branchId) || branchId <= 0) return bad("A numeric branch id is required.");

  let name = "";
  let clocking = {} as ReturnType<typeof readClockingConfig>;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    name = typeof body?.name === "string" ? body.name.trim() : "";
    clocking = readClockingConfig(body);
  } catch {
    return bad("Invalid JSON body.");
  }

  const hasClocking = hasClockingConfig(clocking);
  if (!name && !hasClocking) {
    return bad("Provide a name and/or clocking configuration to update.");
  }
  if (hasClocking) {
    const problem = validateClockingConfig(clocking);
    if (problem) return bad(problem);
  }

  try {
    // Rename first (keeps Employees/Terminals in sync), then apply the
    // Phase 15 clocking method + geofence — both are independent edits.
    if (name) renameBranch(branchId, name);
    if (hasClocking) setBranchClocking(branchId, clocking);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not update the branch.";
    if (message.includes("UNIQUE")) return bad(`A branch named "${name}" already exists.`);
    if (message.includes("no longer exists")) return bad(message, 404);
    return bad(message);
  }
}

export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const guard = await requirePermission("can_manage_branches");
  if (guard) return guard;

  const branchId = await branchIdOf(ctx);
  if (!Number.isInteger(branchId) || branchId <= 0) return bad("A numeric branch id is required.");

  const removed = deleteBranch(branchId);
  if (!removed) return bad("That branch no longer exists.", 404);
  return Response.json({ ok: true }, { headers: NO_STORE });
}