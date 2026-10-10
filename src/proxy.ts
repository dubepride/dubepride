/**
 * ============================================================================
 *  proxy.ts — the authentication wall for the entire BIOBRIDGE console
 * ============================================================================
 *
 *  NOTE: In Next.js 16 `middleware.ts` is deprecated and renamed to
 *  `proxy.ts` (Node.js runtime by default) — this file replaces it and
 *  runs BEFORE any route is rendered.
 *
 *  Policy
 *  ──────
 *  PUBLIC (no session required):
 *    • /login                      — the sign-in page itself
 *    • POST /api/auth/login        — submitting credentials
 *    • POST /api/auth/logout       — clearing the cookie must always work
 *    • /api/biometrics/push        — hardware ADMS ingress; fingerprint
 *                                    terminals cannot hold a session cookie
 *    • static assets               — _next/*, images, favicons (via matcher)
 *
 *  PROTECTED (valid signed session cookie required):
 *    • every page      → 302 redirect to /login
 *    • every admin API → 401 JSON (so polled panels fail fast, not with HTML)
 *
 *  Bonus: an already-signed-in user visiting /login is bounced to the
 *  dashboard (mirrors the "logged in → never see the login screen" flow).
 */

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

/** Endpoints reachable without a session (see policy above). */
const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/logout"]);
const PUBLIC_PREFIXES = ["/api/biometrics/push"];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Strict base-path matching: `nextUrl.pathname` never carries a query
  // string, so a `${p}?` branch would be dead code. Compare whole paths
  // (with an optional `/` sub-path) only.
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const authenticated = verifySessionToken(
    request.cookies.get(SESSION_COOKIE)?.value
  );

  // ── Already signed in? /login → dashboard ─────────────────────────
  if (pathname === "/login") {
    if (authenticated) {
      return NextResponse.redirect(new URL("/", request.url), 302);
    }
    return NextResponse.next();
  }

  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  // ── Admin APIs answer 401 JSON (never an HTML redirect) ───────────
  if (!authenticated) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized — sign in at /login." },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }
    // ── Pages: standard 302 Found back to the login screen ──────────
    return NextResponse.redirect(new URL("/login", request.url), 302);
  }

  return NextResponse.next();
}

export const config = {
  // Run on every route except build assets, images and favicons.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:png|jpg|jpeg|svg|webp|ico|css|js|map)$).*)",
  ],
};
