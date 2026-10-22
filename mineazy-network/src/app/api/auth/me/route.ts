/**
 * ============================================================================
 *  GET /api/auth/me — who am I
 * ============================================================================
 *
 *  The console's client components ask this on boot to learn the signed-in
 *  account and the capabilities it has. It never returns a password hash.
 * ============================================================================
 */

import { currentAccount, fail, ok } from "@/lib/api";

export async function GET(): Promise<Response> {
  const account = await currentAccount();
  if (!account) return fail("No active session.", 401);
  return ok({
    user: {
      id: account.id,
      username: account.username,
      displayName: account.displayName,
      email: account.email,
      role: account.role,
      lastLoginAt: account.lastLoginAt,
      permissions: account.permissions,
    },
  });
}
