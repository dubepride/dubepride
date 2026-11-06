/**
 * ============================================================================
 *  smoother.ts — GPS jitter & flapping suppression filter
 * ============================================================================
 *
 *  Solves the "flapping around like it's detecting lies" problem on smartphones:
 *  1. Outlier Rejection: Drops low-accuracy cellular/wifi jumps (>65m) when
 *     an accurate GPS satellite fix (<25m) is already active.
 *  2. Micro-jitter Suppression: When stationary or walking slowly inside a
 *     20m geofence, standard smartphone GPS drifts 3-8m per second. An
 *     adaptive Exponential Moving Average (EMA) absorbs the drift so the dot
 *     and distance indicator stay rock-solid.
 *  3. Velocity Clamping: Prevents instantaneous teleportation (>20m/s).
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
    const now = raw.timestamp && raw.timestamp > 0 ? raw.timestamp : Date.now();
    const rawAcc = raw.accuracy !== null && raw.accuracy !== undefined ? Math.max(1, raw.accuracy) : null;

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
    const timeDeltaSec = Math.max(0.1, (now - prev.timestamp) / 1000);
    const distMeters = haversineMeters(prev.latitude, prev.longitude, raw.latitude, raw.longitude);

    // 1. Outlier / low-accuracy rejection:
    // If we have an accurate fix (<25m) within the last 20 seconds, and the new fix is
    // very coarse (>65m, e.g. cell tower), ignore the coarse jump.
    if (prev.accuracy !== null && prev.accuracy <= 25 && rawAcc !== null && rawAcc > 65 && timeDeltaSec < 20) {
      return prev;
    }

    // 2. Teleportation clamp:
    // If movement exceeds 25 m/s (90 km/h) while accuracy is degraded, suppress the jump.
    const speedMps = distMeters / timeDeltaSec;
    if (speedMps > 25 && rawAcc !== null && prev.accuracy !== null && rawAcc > prev.accuracy + 20) {
      return prev;
    }

    // 3. Adaptive EMA Weight:
    // When stationary/micro-movements (< 3m): heavy smoothing (alpha = 0.25).
    // When walking (3m - 15m): smooth transitions (alpha = 0.55).
    // When moving fast (> 15m): track closely (alpha = 0.85).
    let alpha: number;
    if (distMeters < 3.0) {
      alpha = 0.25;
    } else if (distMeters < 15.0) {
      alpha = 0.55;
    } else {
      alpha = 0.85;
    }

    // High accuracy updates deserve higher weight
    if (rawAcc !== null && rawAcc <= 10) {
      alpha = Math.min(0.9, alpha + 0.15);
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
      timestamp: now,
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
