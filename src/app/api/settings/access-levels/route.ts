/**
 * ============================================================================
 *  /api/settings/access-levels — the Access Level Matrix (Phase 13, tab 2)
 * ============================================================================
 *
 *  GET  → every level with its parsed permission matrix (key → boolean)
 *         plus the capability headcount and how many accounts hold it.
 *
 *  POST → create { name }. A brand-new level starts with every capability
 *         switched off — the IT admin ticks the matrix and saves via PATCH
 *         on /api/settings/access-levels/[id].
 *
 *  Server-side protection: requires can_manage_access_levels.
 */

import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth";
import { createAccessLevel, listAccessLevels } from "@/lib/db";
import type { AccessLevelsResponse } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status, headers: NO_STORE });
}

export async function GET(): Promise<Response> {
  const guard = await requirePermission("can_manage_access_levels");
  if (guard) return guard;

  const payload: AccessLevelsResponse = { levels: listAccessLevels(), generatedAt: Date.now() };
  return Response.json(payload, { headers: NO_STORE });
}

export async function POST(request: NextRequest): Promise<Response> {
  const guard = await requirePermission("can_manage_access_levels");
  if (guard) return guard;

  let name = "";
  try {
    const body = (await request.json()) as { name?: unknown };
    name = typeof body?.name === "string" ? body.name : "";
  } catch {
    return bad("Invalid JSON body.");
  }

  try {
    const id = createAccessLevel(name);
    return Response.json({ ok: true, id }, { headers: NO_STORE });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not add the access level.";
    return bad(
      message.includes("UNIQUE") ? `An access level named "${name.trim()}" already exists.` : message
    );
  }
}