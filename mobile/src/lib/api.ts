/**
 * ============================================================================
 *  api.ts — the app's door to the BioBridge server
 * ============================================================================
 *
 *  Endpoints used:
 *    POST /api/mobile/login          Employee Number → identity + geofences
 *    GET  /api/mobile/geofences      Live sync of geofences, radii & employee profile
 *    POST /api/attendance/geopunch   The manual GPS punch & offline auto-sync
 */

import Constants from "expo-constants";

import { getDeviceIdentity } from "./device";
import { enqueue, flushQueue, type FlushResult } from "./queue";
import type {
  GeoFenceSite,
  GeoPunchPayload,
  GeoPunchResponse,
  GeofenceConfig,
  MobileDayStatus,
  MobileEmployee,
  MobileLoginResponse,
  MobileSession,
  PresencePayload,
} from "./types";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/** Default live bridge URL. */
export const DEFAULT_API_URL = "https://dubepride.vercel.app";
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

export function configuredHandsFree(): boolean {
  return extra()["handsFree"] === true;
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
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  attempts: number = 3
): Promise<JsonResponse<T>> {
  let response: Response | null = null;
  let lastNetErr: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
      lastNetErr = null;
      break;
    } catch (err) {
      lastNetErr = err;
      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  if (!response) {
    throw new NetworkError(
      lastNetErr instanceof Error ? lastNetErr.message : "Network request failed"
    );
  }

  let text = "";
  try {
    text = await response.text();
  } catch {
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
  employeeNumber?: string;
  employeeId?: string;
  pin?: string;
  deviceId?: string;
  deviceName?: string;
  apiUrl: string;
  mobileKey: string;
}

/**
 * Exchange Employee ID / Number + Hardware Device ID for a verified identity
 * and all active site geofences.
 */
export async function login(input: LoginInput): Promise<MobileLoginResponse> {
  const empRef = (input.employeeNumber ?? input.employeeId ?? "").trim();
  const hw = await getDeviceIdentity();
  const deviceId = (input.deviceId ?? hw.deviceId).trim();
  const deviceName = (input.deviceName ?? hw.deviceName).trim();

  const result = await requestJson<MobileLoginResponse>(
    `${input.apiUrl}/api/mobile/login`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-mobile-key": input.mobileKey,
        "x-device-id": deviceId,
        "x-device-name": deviceName,
      },
      body: JSON.stringify({
        employeeNumber: empRef,
        employeeId: empRef,
        deviceId,
        deviceName,
        pin: input.pin && input.pin.trim() ? input.pin.trim() : undefined,
      }),
    }
  );

  if (!result.ok || !result.body?.ok) {
    throw new HttpError(result.status, result.body?.error ?? "Sign-in failed.");
  }
  return result.body;
}

/**
 * Query the latest geofence configurations, employee profile, and day status
 * from the server so that any edits (such as resized radius, moved pin,
 * clocking method change, or employee/branch edit) reflect live on the mobile app.
 */
export async function fetchMobileFences(
  target: PunchTarget,
  opts?: { employeeId?: number; employeeRef?: string } | string
): Promise<{
  fences: GeoFenceSite[];
  geofence: GeofenceConfig | null;
  employee: MobileEmployee | null;
  dayStatus: MobileDayStatus | null;
}> {
  const params = new URLSearchParams();
  if (typeof opts === "string") {
    if (opts.trim()) params.set("employeeRef", opts.trim());
  } else if (opts) {
    if (typeof opts.employeeId === "number" && opts.employeeId > 0) {
      params.set("employeeId", String(opts.employeeId));
    }
    if (opts.employeeRef?.trim()) {
      params.set("employeeRef", opts.employeeRef.trim());
    }
  }
  params.set("_t", String(Date.now()));
  const query = `?${params.toString()}`;

  const result = await requestJson<{
    ok: boolean;
    fences?: GeoFenceSite[];
    sites?: GeoFenceSite[];
    geofence?: GeofenceConfig | null;
    employee?: MobileEmployee | null;
    dayStatus?: MobileDayStatus | null;
  }>(`${target.apiUrl}/api/mobile/geofences${query}`, {
    method: "GET",
    headers: {
      "x-mobile-key": target.mobileKey,
      "Cache-Control": "no-cache",
    },
  });

  if (result.ok && result.body && (Array.isArray(result.body.fences) || Array.isArray(result.body.sites))) {
    return {
      fences: result.body.fences ?? result.body.sites ?? [],
      geofence: result.body.geofence ?? null,
      employee: result.body.employee ?? null,
      dayStatus: result.body.dayStatus ?? null,
    };
  }

  // Fallback to /api/attendance/geofences
  const fallback = await requestJson<{ ok: boolean; sites: GeoFenceSite[] }>(
    `${target.apiUrl}/api/attendance/geofences?_t=${Date.now()}`,
    {
      method: "GET",
      headers: {
        "x-mobile-key": target.mobileKey,
        "Cache-Control": "no-cache",
      },
    }
  );
  if (fallback.ok && Array.isArray(fallback.body?.sites)) {
    return {
      fences: fallback.body.sites,
      geofence: null,
      employee: null,
      dayStatus: null,
    };
  }

  throw new HttpError(result.status, "Could not fetch updated geofences.");
}

