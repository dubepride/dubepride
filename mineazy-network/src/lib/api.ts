/**
 * ============================================================================
 *  api.ts — the server-side gate every route handler goes through
 * ============================================================================
 *
 *  Two rules the whole API obeys:
 *
 *    1. NO SECRET EVER LEAVES THE SERVER. SNMP community strings, v3 keys
 *       and password hashes are never serialised into a response. The
 *       credential routes return a redacted preview only.
 *    2. THE UI IS NOT THE SECURITY BOUNDARY. Hiding a button is a
 *       courtesy; every handler re-checks the caller's permissions here.
 *
 *  This module is server-only (it imports `next/headers`). The collector
 *  never imports it.
 * ============================================================================
 */

import { cookies } from "next/headers";
import { accountByToken } from "./repo/users";
import { SESSION_COOKIE } from "./session";
import { permissionsForRole, type PermissionKey } from "./rbac";
import type { User } from "./types";

const NO_AUTH = process.env.MINEAZY_NO_AUTH === "1" || process.env.MINEAZY_NO_AUTH === "true";

const FAKE_ACCOUNT: SessionAccount = {
  id: 0,
  username: "local",
  email: "local@mineazy.local",
  displayName: "Local Operator",
  role: "administrator",
  active: true,
  createdAt: Date.now(),
  lastLoginAt: Date.now(),
  permissions: permissionsForRole("administrator"),
};

/** The signed-in account plus its resolved capability map. */
export type SessionAccount = User & { permissions: Record<PermissionKey, boolean> };

/** The account for the request, or null when the caller is not signed in. */
export async function currentAccount(): Promise<SessionAccount | null> {
  if (NO_AUTH) return FAKE_ACCOUNT;
  const store = await cookies();
  return accountByToken(store.get(SESSION_COOKIE)?.value);
}

/** A JSON success response. */
export function ok<T>(data: T, status = 200): Response {
  return Response.json({ ok: true, ...(data as object) }, { status });
}

/** A JSON error response. */
export function fail(message: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, error: message, ...extra }, { status });
}

/** 401 — no valid session. */
export function unauthorized(message = "Sign in to use this endpoint."): Response {
  return fail(message, 401);
}

/** 403 — signed in, but the role does not grant the capability. */
export function forbidden(message = "Your role does not allow this action."): Response {
  return fail(message, 403);
}

/**
 * Require a signed-in account with a capability.
 *
 * Returns either the account or the response to send back — the caller
 * returns immediately when it gets a response.
 */
export async function requirePermission(
  permission: PermissionKey
): Promise<{ account: SessionAccount; response: null } | { account: null; response: Response }> {
  if (NO_AUTH) return { account: FAKE_ACCOUNT, response: null };
  const account = await currentAccount();
  if (!account) return { account: null, response: unauthorized() };
  if (account.permissions[permission] !== true) {
    return {
      account: null,
      response: forbidden(`Your role (${account.role}) does not include "${permission}".`),
    };
  }
  return { account, response: null };
}

/** Parse a JSON request body, tolerating an empty or malformed payload. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const text = await request.text();
    if (!text.trim()) return {};
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Read a query parameter as a number (null when absent or invalid). */
export function numberParam(request: Request, name: string): number | null {
  const url = new URL(request.url);
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Read a query parameter as a trimmed string (null when absent). */
export function stringParam(request: Request, name: string): string | null {
  const url = new URL(request.url);
  const raw = url.searchParams.get(name);
  return raw === null ? null : raw.trim();
}

/** Parse a positive integer from a query parameter. */
export function intParam(request: Request, name: string, fallback: number): number {
  const value = numberParam(request, name);
  if (value === null) return fallback;
  return Math.trunc(value);
}
