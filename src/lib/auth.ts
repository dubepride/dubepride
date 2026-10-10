/**
 * ============================================================================
 *  auth.ts — server-side authorization glue for API route handlers
 * ============================================================================
 *
 *  Defense in depth: src/proxy.ts already rejects unauthenticated traffic
 *  before it reaches a route (and enforces page-level permission gating),
 *  but every admin handler re-verifies the session close to the data
 *  ("never trust the client for authorization"). Handlers that gate on a
 *  specific capability use requirePermission() instead, so hiding a button
 *  in the UI is never the only barrier — the API answers 403 too.
 *
 *  Hardware endpoints (/api/biometrics/push) intentionally do NOT use this
 *  guard — fingerprint terminals cannot log in; device trust is network
 *  placement + the shared push URL instead.
 */

import { cookies } from "next/headers";
import type { PermissionKey } from "@/lib/rbac";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";
import { accountByToken, type ResolvedAccount } from "@/lib/db";

export { SESSION_COOKIE, createSessionToken } from "@/lib/session";
export type { ResolvedAccount } from "@/lib/db";

/** Canonical 401 body for admin APIs. */
export function unauthorizedResponse(): Response {
  return Response.json(
    { ok: false, error: "Unauthorized — sign in at /login." },
    { status: 401, headers: { "Cache-Control": "no-store" } }
  );
}

/** Canonical 403 body for authenticated callers lacking a capability. */
export function forbiddenResponse(message = "Insufficient permissions for this action."): Response {
  return Response.json(
    { ok: false, error: message },
    { status: 403, headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * Returns `null` when the caller holds a valid admin session, otherwise a
 * ready-to-return 401 Response. Typical use:
 *
 *   const guard = await requireAdmin();
 *   if (guard) return guard;
 */
export async function requireAdmin(): Promise<Response | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  return verifySessionToken(token) ? null : unauthorizedResponse();
}

/** Resolve the signed-in account from the request cookie (null when absent). */
export async function currentAccount(): Promise<ResolvedAccount | null> {
  const store = await cookies();
  return accountByToken(store.get(SESSION_COOKIE)?.value);
}

/**
 * Returns a `Response` when the caller must not proceed (401 no session,
 * 403 lacks the capability), otherwise `null`. Use it exactly like
 * requireAdmin():
 *
 *   const guard = await requirePermission("can_manage_branches");
 *   if (guard) return guard;
 */
export async function requirePermission(permission: PermissionKey): Promise<Response | null> {
  const store = await cookies();
  const account = accountByToken(store.get(SESSION_COOKIE)?.value);
  if (!account) return unauthorizedResponse();
  if (account.permissions[permission] !== true) return forbiddenResponse();
  return null;
}