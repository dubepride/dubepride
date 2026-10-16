/**
 * ============================================================================
 *  /api/settings/branches — the global Branch list (Phase 13, tab 1)
 * ============================================================================
 *
 *  GET    → every site in the Branches table with live headcounts
 *            (employees + terminals assigned). Feeds the Settings
 *            "Branches" tab AND the Employee form's branch dropdown.
 *
 *  POST   → create { name } — validates non-empty, rejects duplicates.
 *
 *  Renames and deletions live on /api/settings/branches/[id] (PATCH/DELETE).
 *
 *  Server-side protection: every handler re-checks the session AND the
 *  can_manage_branches capability (the UI hides the tab without it, the API
 *  returns 403 with it missing). Success payloads are no-store.
 */

import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth";
import { createBranch, listBranches } from "@/lib/db";
import {
  hasClockingConfig,
  readClockingConfig,
  validateClockingConfig,
} from "@/lib/geofence";
import type { BranchesResponse } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status, headers: NO_STORE });
}

export async function GET(): Promise<Response> {
  const guard = await requirePermission("can_manage_branches");
  if (guard) return guard;

  const payload: BranchesResponse = { branches: await listBranches(), generatedAt: Date.now() };
  return Response.json(payload, { headers: NO_STORE });
}

export async function POST(request: NextRequest): Promise<Response> {
  const guard = await requirePermission("can_manage_branches");
  if (guard) return guard;

  let name = "";
  let clocking = {} as ReturnType<typeof readClockingConfig>;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    name = typeof body?.name === "string" ? body.name : "";
    clocking = readClockingConfig(body);
  } catch {
    return bad("Invalid JSON body.");
  }

  // Phase 15 — optional clocking method + geofence centre for the new site.
  if (hasClockingConfig(clocking)) {
    const problem = validateClockingConfig(clocking);
    if (problem) return bad(problem);
  }

  try {
    const id = await createBranch(name, clocking);
    return Response.json({ ok: true, id }, { headers: NO_STORE });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not add the branch.";
    return bad(
      message.includes("UNIQUE") ? `A branch named "${name.trim()}" already exists.` : message
    );
  }
}