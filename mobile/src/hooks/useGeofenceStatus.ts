/**
 * ============================================================================
 *  useGeofenceStatus.ts — Live GPS & Geofence Status for Dashboard
 * ============================================================================
 *
 *  Foreground only: this hook gives the dashboard a live window into:
 *    · live GPS coordinates & accuracy
 *    · which registered site the employee is inside right now (or nearest site)
 *    · distance to site boundary and site radius (accurately reflecting edits)
 *    · inside/outside geofence status
 */

import * as Location from "expo-location";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  nearestSite,
  activeSite,
  sessionSites,
  type SiteMatch,
} from "@/lib/geo";
import type { MobileSession } from "@/lib/types";

interface Fix {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}

export interface GeofenceStatusState {
  /** Drives the status chip ("Geofence Active" / "Ready to Clock") */
  active: boolean;
  hasFix: boolean;
  /** Current fix coordinates, or null while locating — for the site map */
  latitude: number | null;
  longitude: number | null;
  /** How many registered sites are being watched */
  siteCount: number;
  /** The site whose fence contains the fix, or null when outside all of them */
  site: SiteMatch | null;
  /** The closest site whether or not it contains the fix */
  nearest: SiteMatch | null;
  /** Convenience: the site being described (containing site, else nearest) */
  siteBranch: string | null;
  radiusMeters: number | null;
  inside: boolean;
  /** Metres to site centre */
  distanceMeters: number | null;
  accuracyMeters: number | null;
  message: string | null;
  refreshTracking: () => void;
}

export function useGeofenceStatus(session: MobileSession | null): GeofenceStatusState {
  const [fix, setFix] = useState<Fix | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [trackingNonce, setTrackingNonce] = useState(0);

  const refreshTracking = useCallback(() => setTrackingNonce((n) => n + 1), []);

  const sites = useMemo(() => sessionSites(session), [session]);
  const configured = sites.length > 0;

  // Live position, so distance readout and map update live while screen is open
  useEffect(() => {
    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;
    let fallbackInterval: ReturnType<typeof setInterval> | null = null;

    const pullFix = async () => {
      try {
        const pos = await Location.getLastKnownPositionAsync();
        if (!cancelled && pos) {
          setFix({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          });
        }
      } catch {
        // Fix not available yet
      }
    };

    void (async () => {
      if (!session) {
        setFix(null);
        return;
      }

      await pullFix();

      try {
        subscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: 5_000,
            distanceInterval: 5,
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
        if (!cancelled) {
          setMessage("Live GPS tracking in progress (fallback mode).");
        }
      }

      // Interval fallback ensures coordinates keep updating smoothly on all devices
      fallbackInterval = setInterval(() => {
        if (!cancelled) {
          void pullFix();
        }
      }, 5_000);
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
      if (fallbackInterval) {
        clearInterval(fallbackInterval);
      }
    };
  }, [session, trackingNonce]);

  // Which registered site is this fix in?
  const match = fix ? activeSite(sites, fix.latitude, fix.longitude, fix.accuracy) : null;
  const nearest = fix ? nearestSite(sites, fix.latitude, fix.longitude, fix.accuracy) : null;
  const shown = match ?? nearest;

  const active = configured && fix !== null;

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
    message: !configured ? "No site has mobile clocking configured yet." : message,
    refreshTracking,
  };
}
