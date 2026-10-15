/**
 * ============================================================================
 *  rate-limit.ts — tiny in-process abuse guard for clocking ingress (Phase 18)
 * ============================================================================
 *
 *  The two geofenced-punch routes are the only state-changing endpoints a
 *  device or worker can reach without an admin console. They are already
 *  authenticated (shared mobile key or a signed-in session) and validated, but
 *  a leaked key or a stuck phone could otherwise hammer the Attendance_Logs
 *  table. This adds a cheap fixed-window limiter as defence in depth.
 *
 *  Scope + honesty
 *  ───────────────
 *  • Per-process, in-memory. It is NOT a substitute for an edge/gateway rate
 *    limit in a multi-instance deployment — each Node instance keeps its own
 *    counters. It is the right weight for this single-node SQLite bridge.
 *  • Keyed by caller identity + the endpoint, so one busy worker cannot lock
 *    out everyone else.
 *  • Never throws: on any surprise it fails OPEN (allows the request), because
 *    availability of a legitimate clock-in matters more than the last unit of
 *    throttling — the geofence policy is the real gate.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets (for a Retry-After header). */
  retryAfterSeconds: number;
  /** Remaining permitted requests in the current window. */
  remaining: number;
  limit: number;
}

interface Window {
  count: number;
  resetAt: number;
}

const store = new Map<string, Window>();
let lastSweep = 0;
const SWEEP_INTERVAL_MS = 60_000;

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, win] of store) {
    if (win.resetAt <= now) store.delete(key);
  }
}

/**
 * Consume one token for `key`. `limit` requests are allowed per `windowMs`.
 * Returns `allowed:false` once the window is exhausted.
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  try {
    const now = Date.now();
    sweep(now);

    let win = store.get(key);
    if (!win || win.resetAt <= now) {
      win = { count: 0, resetAt: now + windowMs };
      store.set(key, win);
    }
    win.count += 1;

    const remaining = Math.max(0, limit - win.count);
    const allowed = win.count <= limit;
    return {
      allowed,
      remaining,
      limit,
      retryAfterSeconds: Math.max(1, Math.ceil((win.resetAt - now) / 1000)),
    };
  } catch {
    // Fail open — never block a genuine clock-in on a limiter fault.
    return { allowed: true, retryAfterSeconds: 0, remaining: limit, limit };
  }
}

/** Best-effort client identity: proxy headers first, then a stable fallback. */
export function clientKey(headers: Headers, suffix = ""): string {
  const fwd = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real = headers.get("x-real-ip")?.trim();
  const ip = fwd || real || "local";
  return suffix ? `${suffix}:${ip}` : ip;
}

/** Test/diagnostic hook — clears every counter. */
export function resetRateLimits(): void {
  store.clear();
  lastSweep = 0;
}
