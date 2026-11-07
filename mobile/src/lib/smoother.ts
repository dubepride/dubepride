/**
 * ============================================================================
 *  smoother.ts — GPS jitter & flapping suppression filter
 * ============================================================================
 *
 *  Solves the "flapping around like it's detecting lies" problem on smartphones:
 *  1. Out-of-order / Stale Fix Rejection: Never allows an older cached fix to
 *     pull the dot backwards in time after a newer fix has arrived.
 *  2. Outlier Rejection: Drops low-accuracy cellular/wifi jumps (>65m) when
 *     an accurate GPS satellite fix (<=25m) is already active.
 *  3. Instant Lock Snap: When a fresh GPS lock arrives after a coarse fix or
 *     after >15s / >40m movement, snaps immediately so entering a 20m geofence
 *     has zero lag.
 *  4. Micro-jitter Suppression: When stationary inside a geofence, adaptive
 *     EMA absorbs 2-5m satellite drift so the neon dot stays rock-solid.
 */

import { haversineMeters } from "./geo";

export interface SmoothedPosition {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  timestamp: number;
}

export interface RawFixInput {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  timestamp?: number;
}

export class LocationSmoother {
  private lastFix: SmoothedPosition | null = null;

  /**
   * Filter an incoming raw GPS coordinate and return a smoothed, jitter-free fix.
   */
  public smooth(raw: RawFixInput): SmoothedPosition {
    if (!Number.isFinite(raw.latitude) || !Number.isFinite(raw.longitude)) {
      return (
        this.lastFix ?? {
          latitude: 0,
          longitude: 0,
          accuracy: null,
          timestamp: Date.now(),
        }
      );
    }

    const wallNow = Date.now();
    const now = raw.timestamp && raw.timestamp > 0 && raw.timestamp <= wallNow + 60_000 ? raw.timestamp : wallNow;
    const rawAcc = raw.accuracy !== null && raw.accuracy !== undefined && Number.isFinite(raw.accuracy) ? Math.max(1, raw.accuracy) : null;

    if (!this.lastFix) {
      const initial: SmoothedPosition = {
        latitude: raw.latitude,
        longitude: raw.longitude,
        accuracy: rawAcc,
        timestamp: now,
      };
      this.lastFix = initial;
      return initial;
    }

    const prev = this.lastFix;

    // 1. Reject stale / out-of-order cached fixes that are older than our current fix
    if (now < prev.timestamp - 500 && prev.timestamp <= wallNow + 60_000) {
      return prev;
    }

    const timeDeltaSec = Math.max(0.1, (now - prev.timestamp) / 1000);
    const distMeters = haversineMeters(prev.latitude, prev.longitude, raw.latitude, raw.longitude);

    // 2. Outlier / low-accuracy rejection:
    // If we have an accurate fix (<=25m) within the last 20 seconds, and the new fix is
    // very coarse (>65m, e.g. cell tower jump), ignore the coarse jump.
    if (prev.accuracy !== null && prev.accuracy <= 25 && rawAcc !== null && rawAcc > 65 && timeDeltaSec < 20) {
      return prev;
    }

    // 3. Teleportation clamp:
    // If movement exceeds 30 m/s (108 km/h) while accuracy degraded significantly, suppress the jump.
    const speedMps = distMeters / timeDeltaSec;
    if (speedMps > 30 && rawAcc !== null && prev.accuracy !== null && rawAcc > prev.accuracy + 25 && timeDeltaSec < 15) {
      return prev;
    }

    // 4. Instant snap when transitioning from coarse fix to sharp satellite lock,
    // or after a large real movement (>40m) or long time gap (>15s).
    const accuracyImprovedSharply =
      prev.accuracy !== null && rawAcc !== null && rawAcc <= 25 && rawAcc < prev.accuracy * 0.65;
    if (accuracyImprovedSharply || timeDeltaSec > 15 || (distMeters > 40 && (rawAcc === null || rawAcc <= 60))) {
      const snapped: SmoothedPosition = {
        latitude: raw.latitude,
        longitude: raw.longitude,
        accuracy: rawAcc ?? prev.accuracy,
        timestamp: Math.max(now, prev.timestamp),
      };
      this.lastFix = snapped;
      return snapped;
    }

    // 5. Adaptive EMA Weight:
    // Stationary micro-movements (< 2.5m): absorb satellite drift (alpha = 0.30).
    // Walking (2.5m - 15m): responsive tracking (alpha = 0.72).
    // Brisk movement (15m - 40m): near-instant tracking (alpha = 0.90).
    let alpha: number;
    if (distMeters < 2.5) {
      alpha = 0.30;
    } else if (distMeters < 15.0) {
      alpha = 0.72;
    } else {
      alpha = 0.90;
    }

    // High accuracy satellite fixes (< 10m) get higher weight
    if (rawAcc !== null && rawAcc <= 10) {
      alpha = Math.min(0.95, alpha + 0.15);
    }

    const smoothLat = prev.latitude * (1 - alpha) + raw.latitude * alpha;
    const smoothLng = prev.longitude * (1 - alpha) + raw.longitude * alpha;
    const smoothAcc =
      prev.accuracy !== null && rawAcc !== null
        ? Math.round(prev.accuracy * (1 - alpha) + rawAcc * alpha)
        : rawAcc ?? prev.accuracy;

    const result: SmoothedPosition = {
      latitude: smoothLat,
      longitude: smoothLng,
      accuracy: smoothAcc,
      timestamp: Math.max(now, prev.timestamp),
    };

    this.lastFix = result;
    return result;
  }

  public reset(): void {
    this.lastFix = null;
  }
}

/** Global default smoother for app-wide single-shot fixes */
export const defaultSmoother = new LocationSmoother();
