/**
 * ============================================================================
 *  DELETE /api/settings/accounts/[id] — remove a System Account (Phase 13)
 * ============================================================================
 *
 *  Prohibited cases (409):
 *    • deleting the built-in bridge administrator (admin@biobridge.example)
 *      — the app must always keep a guaranteed login path.
 *
 *  Their Time_Off_Requests are removed with the account. Requires
 *  can_add_accounts.
 */

import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth";
import { deleteSystemAccount } from "@/lib/db";

const NO_STORE = { "Cache-Control": "no-store" };

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status, headers: NO_STORE });
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