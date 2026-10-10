/**
 * ============================================================================
 *  POST /api/auth/login — System Account sign-in (Phase 13/14)
 * ============================================================================
 *
 *  Body: { "email": "admin@biobridge.example", "password": "…" }
 *
 *  The `email` field is optional — an empty email falls back to the built-in
 *  Bridge administrator (admin@biobridge.example), so the long-standing
 *  "type just the password" demo flow keeps working with `biobridge-admin`.
 *
 *  200 → sets the signed HttpOnly session cookie and returns the account's
 *        landing page (`home`) — the client redirects there.
 *  401 → unknown account or wrong password
 *  429 → brute-force throttle (8 failures / 10 min in this process)
 *
 *  The session token only carries an id + display identity; the permission
 *  matrix is resolved from the account's Access_Level on every request so a
 *  matrix edit by the IT admin takes effect immediately (no re-login).
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  createSessionToken,
  loginThrottled,
  registerLoginFailure,
  resetLoginThrottle,
  SESSION_COOKIE,
} from "@/lib/session";
import { findAccountByEmail, resolveAccount, verifyPassword } from "@/lib/db";

/** The demo master account that keeps the legacy single-password flow alive. */
export const DEFAULT_ADMIN_EMAIL = "admin@biobridge.example";

export async function POST(request: NextRequest): Promise<Response> {
  if (loginThrottled()) {
    return Response.json(
      { ok: false, error: "Too many failed attempts — try again in 10 minutes." },
      { status: 429, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Parse the JSON body defensively (malformed input → 401, not a crash).
  let email = "";
  let password = "";
  try {
    const body = (await request.json()) as { email?: unknown; password?: unknown };
    email = typeof body?.email === "string" ? body.email : "";
    password = typeof body?.password === "string" ? body.password : "";
  } catch {
    email = "";
    password = "";
  }

  const account = findAccountByEmail((email && email.trim()) || DEFAULT_ADMIN_EMAIL);
  if (!account || !verifyPassword(password, account.Password_Hash)) {
    registerLoginFailure();
    return Response.json(
      { ok: false, error: "Invalid email or password." },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Valid credentials — clear the lockout window and issue the cookie.
  resetLoginThrottle();
  const resolved = resolveAccount(account);
  const { token, expiresAt } = createSessionToken({
    accountId: resolved.accountId,
    name: resolved.name,
    email: resolved.email,
    levelName: resolved.levelName,
  });

  const response = NextResponse.json(
    {
      ok: true,
      message: `Welcome back, ${resolved.firstName}`,
      home: `${resolved.home}?welcome=1`,
      account: {
        name: resolved.name,
        email: resolved.email,
        levelName: resolved.levelName,
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, // never readable from JS — XSS cannot steal the session
    sameSite: "lax", // sent on top-level navigations, blocked on cross-site POSTs
    // Secure only when the bridge is actually served over HTTPS; local
    // http://localhost demos would otherwise reject the cookie.
    secure: request.nextUrl.protocol === "https:",
    path: "/",
    expires: new Date(expiresAt),
  });
  return response;
}