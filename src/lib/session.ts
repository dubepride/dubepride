/**
 * ============================================================================
 *  session.ts — stateless signed session cookies for the HR admin console
 * ============================================================================
 *
 *  Deliberately dependency-free (node:crypto only) and free of any
 *  `next/*` imports so it can be bundled into BOTH:
 *    • src/proxy.ts          — the auth wall that runs before rendering
 *    • /api/auth/* routes    — login/logout handlers
 *
 *  Token format:  base64url(JSON claims) "." base64url(HMAC-SHA256(claims))
 *
 *  Claims are integrity-protected (HMAC) and time-limited (exp), so a user
 *  cannot forge or extend a session without the server secret. The claims
 *  carry the System_Accounts id + display identity; the full permission
 *  matrix is resolved from the account's Access_Level on every request
 *  (server side), never trusted from the token.
 *
 *  CONFIG (.env):
 *    ADMIN_PASSWORD   — fallback admin password (default: admin)
 *    SESSION_SECRET   — HMAC key for cookies     (default: dev-only value)
 */

import crypto from "node:crypto";

/** Cookie carrying the signed session. HttpOnly — JS never sees it. */
export const SESSION_COOKIE = "biobridge_session";

/** Sessions live for a working day (+buffer), then force a fresh login. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/** Used only when ADMIN_PASSWORD is unset — see .env.example. */
export const DEFAULT_ADMIN_PASSWORD = "admin";

function masterPassword(): string {
  return process.env.ADMIN_PASSWORD ?? DEFAULT_ADMIN_PASSWORD;
}

function hmacKey(): Buffer {
  // Hashed so the raw secret never sits in HMAC key schedule as-is and so
  // key length is fixed regardless of what the operator provides.
  return crypto.createHash("sha256").update(process.env.SESSION_SECRET ?? "biobridge-dev-session-secret").digest();
}

/** Constant-time comparison of two digests (length-safe). */
function digestsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Constant-time check of the candidate master password. */
export function checkPassword(candidate: string): boolean {
  return digestsEqual(
    crypto.createHash("sha256").update(candidate).digest(),
    crypto.createHash("sha256").update(masterPassword()).digest()
  );
}

/** Build a fresh signed session token + its expiry (epoch ms). */
export function createSessionToken(account: {
  accountId: number;
  name: string;
  email: string;
  levelName: string;
}): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const claims = Buffer.from(
    JSON.stringify({
      sub: String(account.accountId),
      name: account.name,
      email: account.email,
      level: account.levelName,
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
export interface SessionClaims {
  /** System_Accounts.Account_ID as a string (the token's subject). */
  sub: string;
  name: string;
  email: string;
  level: string;
  exp: number;
}

export function verifySessionToken(token: string | null | undefined): SessionClaims | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const claims = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", hmacKey()).update(claims).digest("base64url");
  if (!digestsEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8"))) return null;

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
const g = globalThis as typeof globalThis & { __taLoginThrottle?: ThrottleState };

function throttle(): ThrottleState {
  if (!g.__taLoginThrottle) g.__taLoginThrottle = { failures: [] };
  const state = g.__taLoginThrottle;
  const cutoff = Date.now() - WINDOW_MS;
  state.failures = state.failures.filter((t) => t > cutoff);
  return state;
}

/** True when this process has seen too many recent failed logins. */
export function loginThrottled(): boolean {
  return throttle().failures.length >= MAX_FAILURES;
}

/** Record a failed attempt (called on every wrong password). */
export function registerLoginFailure(): void {
  throttle().failures.push(Date.now());
}

/** Successful login clears the lockout window. */
export function resetLoginThrottle(): void {
  g.__taLoginThrottle = { failures: [] };
}
