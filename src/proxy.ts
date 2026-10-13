/**
 * ============================================================================
 *  proxy.ts — the authentication + RBAC wall for BIOBRIDGE
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
 *  AUTHENTICATED:
 *    • every page      → 302 redirect to /login when no valid session
 *    • every admin API → 401 JSON (so polled panels fail fast, not with HTML)
 *
 *  RBAC (Phase 14):
 *    Each page route requires the signed-in account's Access_Level to grant
 *    the page's capability (Dashboard → can_view_dashboard, Settings →
 *    can_view_settings, My Portal → can_view_my_portal, …). A user who
 *    types /settings into the URL bar while holding a Worker level is
 *    redirected to a page they can read (My Portal / Dashboard) instead of
 *    being shown something they must not see. /api/* routes keep the
 *    session-only wall here; each handler re-checks its own capability via
 *    requirePermission() (defence in depth).
 *
 *  Bonus: an already-signed-in user visiting /login is bounced to their
 *  own landing page (dashboard for admins, My Portal for workers).
 */

import { NextResponse, type NextRequest } from "next/server";
import { accountByToken } from "@/lib/db";
import type { PermissionKey } from "@/lib/rbac";
import { SESSION_COOKIE } from "@/lib/session";

/** Endpoints reachable without a session (see policy above). */
const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/logout"]);
const PUBLIC_PREFIXES = [
  "/api/biometrics/push",
  // Phase 15 — hands-free mobile clocking ingress. The mobile app cannot hold
  // a session cookie, so the handler itself authenticates the shared
  // MOBILE_PUNCH_KEY (or a signed-in admin session). See the route header.
  "/api/attendance/geopunch",
];

/**
 * Page → capability mapping (longest prefixes first; "/" is the catch-all
 * dashboard). /api/* routes are intentionally absent — their handlers own
 * the per-capability checks so API consumers get precise 401/403 JSON.
 */
const ROUTE_PERMISSION: ReadonlyArray<readonly [string, PermissionKey]> = [
  ["/my-portal", "can_view_my_portal"],
  ["/employees", "can_view_employees"],
  ["/attendance-records", "can_view_attendance"],
  ["/shifts", "can_manage_shifts"],
  ["/reports", "can_view_reports"],
  ["/timesheets", "can_view_attendance"],
  ["/exceptions", "can_view_exceptions"],
  ["/whos-in", "can_view_whos_in"],
  ["/clocking-devices", "can_view_devices"],
  ["/terminals", "can_view_devices"],
  ["/sync", "can_view_sync"],
  ["/settings", "can_view_settings"],
  ["/", "can_view_dashboard"],
];

function routePermission(pathname: string): PermissionKey | null {
  if (pathname.startsWith("/api/")) return null;
  for (const [prefix, perm] of ROUTE_PERMISSION) {
    if (prefix === "/") return perm; // catch-all — always reached last
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return perm;
  }
  return null;
}

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Strict base-path matching: `nextUrl.pathname` never carries a query
  // string, so a `${p}?` branch would be dead code. Compare whole paths
  // (with an optional `/` sub-path) only.
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** A page the account can actually read — or null (= hard deny, never loops). */
function fallbackLanding(permissions: Record<string, boolean>): string | null {
  if (permissions.can_view_my_portal) return "/my-portal";
  if (permissions.can_view_dashboard) return "/";
  return null;
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const account = accountByToken(request.cookies.get(SESSION_COOKIE)?.value);

  // ── Already signed in? /login → their landing page ──────────────
  if (pathname === "/login") {
    if (account) {
      return NextResponse.redirect(new URL(account.home, request.url), 302);
    }
    return NextResponse.next();
  }

  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  // ── Unauthenticated: admin APIs answer 401 JSON, pages 302 to /login ──
  if (!account) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized — sign in at /login." },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.redirect(new URL("/login", request.url), 302);
  }

  // ── RBAC: server-side page protection (Phase 14 Objective 5) ──────
  const required = routePermission(pathname);
  if (required && account.permissions[required] !== true) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: "Insufficient permissions for this action." },
        { status: 403, headers: { "Cache-Control": "no-store" } }
      );
    }
    const landing = fallbackLanding(account.permissions);
    if (landing) {
      return NextResponse.redirect(new URL(landing, request.url), 302);
    }
    return new NextResponse("Insufficient permissions for this page.", { status: 403 });
  }

  return NextResponse.next();
}

export const config = {
  // Run on every route except build assets, images and favicons.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:png|jpg|jpeg|svg|webp|ico|css|js|map)$).*)",
  ],
};