/**
 * ============================================================================
 *  queue.ts — the offline punch queue
 * ============================================================================
 *
 *  A punch that cannot reach the bridge is not lost: the payload is stored
 *  verbatim — original `timestamp` included — and replayed later. Preserving
 *  the *original* time matters, because that is the time the employee was
 *  actually at the gate; the bridge stamps Attendance_Logs.Timestamp from it.
 *
 *  Two properties this module guarantees:
 *
 *   1. FIFO order. The bridge infers IN/OUT from the employee's punch
 *      sequence for the day, so replaying out of order would invert a
 *      clock-in and a clock-out. Flushes walk the list oldest-first.
 *
 *   2. No lost writes. Background fixes can land while the dashboard is
 *      flushing, so every read-modify-write runs inside `exclusive()` — a
 *      single-file promise chain that serialises queue mutations.
 */

import { readQueue, writeQueue } from "./storage";
import type { GeoPunchPayload, GeoPunchResponse, QueuedPunch } from "./types";

let tail: Promise<unknown> = Promise.resolve();

/** Run `work` after every previously queued mutation has settled. */
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work);
  tail = run.catch(() => undefined);
  return run;
}

/** Stable identity — re-queueing the same punch is a no-op, not a duplicate. */
export function queueId(payload: GeoPunchPayload): string {
  return `${payload.employeeRef}:${payload.timestamp}`;
}

export async function listQueued(): Promise<QueuedPunch[]> {
  return readQueue();
}

export async function queuedCount(): Promise<number> {
  return (await readQueue()).length;
}

/** Append a failed punch. Returns the new queue. */
export async function enqueue(
  payload: GeoPunchPayload,
  error?: string
): Promise<QueuedPunch[]> {
  return exclusive(async () => {
    const queue = await readQueue();
    const id = queueId(payload);
    if (!queue.some((entry) => entry.id === id)) {
      queue.push({ id, payload, queuedAt: Date.now(), error });
    }
    await writeQueue(queue);
    return queue;
  });
}

/** Drop specific entries (after they finally reach the bridge). */
export async function dropQueued(ids: string[]): Promise<QueuedPunch[]> {
  return exclusive(async () => {
    const drop = new Set(ids);
    const queue = (await readQueue()).filter((entry) => !drop.has(entry.id));
    await writeQueue(queue);
    return queue;
  });
}

export async function clearQueue(): Promise<void> {
  return exclusive(async () => {
    await writeQueue([]);
  });
}

/* ------------------------------------------------------------------ */
/* Flushing                                                            */
/* ------------------------------------------------------------------ */

export interface FlushDetail {
  id: string;
  ok: boolean;
  reason?: string;
  message: string;
}

export interface FlushResult {
  attempted: number;
  sent: number;
  /** Retired without syncing: the bridge recorded them as exceptions, or the
   *  site's policy can never accept them. See `retireReason` below. */
  retired: number;
  /** Still queued — retryable (bridge unhealthy, or config a human must fix). */
  remaining: number;
  message: string;
  details: FlushDetail[];
}

/**
 * Walk the queue oldest-first, sending each punch through `sender`.
 *
 * A punch is retired (deleted, never replayed) when retrying it can only ever
 * produce the same answer:
 *   · ok:true                      → delivered.
 *   · OUTSIDE_GEOFENCE             → already recorded bridge-side as a denied
 *                                    exception; the fix is in the past.
 *   · BIOMETRIC_ONLY               → a policy decision, not a transient fault.
 * Anything else (transport error, 5xx, GEOFENCE_NOT_CONFIGURED, 401) stays
 * queued, and a transport error aborts the walk immediately so we don't grind
 * through a queue while offline.
 */
export async function flushQueue(
  sender: (payload: GeoPunchPayload) => Promise<GeoPunchResponse>
): Promise<FlushResult> {
  const queue = await readQueue();
  const details: FlushDetail[] = [];
  const delivered: string[] = [];
  let sent = 0;
  let retired = 0;

  for (const entry of queue) {
    let response: GeoPunchResponse;
    try {
      response = await sender(entry.payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network request failed";
      details.push({ id: entry.id, ok: false, message });
      // Still unreachable — leave this and everything behind it for later.
      break;
    }

    if (response.ok) {
      sent += 1;
      delivered.push(entry.id);
      details.push({ id: entry.id, ok: true, reason: response.reason, message: response.message });
      continue;
    }

    if (response.reason === "OUTSIDE_GEOFENCE" || response.reason === "BIOMETRIC_ONLY") {
      retired += 1;
      delivered.push(entry.id);
      details.push({ id: entry.id, ok: false, reason: response.reason, message: response.message });
      continue;
    }

    // Retryable — keep it, and stop: the next entry would fail identically.
    details.push({
      id: entry.id,
      ok: false,
      reason: response.reason,
      message: response.error ?? response.message,
    });
    break;
  }

  if (delivered.length > 0) await dropQueued(delivered);

  const remaining = (await readQueue()).length;
  const message =
    queue.length === 0
      ? "Nothing to sync — the queue is empty."
      : sent === 0 && retired === 0
        ? "Still offline — punches are safe on the device."
        : `${sent} punch${sent === 1 ? "" : "es"} synced${retired > 0 ? `, ${retired} rejected` : ""}${
            remaining > 0 ? `, ${remaining} still queued` : ""
          }.`;

  return { attempted: queue.length, sent, retired, remaining, message, details };
}
