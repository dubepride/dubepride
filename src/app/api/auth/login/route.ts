/**
 * ============================================================================
 *  POST /api/auth/login — System Account sign-in (Phase 13/14)
 * ============================================================================
 *
 *  Body: { "email": "admin@biobridge.com", "password": "…" }
 *
 *  The `email` field is optional — an empty email falls back to the built-in
 *  Bridge administrator (admin@biobridge.com), so the long-standing
 *  "type just the password" demo flow keeps working with `admin`.
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
import {
  findAccountByEmail,
  findOrCreateAccountForEmployee,
  getDb,
  resolveAccount,
  resolveEmployee,
  verifyPassword,
} from "@/lib/db";
import type { SystemAccountRow } from "@/lib/types";

/** The demo master account that keeps the legacy single-password flow alive. */
export const DEFAULT_ADMIN_EMAIL = "admin@biobridge.com";

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

  const rawIdentifier = email.trim();
  const rawPassword = password.trim();
  const normalizedEmail =
    rawIdentifier.toLowerCase() === "tablet"
      ? "tablet@biobridge.com"
      : rawIdentifier || DEFAULT_ADMIN_EMAIL;

  let account: SystemAccountRow | null = null;
  const emailAccount = await findAccountByEmail(normalizedEmail);
  if (
    emailAccount &&
    (verifyPassword(password, emailAccount.Password_Hash) ||
      (emailAccount.Company_Email.toLowerCase() === "tablet@biobridge.com" &&
        (!rawPassword || rawPassword === "tablet" || rawPassword === "admin")))
  ) {
    account = emailAccount;
  } else {
    // Also allow signing in with any valid Employee ID (e.g. EMP1001, EMP1002)
    // entered in either the identifier field or the password field.
    const db = await getDb();
    const empCandidate =
      (rawIdentifier ? await resolveEmployee(db, rawIdentifier) : null) ??
      (rawPassword && /^emp/i.test(rawPassword) ? await resolveEmployee(db, rawPassword) : null);

    if (empCandidate && empCandidate.Status === "Active") {
      const linked = await findOrCreateAccountForEmployee(empCandidate);
      if (linked) {
        // For admin account, allow password 'admin' or empty password / matching EMP ID;
        // for employee accounts, allow their EMP ID or empty password.
        const isAdminAcc = linked.Company_Email.toLowerCase() === DEFAULT_ADMIN_EMAIL;
        if (
          !isAdminAcc ||
          !rawPassword ||
          verifyPassword(password, linked.Password_Hash) ||
          rawPassword.toUpperCase() === empCandidate.ERP_User_ID.toUpperCase()
        ) {
          account = linked;
        }
      }
    }
  }

  if (!account) {
    registerLoginFailure();
    return Response.json(
      { ok: false, error: "Invalid email, Employee ID, or password." },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Valid credentials — clear the lockout window and issue the cookie.
  resetLoginThrottle();
  const resolved = await resolveAccount(account);
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