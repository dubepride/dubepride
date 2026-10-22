/**
 * ============================================================================
 *  session.ts — stateless signed session cookies
 * ============================================================================
 *
 *  Dependency-free (node:crypto only) and free of any `next/*` import so it
 *  can be bundled into the proxy (the auth wall), the API routes and the
 *  standalone collector.
 *
 *  Token format: base64url(claims) "." base64url(HMAC-SHA256(claims))
 *
 *  The claims are integrity protected and time limited. The role in the
 *  token is only a hint for the UI — every authorisation decision resolves
 *  the account from the database first, so a demoted user loses access
 *  immediately rather than when their cookie expires.
 *
 *  CONFIG (.env):
 *    MINEAZY_SESSION_SECRET — HMAC key for cookies
 */

import crypto from "node:crypto";
import { safeEqual } from "./passwords";

/** Cookie carrying the signed session. HttpOnly — JavaScript never sees it. */
export const SESSION_COOKIE = "mineazy_session";

/** Sessions live for 12 hours, then force a fresh sign-in. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function hmacKey(): Buffer {
  const secret = process.env.MINEAZY_SESSION_SECRET ?? "mineazy-dev-session-secret-change-me";
  return crypto.createHash("sha256").update(secret).digest();
}

export interface SessionClaims {
  /** Users.User_ID as a string (the token subject). */
  sub: string;
  name: string;
  email: string;
  role: string;
  exp: number;
}

/** Build a fresh signed session token + its expiry (epoch ms). */
export function createSessionToken(account: {
  accountId: number;
  name: string;
  email: string;
  role: string;
}): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const claims = Buffer.from(
    JSON.stringify({
      sub: String(account.accountId),
      name: account.name,
      email: account.email,
      role: account.role,
      exp: expiresAt,
    }),
    "utf8"
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", hmacKey()).update(claims).digest("base64url");
  return { token: `${claims}.${sig}`, expiresAt };
}

/**
 * Verify signature + expiry. Returns the parsed claims, or null for
 * missing/malformed/forged/expired tokens — never throws.
 */
export function verifySessionToken(token: string | null | undefined): SessionClaims | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const claims = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", hmacKey()).update(claims).digest("base64url");
  if (!safeEqual(sig, expected)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as Partial<SessionClaims>;
    if (typeof parsed.exp !== "number" || parsed.exp <= Date.now()) return null;
    if (typeof parsed.sub !== "string" || parsed.sub === "") return null;
    return parsed as SessionClaims;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Login brute-force throttle                                          */
/* ------------------------------------------------------------------ */

const WINDOW_MS = 10 * 60 * 1000; // 10-minute observation window
const MAX_FAILURES = 8; // locked out after 8 failed attempts

type ThrottleState = { failures: number[] };
const g = globalThis as typeof globalThis & { __mineazyLoginThrottle?: ThrottleState };

function throttle(): ThrottleState {
  if (!g.__mineazyLoginThrottle) g.__mineazyLoginThrottle = { failures: [] };
  const state = g.__mineazyLoginThrottle;
  const cutoff = Date.now() - WINDOW_MS;
  state.failures = state.failures.filter((t) => t > cutoff);
  return state;
}

/** True when this process has seen too many recent failed logins. */
export function loginThrottled(): boolean {
  return throttle().failures.length >= MAX_FAILURES;
}

/** Record a failed attempt. */
export function registerLoginFailure(): void {
  throttle().failures.push(Date.now());
}

/** A successful login clears the lockout window. */
export function resetLoginThrottle(): void {
  g.__mineazyLoginThrottle = { failures: [] };
}
