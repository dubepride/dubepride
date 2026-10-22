/**
 * ============================================================================
 *  POST /api/auth/login — sign in
 * ============================================================================
 *
 *  Successful login sets an HttpOnly, SameSite=Strict session cookie. The
 *  token is signed with HMAC-SHA256 and expires after 12 hours; the account
 *  is resolved from the database on every request, so a role change takes
 *  effect immediately rather than when the cookie expires.
 *
 *  Repeated failures are throttled (8 attempts per 10 minutes per process).
 * ============================================================================
 */

import { authenticate } from "@/lib/repo/users";
import { recordAudit } from "@/lib/repo/audit";
import { recordEvent } from "@/lib/repo/events";
import {
  createSessionToken,
  loginThrottled,
  registerLoginFailure,
  resetLoginThrottle,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "@/lib/session";
import { fail, ok, readJson } from "@/lib/api";

export async function POST(request: Request): Promise<Response> {
  if (loginThrottled()) {
    return fail(
      "Too many failed sign-in attempts. Wait a few minutes and try again.",
      429
    );
  }

  const body = await readJson(request);
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!username || !password) {
    return fail("A username and a password are required.");
  }

  const account = await authenticate(username, password);
  if (!account) {
    registerLoginFailure();
    await recordEvent({
      type: "config_changed",
      severity: "info",
      title: "Failed sign-in attempt",
      detail: `An unsuccessful sign-in was made for the username "${username}".`,
      subjectType: "system",
      subjectId: null,
      source: "auth",
    });
    return fail("That username and password combination was not recognised.", 401);
  }

  resetLoginThrottle();
  const { token, expiresAt } = createSessionToken({
    accountId: account.id,
    name: account.username,
    email: account.email,
    role: account.role,
  });

  await recordAudit({
    userId: account.id,
    userName: account.username,
    action: "sign_in",
    entity: "session",
    entityId: account.id,
    note: "Signed in to the console.",
  });

  const response = ok({
    user: {
      id: account.id,
      username: account.username,
      displayName: account.displayName,
      email: account.email,
      role: account.role,
      permissions: account.permissions,
    },
    expiresAt,
  });

  response.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
  return response;
}
