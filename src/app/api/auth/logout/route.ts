/**
 * POST /api/auth/logout — clears the session cookie.
 * Always succeeds (even with no session) so the client can redirect to
 * /login unconditionally.
 *
 * The cookie is cleared with the exact same attributes used when it was
 * set by POST /api/auth/login — including the conditional `secure` flag
 * (`https:` → secure) — so the browser treats this as an overwrite of the
 * same cookie instead of leaving a lingering session behind.
 */

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

export async function POST(request: NextRequest): Promise<Response> {
  const response = NextResponse.json(
    { ok: true, message: "Signed out." },
    { headers: { "Cache-Control": "no-store" } }
  );
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:", // mirrors the login cookie
    path: "/",
    expires: new Date(0), // immediate expiry = delete
  });
  return response;
}
