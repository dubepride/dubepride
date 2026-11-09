/**
 * ============================================================================
 *  presence.ts — the Field Tracker heartbeat, safe across connectivity gaps
 * ============================================================================
 *
 *  While an employee is signed in the phone shares its LATEST location with the
 *  office Field Tracker. This is deliberately not a movement history:
 *
 *    · only one fix is ever kept on the device;
 *    · a newer fix replaces an unsent older one;
 *    · the server stores one row per employee and overwrites it.
 *
 *  Delivery is best-effort. A failed heartbeat is written to AsyncStorage and
 *  retried by `flushPendingPresence()` when connectivity returns. Fixes older
 *  than the bridge's presence window are dropped instead of being uploaded as
 *  if they were live.
 *
 *  This module never throws: it runs inside a headless background task where an
 *  uncaught rejection would be lost.
 */

import { HttpError, NetworkError, postPresence } from "./api";
import {
  clearPendingPresence,
  readPendingPresence,
  writeLastPresence,
  writePendingPresence,
} from "./storage";
import type { MobileSession, PresencePayload } from "./types";

/** The bridge refuses fixes older than this; keep the two in step. */
export const PRESENCE_MAX_AGE_MS = 30 * 60_000;

/** A fast, single-attempt send keeps an offline background fix from hanging. */
const PRESENCE_TIMEOUT_MS = 10_000;

export type PresenceDelivery =
  /** The bridge accepted (or deliberately ignored) the fix. */
  | "sent"
  /** The fix is stored on the device and will be retried. */
  | "queued"
  /** The fix is past the tracked window — nothing useful to send. */
  | "stale"
  /** The bridge refused the fix; retrying the same payload cannot succeed. */
  | "rejected";

type PresenceTarget = Pick<MobileSession, "apiUrl" | "mobileKey">;

function fixTimestamp(payload: PresencePayload): number {
  const value = payload.timestamp;
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function isStale(payload: PresencePayload, now: number = Date.now()): boolean {
  return now - fixTimestamp(payload) > PRESENCE_MAX_AGE_MS;
}

/** Persist the outcome so the Location health panel can explain stale data. */
async function remember(
  payload: PresencePayload,
  status: PresenceDelivery
): Promise<void> {
  await writeLastPresence({
    status,
    at: Date.now(),
    accuracyMeters: payload.accuracyMeters ?? null,
    branch: payload.branch ?? null,
  }).catch(() => undefined);
}

/**
 * Send one heartbeat. On a transport failure the fix is kept (latest wins) so
 * the next successful connection can publish the employee's last known
 * position. Server verdicts (bad employee, wrong device) are not retried.
 */
export async function deliverPresence(
  target: PresenceTarget,
  payload: PresencePayload
): Promise<PresenceDelivery> {
  if (isStale(payload)) {
    await clearPendingPresence();
    await remember(payload, "stale");
    return "stale";
  }

  try {
    await postPresence(target, payload, {
      timeoutMs: PRESENCE_TIMEOUT_MS,
      attempts: 1,
    });
    await clearPendingPresence();
    await remember(payload, "sent");
    return "sent";
  } catch (err) {
    const retryable =
      err instanceof NetworkError ||
      (err instanceof HttpError &&
        (err.status >= 500 || err.status === 401 || err.status === 429));

    if (retryable) {
      await writePendingPresence(payload);
      await remember(payload, "queued");
      return "queued";
    }

    // A definitive bridge answer (400/403/404). Keeping the payload would only
    // repeat the same failure forever.
    await clearPendingPresence();
    await remember(payload, "rejected");
    return "rejected";
  }
}

/**
 * Publish the fix that could not be sent earlier. Called when the app
 * reconnects or returns to the foreground. Returns "none" when there is
 * nothing waiting.
 */
export async function flushPendingPresence(
  target: PresenceTarget
): Promise<PresenceDelivery | "none"> {
  const pending = await readPendingPresence();
  if (!pending) return "none";
  return deliverPresence(target, pending);
}