/* ------------------------------------------------------------------ */
/* POST /api/attendance/geopunch                                      */
/* ------------------------------------------------------------------ */

export type PunchTarget = Pick<MobileSession, "apiUrl" | "mobileKey">;

export async function postGeoPunch(
  target: PunchTarget,
  payload: GeoPunchPayload
): Promise<GeoPunchResponse> {
  const hw = await getDeviceIdentity();
  const deviceId = (payload.deviceId ?? hw.deviceId).trim();
  const deviceName = (payload.deviceName ?? hw.deviceName).trim();

  const result = await requestJson<GeoPunchResponse>(
    `${target.apiUrl}/api/attendance/geopunch`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-mobile-key": target.mobileKey,
        "x-device-id": deviceId,
        "x-device-name": deviceName,
      },
      body: JSON.stringify({
        employeeRef: payload.employeeRef,
        latitude: payload.latitude,
        longitude: payload.longitude,
        accuracyMeters: payload.accuracyMeters ?? null,
        branchRef: payload.branchRef ?? null,
        deviceId,
        deviceName,
        timestamp: payload.timestamp,
      }),
    }
  );

  if (result.status === 401) {
    throw new HttpError(401, result.body?.error ?? "Unauthorized — check the mobile key.");
  }
  if (result.status >= 500) {
    throw new HttpError(result.status, result.body?.error ?? "Bridge error.");
  }

  if (result.body && typeof result.body === "object" && "reason" in result.body) {
    return result.body;
  }
  throw new HttpError(result.status, "Unexpected response from the bridge.");
}

/* ------------------------------------------------------------------ */
/* POST/DELETE /api/mobile/presence — Field Tracker heartbeat          */
/* ------------------------------------------------------------------ */

/**
 * Report the latest fix so the web Field Tracker can show this phone.
 * Latest-position-only: the server overwrites the single row per employee.
 */
export async function postPresence(
  target: PunchTarget,
  payload: PresencePayload,
  options?: { timeoutMs?: number; attempts?: number }
): Promise<void> {
  const hw = await getDeviceIdentity();
  const deviceId = (payload.deviceId ?? hw.deviceId).trim();
  const deviceName = (payload.deviceName ?? hw.deviceName).trim();

  const result = await requestJson<{ ok: boolean; error?: string }>(
    `${target.apiUrl}/api/mobile/presence`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-mobile-key": target.mobileKey,
        "x-device-id": deviceId,
        "x-device-name": deviceName,
      },
      body: JSON.stringify({
        employeeRef: payload.employeeRef,
        latitude: payload.latitude,
        longitude: payload.longitude,
        accuracyMeters: payload.accuracyMeters ?? null,
        branch: payload.branch ?? null,
        timestamp: payload.timestamp,
        deviceId,
        deviceName,
      }),
    },
    options?.timeoutMs,
    options?.attempts
  );

  if (!result.ok || !result.body?.ok) {
    throw new HttpError(result.status, result.body?.error ?? "Presence report failed.");
  }
}

/**
 * Best-effort presence report for the background fix stream. Never throws:
 * a missed heartbeat must not interrupt the dwell/punch state machine.
 */
export async function reportPresence(
  target: PunchTarget,
  payload: PresencePayload
): Promise<boolean> {
  try {
    await postPresence(target, payload);
    return true;
  } catch {
    return false;
  }
}

/** Drop this employee's presence immediately (called on sign-out). */
export async function clearPresence(
  target: PunchTarget,
  employeeRef: string,
  deviceId?: string | null
): Promise<void> {
  const params = new URLSearchParams({ employeeRef: employeeRef.trim() });
  if (deviceId?.trim()) params.set("deviceId", deviceId.trim());
  const result = await requestJson<{ ok: boolean; error?: string }>(
    `${target.apiUrl}/api/mobile/presence?${params.toString()}`,
    {
      method: "DELETE",
      headers: { "x-mobile-key": target.mobileKey },
    }
  );
  if (!result.ok || !result.body?.ok) {
    throw new HttpError(result.status, result.body?.error ?? "Could not clear presence.");
  }
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
 * Deliver the punch, or park it safely in the offline queue when offline.
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
