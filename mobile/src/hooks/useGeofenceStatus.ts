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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";

import {
  nearestSite,
  activeSite,
  sessionSites,
  type SiteMatch,
} from "@/lib/geo";
import { LocationSmoother } from "@/lib/smoother";
import type { MobileSession } from "@/lib/types";
import { ensureForegroundLocationPermission } from "@/tasks/geofenceTask";

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
  const smootherRef = useRef(new LocationSmoother());

  const refreshTracking = useCallback(() => {
    smootherRef.current.reset();
    setTrackingNonce((n) => n + 1);
  }, []);

  const sites = useMemo(() => sessionSites(session), [session]);
  const configured = sites.length > 0;

  // Automatically re-verify permissions and restart GPS stream when returning from Settings / Quick Settings
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setTrackingNonce((n) => n + 1);
      }
    });
    return () => sub.remove();
  }, []);

  // Live position, so distance readout and map update live while screen is open
  useEffect(() => {
    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;
    let fallbackInterval: ReturnType<typeof setInterval> | null = null;
    let pullInFlight = false;

    const applyPosition = (pos: Location.LocationObject) => {
      if (cancelled || !pos?.coords) return;
      const smoothed = smootherRef.current.smooth({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp ?? Date.now(),
      });
      setFix({
        latitude: smoothed.latitude,
        longitude: smoothed.longitude,
        accuracy: smoothed.accuracy,
      });
      setMessage(null);
    };

    const pullLiveFix = async () => {
      if (cancelled || pullInFlight) return;
      pullInFlight = true;
      try {
        const fresh = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
          mayShowUserSettingsDialog: false,
        }).catch(() =>
          Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
            mayShowUserSettingsDialog: false,
          })
        );
        if (!cancelled && fresh) {
          applyPosition(fresh);
        }
      } catch {
        // Still acquiring satellite lock
      } finally {
        pullInFlight = false;
      }
    };

    void (async () => {
      if (!session) {
        setFix(null);
        return;
      }

      // 1. Ensure location permission via single-flight helper (never races with session.tsx)
      const granted = await ensureForegroundLocationPermission();
      if (cancelled) return;
      if (!granted) {
        setMessage("Location permission is needed for live GPS tracking.");
        return;
      }

      setMessage(null);

      // 2. Seed initial UI immediately ONLY if a recent (< 30s, <= 80m) cached fix exists
      try {
        const recentCached = await Location.getLastKnownPositionAsync({
          maxAge: 30_000,
          requiredAccuracy: 80,
        });
        if (!cancelled && recentCached) {
          applyPosition(recentCached);
        }
      } catch {
        // Ignore
      }

      // 3. Start continuous high-accuracy hardware stream immediately
      try {
        subscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: 1_000,
            distanceInterval: 0,
            mayShowUserSettingsDialog: false,
          },
          (update) => {
            applyPosition(update);
          }
        );
      } catch {
        // Fallback polling below will still drive updates
      }

      // 4. Kickstart live position immediately in parallel
      void pullLiveFix();

      // 5. Periodic live poll backstop ensures coordinates keep updating on all OEM handsets
      fallbackInterval = setInterval(() => {
        if (!cancelled) {
          void pullLiveFix();
        }
      }, 3_500);
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
      if (fallbackInterval) {
        clearInterval(fallbackInterval);
      }
    };
  }, [session?.employee.employeeId, trackingNonce]);

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
