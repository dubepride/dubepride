/**
 * ============================================================================
 *  proxy.ts — the authentication wall
 * ============================================================================
 *
 *  Next.js 16 calls this file "proxy" (it was "middleware" before). It runs
 *  before every request and decides whether the caller may see the page.
 *
 *  WHAT THIS DOES
 *    • Redirects anonymous browsers to /login.
 *    • Keeps the sign-in and sign-out endpoints reachable.
 *
 *  WHAT THIS DOES NOT DO
 *    • It is NOT the authorisation boundary. Every API route re-checks the
 *      caller's permissions server-side (see lib/api.ts). Hiding a button in
 *      the UI is a courtesy; the handler is the gate.
 *
 *  The proxy deliberately does only cheap work: it verifies the HMAC of the
 *  session cookie without touching the database.
 * ============================================================================
 */

import { NextResponse, type NextRequest } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "./lib/session";

/** Paths that never require a session. */
const PUBLIC_PATHS = new Set([
  "/login",
  "/setup",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/me",
  "/api/health",
]);

/** Page → the capability that page needs. */
const PAGE_PERMISSIONS: { prefix: string; permission: string }[] = [
  { prefix: "/traffic", permission: "can_view_traffic" },
  { prefix: "/reports", permission: "can_view_reports" },
  { prefix: "/events", permission: "can_view_reports" },
  { prefix: "/settings", permission: "can_config_monitoring" },
  { prefix: "/discovery", permission: "can_run_discovery" },
];

/** The role → permission map, duplicated here on purpose. */
const ROLE_PERMISSIONS: Record<string, string[]> = {
  administrator: [
    "can_view_topology",
    "can_view_traffic",
    "can_view_reports",
    "can_manage_incidents",
    "can_edit_inventory",
    "can_run_discovery",
    "can_config_monitoring",
    "can_manage_credentials",
    "can_manage_users",
    "can_export_data",
  ],
  operator: [
    "can_view_topology",
    "can_view_traffic",
    "can_view_reports",
    "can_manage_incidents",
    "can_edit_inventory",
    "can_run_discovery",
    "can_export_data",
  ],
  viewer: ["can_view_topology", "can_view_traffic", "can_view_reports"],
};

const NO_AUTH = process.env.MINEAZY_NO_AUTH === "1" || process.env.MINEAZY_NO_AUTH === "true";

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (NO_AUTH) {
    return NextResponse.next();
  }

  if (
    PUBLIC_PATHS.has(pathname) ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const claims = verifySessionToken(token);

  if (!claims) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: "Sign in to use this endpoint." },
        { status: 401 }
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Page-level capability check (a courtesy — the API checks again).
  for (const rule of PAGE_PERMISSIONS) {
    if (!pathname.startsWith(rule.prefix)) continue;
    const granted = ROLE_PERMISSIONS[claims.role] ?? ROLE_PERMISSIONS.viewer;
    if (!granted.includes(rule.permission)) {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      url.searchParams.set("denied", rule.permission);
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Everything except the Next.js internals and anything with a file
     * extension (static assets).
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)",
  ],
};
