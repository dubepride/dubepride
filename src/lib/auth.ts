/**
 * ============================================================================
 *  auth.ts — server-side authorization glue for API route handlers
 * ============================================================================
 *
 *  Defense in depth: src/proxy.ts already rejects unauthenticated traffic
 *  before it reaches a route, but every admin handler re-verifies the
 *  session close to the data ("never trust the client for authorization").
 *
 *  Hardware endpoints (/api/biometrics/push) intentionally do NOT use this
 *  guard — fingerprint terminals cannot log in; device trust is network
 *  placement + the shared push URL instead.
 */

import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export { SESSION_COOKIE, createSessionToken } from "@/lib/session";

/** Canonical 401 body for admin APIs. */
export function unauthorizedResponse(): Response {
  return Response.json(
    { ok: false, error: "Unauthorized — sign in at /login." },
    { status: 401, headers: { "Cache-Control": "no-store" } }
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
