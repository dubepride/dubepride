/**
 * ============================================================================
 *  /api/settings/accounts/[id] — mutate one System Account (Phase 13)
 * ============================================================================
 *
 *  PATCH  → { password } sets a new login password for the account (the
 *           "Set password" row action). Validates the same way account
 *           creation does (min. 6 characters) and stores only the digest.
 *
 *  DELETE → removes the account.
 *
 *  Prohibited cases (409):
 *    • deleting the built-in bridge administrator (admin@biobridge.example)
 *      — the app must always keep a guaranteed login path. (PATCH is allowed
 *      on it, so the administrator's password can still be rotated.)
 *
 *  Their Time_Off_Requests are removed with the account. Requires
 *  can_add_accounts.
 */

import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth";
import { deleteSystemAccount, updateSystemAccountPassword } from "@/lib/db";

const NO_STORE = { "Cache-Control": "no-store" };

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status, headers: NO_STORE });
}

export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const guard = await requirePermission("can_add_accounts");
  if (guard) return guard;

  const accountId = Number((await ctx.params).id);
  if (!Number.isInteger(accountId) || accountId <= 0) return bad("A numeric account id is required.");

  let body: { password?: unknown };
  try {
    body = (await request.json()) as { password?: unknown };
  } catch {
    return bad("A JSON body with a new password is required.");
  }

  const password = typeof body.password === "string" ? body.password : "";
  const result = updateSystemAccountPassword(accountId, password);
  if (!result.ok) return bad(result.reason ?? "Could not update the password.", 409);
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

  const result = deleteSystemAccount(accountId);
  if (!result.ok) return bad(result.reason ?? "Could not delete the account.", 409);
  return Response.json({ ok: true }, { headers: NO_STORE });
}