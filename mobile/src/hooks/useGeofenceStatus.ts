/**
 * ============================================================================
 *  useGeofenceStatus.ts — what the dashboard's status chip is describing
 * ============================================================================
 *
 *  Foreground only: this hook exists for the UI, never for the punch. The
 *  background task owns the actual decision (and the authoritative verdict is
 *  the bridge's), so everything here is a mirror for the employee to read:
 *
 *    · is the background monitor actually running?
 *    · which registered site are we in right now (or which is nearest)?
 *    · is a dwell in progress, and how much of the 3 minutes is left?
 *
 *  Phase 17: the phone watches EVERY registered site, because an employee may
 *  travel. This hook therefore always reports two things — the site the fix is
 *  inside (if any) and the nearest site — so the readout makes sense whether
 *  you are on site or 40 km away from the nearest branch.
 *
 *  A foreground `watchPositionAsync` is used purely so the readout is live
 *  while the screen is open; the two background tasks keep running regardless.
 */

import * as Location from "expo-location";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  formatDwellRemaining,
  nearestSite,
  activeSite,
  sessionSites,
  type SiteMatch,
} from "@/lib/geo";
import { readDwell } from "@/lib/storage";
import type { DwellState, MobileSession } from "@/lib/types";
import { isTrackingActive } from "@/tasks/geofenceTask";

interface Fix {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}

export interface GeofenceStatusState {
  /** The background monitor is armed — drives the neon "Geofence Active" chip. */
  active: boolean;
  hasFix: boolean;
  /** Current fix coordinates, or null while locating — for the site map. */
  latitude: number | null;
  longitude: number | null;
  /** How many registered sites are being watched. */
  siteCount: number;
  /** The site whose fence contains the fix, or null when outside all of them. */
  site: SiteMatch | null;
  /** The closest site whether or not it contains the fix. */
  nearest: SiteMatch | null;
  /** Convenience: the site being described (containing site, else nearest). */
  siteBranch: string | null;
  radiusMeters: number | null;
  inside: boolean;
  /** Metres to `siteBranch`. */
  distanceMeters: number | null;
  accuracyMeters: number | null;
  /** The current visit, if one is in progress. */
  dwell: DwellState | null;
  /** "2:14" — countdown to the automatic punch, null when idle. */
  dwellRemaining: string | null;
  /** Why hands-free clocking isn't running, when it isn't. */
  message: string | null;
  refreshTracking: () => void;
}

export function useGeofenceStatus(session: MobileSession | null): GeofenceStatusState {
  const [active, setActive] = useState(false);
  const [fix, setFix] = useState<Fix | null>(null);
  const [dwell, setDwell] = useState<DwellState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [trackingNonce, setTrackingNonce] = useState(0);

  const refreshTracking = useCallback(() => setTrackingNonce((n) => n + 1), []);

  const sites = useMemo(() => sessionSites(session), [session]);
  const configured = sites.length > 0;

  // Is the background monitor running at all?
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const running = await isTrackingActive();
      if (cancelled) return;
      setActive(running);
      if (!running) {
        setMessage(
          !session
            ? null
            : !configured
              ? "No branch has mobile clocking set up yet."
              : "Hands-free clocking is not running — tap Enable."
        );
      } else {
        setMessage(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, configured, trackingNonce]);

  // Live position, so the distance readout is honest while the screen is open.
  useEffect(() => {
    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;

    void (async () => {
      if (!session) {
        setFix(null);
        return;
      }
      const seed = await Location.getLastKnownPositionAsync();
      if (!cancelled && seed) {
        setFix({
          latitude: seed.coords.latitude,
          longitude: seed.coords.longitude,
          accuracy: seed.coords.accuracy,
        });
      }
      try {
        subscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: 10_000,
            distanceInterval: 10,
          },
          (update) => {
            if (cancelled) return;
            setFix({
              latitude: update.coords.latitude,
              longitude: update.coords.longitude,
              accuracy: update.coords.accuracy,
            });
          }
        );
      } catch {
        // Permission not granted yet — the chip stays on "Searching…".
      }
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [session]);

  // Mirror the dwell state the background task is writing.
  useEffect(() => {
    let cancelled = false;
    const read = async (): Promise<void> => {
      const state = await readDwell();
      if (!cancelled) setDwell(state);
    };
    void read();
    const timer = setInterval(() => {
      void read();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [session, trackingNonce]);

  // Tick only while a dwell is counting down, so an idle screen wakes nobody.
  useEffect(() => {
    if (!dwell || dwell.firedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [dwell]);

  // Which registered site is this fix in? Falls back to the nearest so the
  // employee always sees a real place and a real distance.
  const match = fix ? activeSite(sites, fix.latitude, fix.longitude, fix.accuracy) : null;
  const nearest = fix ? nearestSite(sites, fix.latitude, fix.longitude, fix.accuracy) : null;
  const shown = match ?? nearest;

  return {
    active,
    hasFix: fix !== null,
    latitude: fix?.latitude ?? null,
    longitude: fix?.longitude ?? null,
    siteCount: sites.length,
    site: match,
    nearest,
    siteBranch: shown?.site.branch ?? null,
    radiusMeters: shown?.site.radiusMeters ?? null,
    inside: match !== null,
    distanceMeters: shown?.distanceMeters ?? null,
    accuracyMeters: fix?.accuracy ?? null,
    dwell,
    dwellRemaining: dwell && !dwell.firedAt ? formatDwellRemaining(dwell.enteredAt, now) : null,
    message,
    refreshTracking,
  };
}
