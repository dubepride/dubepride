/**
 * ============================================================================
 *  /api/settings/accounts/[id] — mutate one System Account (Phase 13)
 * ============================================================================
 *
 *  PATCH  → partial update from the unified Add / Edit form:
 *           { firstName?, surname?, email?, accessLevelId?, branchId?,
 *             employeeId?, password? }
 *           Only the keys present are applied. The password is re-hashed
 *           **only** when a non-empty value is supplied, so account details
 *           can be edited without touching the stored credential. Required
 *           fields, email uniqueness and every FK reference are validated
 *           server-side (see updateSystemAccount in lib/db).
 *
 *  DELETE → removes the account.
 *
 *  Prohibited cases (409):
 *    • deleting the built-in bridge administrator (admin@biobridge.com)
 *      — the app must always keep a guaranteed login path. (PATCH is allowed
 *      on it, so the administrator's details/password can still be maintained.)
 *
 *  Their Time_Off_Requests are removed with the account. Every mutation is
 *  identified by the numeric account id and requires can_add_accounts.
 */

import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth";
import { deleteSystemAccount, updateSystemAccount, type SystemAccountPatch } from "@/lib/db";

const NO_STORE = { "Cache-Control": "no-store" };

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status, headers: NO_STORE });
}

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const guard = await requirePermission("can_add_accounts");
  if (guard) return guard;

  const accountId = Number((await ctx.params).id);
  if (!Number.isInteger(accountId) || accountId <= 0) return bad("A numeric account id is required.");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("Invalid JSON body.");
  }

  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const patch: SystemAccountPatch = {};
  if ("firstName" in body) patch.firstName = str(body.firstName);
  if ("surname" in body) patch.surname = str(body.surname);
  if ("email" in body) patch.email = str(body.email);
  if ("accessLevelId" in body) patch.accessLevelId = numOrNull(body.accessLevelId);
  if ("branchId" in body) patch.branchId = numOrNull(body.branchId);
  if ("employeeId" in body) patch.employeeId = numOrNull(body.employeeId);
  if ("password" in body) patch.password = str(body.password);

  const result = await updateSystemAccount(accountId, patch);
  if (!result.ok) return bad(result.reason ?? "Could not update the account.", 409);
  return Response.json({ ok: true }, { headers: NO_STORE });
}

export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const guard = await requirePermission("can_add_accounts");
  if (guard) return guard;

  const accountId = Number((await ctx.params).id);
  if (!Number.isInteger(accountId) || accountId <= 0) return bad("A numeric account id is required.");

  const result = await deleteSystemAccount(accountId);
  if (!result.ok) return bad(result.reason ?? "Could not delete the account.", 409);
  return Response.json({ ok: true }, { headers: NO_STORE });
}
