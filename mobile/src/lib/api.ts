/**
 * ============================================================================
 *  api.ts — the app's only door to the BIOBRIDGE bridge
 * ============================================================================
 *
 *  Two endpoints are used, both shared-secret ingress points on the server:
 *
 *    POST /api/mobile/login          Employee ID + PIN → identity + geofence
 *    POST /api/attendance/geopunch   the actual GPS punch
 *
 *  Failure taxonomy (this is what makes the offline queue correct):
 *
 *    NetworkError — the request never reached the bridge (no route, DNS,
 *                   connection refused, timeout, dropped mid-response).
 *                   → the punch MUST be queued.
 *    HttpError    — the bridge answered, and said no (401/403/409/…).
 *                   → never queue a policy verdict; show it to the employee.
 *    5xx          — the bridge is reachable but unhealthy.
 *                   → queue and retry: the punch is still valid.
 *
 *  Configuration comes from `app.json` → `extra` (see README), which keeps it
 *  typed and identical in Expo Go and in a native dev build. The login screen
 *  can also override the base URL at runtime, so pointing a phone at a new
 *  server never requires a rebuild.
 */

import Constants from "expo-constants";

import { enqueue, flushQueue, type FlushResult } from "./queue";
import type {
  GeoPunchPayload,
  GeoPunchResponse,
  MobileLoginResponse,
  MobileSession,
} from "./types";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/** Android emulator's alias for the host machine's localhost. */
export const DEFAULT_API_URL = "http://10.0.2.2:3000";
export const DEFAULT_MOBILE_KEY = "biobridge-mobile";

/** Requests are abandoned after this long so a background task can't hang. */
const REQUEST_TIMEOUT_MS = 20_000;

function extra(): Record<string, unknown> {
  return (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;
}

function extraString(key: string): string {
  const value = extra()[key];
  return typeof value === "string" ? value.trim() : "";
}

/** "192.168.1.42:3000" and "http://host:3000/" both normalise to a base URL. */
export function normaliseApiUrl(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  return withScheme.replace(/\/+$/, "");
}

export function configuredApiUrl(): string {
  return normaliseApiUrl(extraString("apiUrl")) || DEFAULT_API_URL;
}

export function configuredMobileKey(): string {
  return extraString("mobileKey") || DEFAULT_MOBILE_KEY;
}

/* ------------------------------------------------------------------ */
/* Errors                                                             */
/* ------------------------------------------------------------------ */

/** The request never reached the bridge — queue, don't discard. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

/** The bridge answered and refused — a verdict, not a transport fault. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* Transport                                                          */
/* ------------------------------------------------------------------ */

interface JsonResponse<T> {
  status: number;
  ok: boolean;
  body: T | null;
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<JsonResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // fetch() only rejects on transport-level failure — precisely the case the
    // offline queue exists for.
    throw new NetworkError(err instanceof Error ? err.message : "Network request failed");
  } finally {
    clearTimeout(timer);
  }

  let text = "";
  try {
    text = await response.text();
  } catch {
    // Connection dropped after headers — still a transport failure.
    throw new NetworkError("Connection lost while reading the response");
  }

  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  return { status: response.status, ok: response.ok, body: body as T | null };
}

/* ------------------------------------------------------------------ */
/* POST /api/mobile/login                                             */
/* ------------------------------------------------------------------ */

export interface LoginInput {
  employeeId: string;
  pin: string;
  apiUrl: string;
  mobileKey: string;
}

/**
 * Exchange Employee ID + PIN for a verified identity and the sites it may
 * clock in at (Phase 17: every registered site, not just the home branch).
 * Throws NetworkError (offline) or HttpError (rejected) — never returns ok:false.
 */
