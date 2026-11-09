/**
 * ============================================================================
 *  useLocationHealth.ts — live "why isn't this phone sharing?" diagnostics
 * ============================================================================
 *
 *  Reads the permission precision, background permission, provider state,
 *  battery-optimisation exemption, native engine marker and last heartbeat.
 *  Also exposes the recovery actions the dashboard offers (open settings,
 *  allow background location, locate now).
 *
 *  Everything is best-effort: a failed native call degrades to "unknown" and
 *  never blocks the clock-in/out flow.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import {
  getLocationDiagnostics,
  locateAndShareNow,
  requestBackgroundLocationPermission,
  type LocationDiagnostics,
  type LocateNowResult,
} from "@/tasks/geofenceTask";
import {
  EXPECTED_NATIVE_MARKER,
  openAppSettings,
  openBatteryOptimizationSettings,
  openHuaweiStartupSettings,
  openLocationSettings,
} from "@/lib/nativeLocation";
import type { MobileSession } from "@/lib/types";

export interface LocationHealthState {
  diagnostics: LocationDiagnostics | null;
  loading: boolean;
  actionBusy: string | null;
  actionMessage: string | null;
  locateBusy: boolean;
  locateResult: LocateNowResult | null;
  /** True when the installed APK contains the current native fallback. */
  nativeEngineCurrent: boolean;
  refresh: () => void;
  allowBackground: () => Promise<void>;
  locateNow: () => Promise<void>;
  openAppSettings: () => Promise<void>;
  openLocationSettings: () => Promise<void>;
  openBatterySettings: () => Promise<void>;
  openHuaweiStartup: () => Promise<void>;
}

export function useLocationHealth(
  session: MobileSession | null,
  retryTracking: () => Promise<void>
): LocationHealthState {
  const [diagnostics, setDiagnostics] = useState<LocationDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [locateBusy, setLocateBusy] = useState(false);
  const [locateResult, setLocateResult] = useState<LocateNowResult | null>(null);
  const mounted = useRef(true);
  const refreshing = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    if (!session || refreshing.current) return;
    refreshing.current = true;
    void (async () => {
      try {
        const next = await getLocationDiagnostics();
        if (mounted.current) setDiagnostics(next);
      } finally {
        refreshing.current = false;
        if (mounted.current) setLoading(false);
      }
    })();
  }, [session]);

  useEffect(() => {
    setLoading(true);
    refresh();

    const interval = setInterval(refresh, 15_000);
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });

    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [refresh]);

  const runAction = useCallback(
    async (key: string, action: () => Promise<boolean>) => {
      if (actionBusy) return;
      setActionBusy(key);
      setActionMessage(null);
      try {
        const ok = await action();
        if (!ok) {
          setActionMessage(
            "The phone could not open that settings page. Open Settings → Apps → BioBridge and adjust it manually."
          );
        }
      } finally {
        if (mounted.current) setActionBusy(null);
      }
    },
    [actionBusy]
  );

  const allowBackground = useCallback(async () => {
    if (!session || actionBusy) return;
    setActionBusy("background");
    setActionMessage(null);
    try {
      const result = await requestBackgroundLocationPermission();
      if (result.granted) {
        setActionMessage("Background location allowed. Restarting location sharing…");
        await retryTracking();
      } else {
        setActionMessage(
          result.access.precision === "coarse"
            ? "Choose Precise location first, then set Allow all the time."
            : "Background location was not granted. In Settings choose Location → Allow all the time."
        );
      }
    } finally {
      refresh();
      if (mounted.current) setActionBusy(null);
    }
  }, [actionBusy, refresh, retryTracking, session]);

  const locateNow = useCallback(async () => {
    if (!session || locateBusy) return;
    setLocateBusy(true);
    setLocateResult(null);
    try {
      const result = await locateAndShareNow(session);
      if (mounted.current) setLocateResult(result);
      // A successful manual fix is also a good moment to re-check the stream.
      if (result.ok) void retryTracking();
    } finally {
      if (mounted.current) {
        setLocateBusy(false);
        refresh();
      }
    }
  }, [locateBusy, refresh, retryTracking, session]);

  return {
    diagnostics,
    loading,
    actionBusy,
    actionMessage,
    locateBusy,
    locateResult,
    nativeEngineCurrent: diagnostics?.nativeMarker === EXPECTED_NATIVE_MARKER,
    refresh,
    allowBackground,
    locateNow,
    openAppSettings: () => runAction("app", openAppSettings),
    openLocationSettings: () => runAction("location", openLocationSettings),
    openBatterySettings: () => runAction("battery", openBatteryOptimizationSettings),
    openHuaweiStartup: () => runAction("huawei", openHuaweiStartupSettings),
  };
}
