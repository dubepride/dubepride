/**
 * ============================================================================
 *  /api/settings/accounts — the System Accounts directory (Phase 13, tab 3)
 * ============================================================================
 *
 *  GET  → every account joined with its Access Level + Branch (+ optional
 *         linked employee) plus the drop-down catalogues the create form
 *         needs: `levels` (id + name) and `branches` (id + name).
 *
 *  POST → create { firstName, surname, email, password, accessLevelId,
 *                  branchId, employeeId? }. Validates the fields, hashes the
 *         password (sha256) and stores the account; the Level / Branch
 *         selects are fetched dynamically from their tables.
 *
 *  Server-side protection: requires can_add_accounts. Deletion lives on
 *  /api/settings/accounts/[id] (the built-in bridge administrator is
 *  protected from removal).
 */

import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth";
import {
  createSystemAccount,
  listAccessLevels,
  listBranches,
  listSystemAccounts,
} from "@/lib/db";
import type { SystemAccountsResponse } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status, headers: NO_STORE });
}

export async function GET(): Promise<Response> {
  const guard = await requirePermission("can_add_accounts");
  if (guard) return guard;

  const payload: SystemAccountsResponse = {
    accounts: listSystemAccounts(),
    // The Matrix tab's level list is the canonical catalogue.
    levels: listAccessLevels().map((l) => ({ id: l.id, name: l.name })),
    branches: listBranches().map((b) => ({ id: b.id, name: b.name })),
    generatedAt: Date.now(),
  };
  return Response.json(payload, { headers: NO_STORE });
}

export async function POST(request: NextRequest): Promise<Response> {
  const guard = await requirePermission("can_add_accounts");
  if (guard) return guard;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("Invalid JSON body.");
  }

  const numOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  try {
    const id = createSystemAccount({
      firstName: String(body.firstName ?? ""),
      surname: String(body.surname ?? ""),
      email: String(body.email ?? ""),
      password: String(body.password ?? ""),
      accessLevelId: numOrNull(body.accessLevelId),
      branchId: numOrNull(body.branchId),
      employeeId: numOrNull(body.employeeId),
    });
    return Response.json({ ok: true, id }, { headers: NO_STORE });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not create the account.";
    return bad(
      message.includes("UNIQUE")
        ? "An account with that company email already exists."
        : message
    );
  }
}