export async function login(input: LoginInput): Promise<MobileLoginResponse> {
  const result = await requestJson<MobileLoginResponse>(
    `${input.apiUrl}/api/mobile/login`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-mobile-key": input.mobileKey,
      },
      body: JSON.stringify({ employeeId: input.employeeId, pin: input.pin }),
    }
  );

  if (!result.ok || !result.body?.ok) {
    throw new HttpError(result.status, result.body?.error ?? "Sign-in failed.");
  }
  return result.body;
}

/* ------------------------------------------------------------------ */
/* POST /api/attendance/geopunch                                      */
/* ------------------------------------------------------------------ */

/** The transport identity needed for a punch — a session satisfies it. */
export type PunchTarget = Pick<MobileSession, "apiUrl" | "mobileKey">;

/**
 * Send one GPS punch.
 *
 * Returns the bridge's verdict (including `ok:false` policy answers such as
 * OUTSIDE_GEOFENCE, which are meaningful results — the attempt is recorded as
 * an exception bridge-side). Throws NetworkError / HttpError for the cases
 * where nothing was decided.
 */
export async function postGeoPunch(
  target: PunchTarget,
  payload: GeoPunchPayload
): Promise<GeoPunchResponse> {
  const result = await requestJson<GeoPunchResponse>(
    `${target.apiUrl}/api/attendance/geopunch`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-mobile-key": target.mobileKey,
      },
      body: JSON.stringify({
        employeeRef: payload.employeeRef,
        latitude: payload.latitude,
        longitude: payload.longitude,
        accuracyMeters: payload.accuracyMeters ?? null,
        branchRef: payload.branchRef ?? null,
        timestamp: payload.timestamp,
        // `direction` is intentionally omitted: the bridge infers IN/OUT from
        // the employee's punch sequence, which a hands-free punch cannot know.
      }),
    }
  );

  // 401 = our shared key is wrong; 5xx = the bridge itself is unwell. Neither
  // is a punch verdict, so neither is returned as one.
  if (result.status === 401) {
    throw new HttpError(401, result.body?.error ?? "Unauthorized — check the mobile key.");
  }
  if (result.status >= 500) {
    throw new HttpError(result.status, result.body?.error ?? "Bridge error.");
  }

  // Every other outcome is a real verdict, ok or not (see GeoPunchReason).
  if (result.body && typeof result.body === "object" && "reason" in result.body) {
    return result.body;
  }
  throw new HttpError(result.status, "Unexpected response from the bridge.");
}

/* ------------------------------------------------------------------ */
/* Dispatch + flush                                                   */
/* ------------------------------------------------------------------ */

export interface PunchDispatch {
  /** True when the punch is sitting in the offline queue instead of the DB. */
  queued: boolean;
  response: GeoPunchResponse | null;
  message: string;
}

/**
 * The one call the background task and the manual button both use: deliver the
 * punch, or park it safely. Only genuine transport/unavailability failures
 * queue — a policy rejection is surfaced immediately.
 */
export async function sendOrQueue(
  target: PunchTarget,
  payload: GeoPunchPayload
): Promise<PunchDispatch> {
  try {
    const response = await postGeoPunch(target, payload);
    return { queued: false, response, message: response.message };
  } catch (err) {
    if (err instanceof NetworkError) {
      await enqueue(payload, err.message);
      return { queued: true, response: null, message: "No network — punch queued on the device." };
    }
    if (err instanceof HttpError) {
      if (err.status >= 500) {
        await enqueue(payload, err.message);
        return {
          queued: true,
          response: null,
          message: "Bridge unavailable — punch queued on the device.",
        };
      }
      if (err.status === 401) {
        await enqueue(payload, err.message);
        return {
          queued: true,
          response: null,
          message: "Bridge rejected the mobile key — punch queued for an admin to fix.",
        };
      }
      throw err;
    }
    throw err;
  }
}

/** Replay everything the device is holding, oldest first. */
export async function flushOfflineQueue(target: PunchTarget): Promise<FlushResult> {
  return flushQueue((payload) => postGeoPunch(target, payload));
}
