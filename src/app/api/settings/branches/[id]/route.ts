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
import { deleteBranch, renameBranch } from "@/lib/db";

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
  try {
    const body = (await request.json()) as { name?: unknown };
    name = typeof body?.name === "string" ? body.name : "";
  } catch {
    return bad("Invalid JSON body.");
  }

  try {
    renameBranch(branchId, name);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not rename the branch.";
    if (message.includes("UNIQUE")) return bad(`A branch named "${name.trim()}" already exists.`);
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