/**
 * ============================================================================
 *  /api/settings/access-levels/[id] — rename / edit the matrix / delete
 * ============================================================================
 *
 *  GET    → { level } — a single level with its parsed matrix, so the
 *           accordion can render its checkboxes when expanded.
 *
 *  PATCH  → { name?, permissions? } — either field optional. `permissions`
 *           is the FULL matrix (every key → boolean); unknown keys are
 *           dropped and missing known keys default to false, so a partial
 *           payload can never silently leave a capability enabled.
 *
 *  DELETE → remove the level. Levels still assigned to System Accounts are
 *           refused (409) so no account silently loses its role.
 *
 *  All handlers require can_manage_access_levels.
 */

import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth";
import { accessLevelById, deleteAccessLevel, updateAccessLevel } from "@/lib/db";
import { parsePermissions, type PermissionsMap } from "@/lib/rbac";

const NO_STORE = { "Cache-Control": "no-store" };

function respond(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status, headers: NO_STORE });
}

async function levelIdOf(ctx: { params: Promise<{ id: string }> }): Promise<number> {
  return ctx.params.then(({ id }) => Number(id));
}

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const guard = await requirePermission("can_manage_access_levels");
  if (guard) return guard;

  const levelId = await levelIdOf(ctx);
  if (!Number.isInteger(levelId) || levelId <= 0) return respond("A numeric level id is required.", 404);

  const level = accessLevelById(levelId);
  if (!level) return respond("That access level no longer exists.", 404);
  return Response.json({ level }, { headers: NO_STORE });
}

export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const guard = await requirePermission("can_manage_access_levels");
  if (guard) return guard;

  const levelId = await levelIdOf(ctx);
  if (!Number.isInteger(levelId) || levelId <= 0) return respond("A numeric level id is required.");

  let body: { name?: unknown; permissions?: unknown };
  try {
    body = (await request.json()) as { name?: unknown; permissions?: unknown };
  } catch {
    return respond("Invalid JSON body.");
  }

  const patch: { name?: string; permissions?: PermissionsMap } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string") return respond("`name` must be a string.");
    patch.name = body.name;
  }
  if (body.permissions !== undefined) {
    if (typeof body.permissions !== "object" || body.permissions === null) {
      return respond("`permissions` must be an object of key → boolean.");
    }
    patch.permissions = parsePermissions(body.permissions);
  }

  try {
    updateAccessLevel(levelId, patch);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not update the access level.";
    if (message.includes("UNIQUE")) return respond("That access level name is already in use.");
    if (message.includes("no longer exists")) return respond(message, 404);
    return respond(message);
  }
}

export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const guard = await requirePermission("can_manage_access_levels");
  if (guard) return guard;

  const levelId = await levelIdOf(ctx);
  if (!Number.isInteger(levelId) || levelId <= 0) return respond("A numeric level id is required.");

  const result = deleteAccessLevel(levelId);
  if (!result.ok) return respond(result.reason ?? "Could not delete the access level.", 409);
  return Response.json({ ok: true }, { headers: NO_STORE });
}