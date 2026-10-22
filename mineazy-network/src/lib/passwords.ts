/**
 * ============================================================================
 *  passwords.ts — password hashing for console accounts
 * ============================================================================
 *
 *  scrypt (node:crypto) with a per-user random salt. The stored digest is
 *  self-describing so parameters can be raised later without invalidating
 *  existing accounts:
 *
 *      scrypt$<N>$<r>$<p>$<salt-hex>$<hash-hex>
 *
 *  Verification is constant-time (crypto.timingSafeEqual) and never throws:
 *  a malformed stored hash simply fails to verify.
 */

import crypto from "node:crypto";

/** scrypt cost parameters (N=16384, r=8, p=1 ≈ 16 MiB, ~50 ms on a modern CPU). */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

/** Hash a plaintext password into a self-describing digest string. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = crypto.scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/** Verify a plaintext password against a stored digest. Never throws. */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], "hex");
    const expected = Buffer.from(parts[5], "hex");
    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = crypto.scryptSync(password, salt, expected.length, { N: n, r, p });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** A random, URL-safe password for one-time bootstrap accounts. */
export function randomPassword(bytes = 12): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/**
 * Compare two secrets in constant time (used for the session HMAC and for
 * the collector lock token).
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
