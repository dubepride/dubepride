/**
 * ============================================================================
 *  mobile.ts — shared secrets for the companion-app ingress (Phase 15/16)
 * ============================================================================
 *
 *  The Expo companion app cannot hold a session cookie, so both mobile
 *  endpoints (/api/attendance/geopunch and /api/mobile/login) authenticate
 *  with a shared secret sent as `x-mobile-key` (an alias, `x-api-key`, is
 *  accepted for generic HTTP clients).
 *
 *  Admins keep the ability to hit the punch endpoint from a signed-in browser
 *  session, which is why `isMobileAuthorized()` is a union rather than a key
 *  check. The sign-in endpoint deliberately does NOT accept a session — it is
 *  a credential exchange, not a console action.
 *
 *  This module exists so the rule lives in exactly one place; it is imported
 *  by the geopunch handler and the new login handler.
 */

import type { NextRequest } from "next/server";
import { currentAccount } from "@/lib/auth";

/** Built-in shared secret; override in production with MOBILE_PUNCH_KEY. */
export const DEFAULT_MOBILE_KEY = "biobridge-mobile";

/** The secret the deployment currently expects. */
export function expectedMobileKey(): string {
  return process.env.MOBILE_PUNCH_KEY?.trim() || DEFAULT_MOBILE_KEY;
}

/** Strict comparison of the request's shared secret against the deployment's. */
export function hasValidMobileKey(request: NextRequest): boolean {
  const key = request.headers.get("x-mobile-key") ?? request.headers.get("x-api-key");
  return key !== null && key.length > 0 && key === expectedMobileKey();
}

/**
 * Authenticate a device ingress: a valid admin session OR the shared mobile
 * key. (Admins keep console-testing ability; the app can't hold a cookie.)
 */
export async function isMobileAuthorized(request: NextRequest): Promise<boolean> {
  if (hasValidMobileKey(request)) return true;
  const account = await currentAccount();
  return account !== null;
}
