/**
 * ============================================================================
 *  POST /api/auth/login — HR master-password sign-in (Objective 1)
 * ============================================================================
 *
 *  Body: { "password": "…" }
 *
 *  200 → sets the signed HttpOnly session cookie, client redirects to
 *        /?welcome=1 (the dashboard shows the "Welcome back, Admin" toast)
 *  401 → wrong password
 *  429 → brute-force throttle (8 failures / 10 min in this process)
 *
 *  CONNECTING REAL HR DIRECTORY: replace checkPassword() in
 *  src/lib/session.ts with your IdP / LDAP verification and issue the same
 *  signed cookie from createSessionToken().
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  checkPassword,
  createSessionToken,
  loginThrottled,
  registerLoginFailure,
  resetLoginThrottle,
} from "@/lib/session";

export async function POST(request: NextRequest): Promise<Response> {
  if (loginThrottled()) {
    return Response.json(
      { ok: false, error: "Too many failed attempts — try again in 10 minutes." },
      { status: 429, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Parse the JSON body defensively (malformed input → 401, not a crash).
  let password = "";
  try {
    const body = (await request.json()) as { password?: unknown };
    password = typeof body?.password === "string" ? body.password : "";
  } catch {
    password = "";
  }

  if (password === "" || !checkPassword(password)) {
    registerLoginFailure();
    return Response.json(
      { ok: false, error: "Incorrect master password." },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  resetLoginThrottle();
  const { token, expiresAt } = createSessionToken();

  const response = NextResponse.json(
    { ok: true, message: "Welcome back, Admin" },
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
