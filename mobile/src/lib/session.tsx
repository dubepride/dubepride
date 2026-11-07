/**
 * ============================================================================
 *  session.tsx — the authenticated session for BioBridge Mobile
 * ============================================================================
 *
 *  Manages employee-number login, offline session caching, and live background
 *  synchronization (`refreshFences`) so any edits made on the web app (resizing
 *  geofence radii, moving site pins, changing clocking methods, renaming/adding
 *  branches, or editing employee details) accurately reflect on the mobile app.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  clearPresence,
  configuredApiUrl,
  configuredMobileKey,
  fetchMobileFences,
  HttpError,
  login as loginRequest,
  NetworkError,
  normaliseApiUrl,
} from "./api";
import { getDeviceIdentity } from "./device";
import {
  clearLastVerifiedSession,
  readLastVerifiedSession,
  readQueue,
  readSavedApiUrl,
  readSession,
  writePin,
  writeSavedApiUrl,
  writeSession,
} from "./storage";
import type { MobileDayStatus, MobileSession } from "./types";
import {
  startGeofenceTracking,
  stopGeofenceTracking,
  type TrackingResult,
} from "@/tasks/geofenceTask";

export type AuthStatus = "restoring" | "signed-in" | "signed-out";

export interface SignInInput {
  employeeNumber?: string;
  employeeId?: string;
  pin?: string;
  apiUrl: string;
}

export interface SignInOutcome {
  ok: boolean;
  /** True when the session came from the device's cache, not the bridge. */
  offline: boolean;
  error: string | null;
  message: string | null;
}

interface AuthContextValue {
  status: AuthStatus;
  session: MobileSession | null;
  tracking: TrackingResult | null;
  /** Last base URL that worked — pre-fills the login screen. */
  initialApiUrl: string;
  /** Persistent hardware device ID and handset model for anti-buddy clocking. */
  deviceId: string | null;
  deviceName: string | null;
  signIn: (input: SignInInput) => Promise<SignInOutcome>;
  signOut: () => Promise<void>;
  retryTracking: () => Promise<void>;
  /** Refresh active geofences, radii, employee profile & day status from the server. */
  refreshFences: () => Promise<{ updated: boolean; count: number }>;
  /** Immediately toggle dayStatus in the local session for offline punch responsiveness. */
  recordLocalPunch: (direction: "IN" | "OUT", time?: number) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function maybeStartTracking(session: MobileSession): Promise<TrackingResult | null> {
  // Always keep the background location stream running while signed in: it
  // powers the Field Tracker heartbeat. Clocking itself stays manual.
  try {
    return await startGeofenceTracking(session);
  } catch {
    return null;
  }
}

/** Does a cached session belong to the Employee Number just typed? */
function matchesEmployee(session: MobileSession, ref: string): boolean {
  const value = ref.trim().toLowerCase();
  if (!value) return false;
  const erp = session.employee.erpUserId.toLowerCase();
  const id = String(session.employee.employeeId);
  const valDigits = value.replace(/\D+/g, "");
  const erpDigits = erp.replace(/\D+/g, "");
  return (
    value === erp ||
    value === id ||
    value === `emp${id}` ||
    value === `emp_${id}` ||
    value === `emp-${id}` ||
    value === `erp-${id}` ||
    (valDigits !== "" && valDigits === erpDigits)
  );
}

export function AuthProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [status, setStatus] = useState<AuthStatus>("restoring");
  const [session, setSession] = useState<MobileSession | null>(null);
  const [tracking, setTracking] = useState<TrackingResult | null>(null);
  const [initialApiUrl, setInitialApiUrl] = useState<string>(() => configuredApiUrl());
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const sessionRef = React.useRef(session);
  React.useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const hw = await getDeviceIdentity();
      if (!cancelled) {
        setDeviceId(hw.deviceId);
        setDeviceName(hw.deviceName);
      }

      const savedUrl = await readSavedApiUrl();
      if (!cancelled && savedUrl && !savedUrl.includes("10.0.2.2")) {
        setInitialApiUrl(savedUrl);
      }

      const restored = await readSession();
      if (cancelled) return;
      setSession(restored);
      setStatus(restored ? "signed-in" : "signed-out");

      if (restored) {
        const result = await maybeStartTracking(restored);
        if (!cancelled) setTracking(result);

        // If restored session predates device binding, auto-bind this handset now
        if (!restored.employee.boundDeviceId) {
          try {
            const loginRes = await loginRequest({
              employeeNumber: restored.employee.erpUserId,
              employeeId: restored.employee.erpUserId,
              deviceId: hw.deviceId,
              deviceName: hw.deviceName,
              apiUrl: restored.apiUrl,
              mobileKey: restored.mobileKey,
            });
            if (!cancelled) {
              const updated: MobileSession = {
                ...restored,
                employee: loginRes.employee,
                deviceId: hw.deviceId,
                deviceName: hw.deviceName,
              };
              sessionRef.current = updated;
              await writeSession(updated);
              setSession(updated);
            }
          } catch {
            // Will retry on next refresh or punch
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshFences = useCallback(async (): Promise<{ updated: boolean; count: number }> => {
    const active = sessionRef.current;
    if (!active) return { updated: false, count: 0 };
    try {
      const data = await fetchMobileFences(active, {
        employeeId: active.employee.employeeId,
        employeeRef: active.employee.erpUserId,
      });

      const nextEmployee = data.employee
        ? { ...active.employee, ...data.employee }
        : active.employee;

      // If the employee was deactivated in the web admin, bound to another device,
      // or their device binding was reset/unbound by an admin, sign out cleanly
      const hw = await getDeviceIdentity();
      const wasUnboundByAdmin =
        Boolean(active.employee.boundDeviceId) &&
        data.employee !== null &&
        data.employee !== undefined &&
        !data.employee.boundDeviceId;
      if (
        (nextEmployee.status && nextEmployee.status !== "Active") ||
        (nextEmployee.boundDeviceId && nextEmployee.boundDeviceId !== hw.deviceId) ||
        wasUnboundByAdmin
      ) {
        await stopGeofenceTracking();
        await writeSession(null);
        await clearLastVerifiedSession();
        setSession(null);
        setTracking(null);
        setStatus("signed-out");
        return { updated: true, count: 0 };
      }

      const nextFences = Array.isArray(data.fences) ? data.fences : active.fences;
      const nextGeofence = data.geofence !== undefined ? data.geofence : active.geofence;
      const queuedPunches = await readQueue();
      const localPunchIsNewer =
        queuedPunches.length > 0 ||
        ((active.dayStatus?.lastPunchAt ?? 0) > (data.dayStatus?.lastPunchAt ?? 0));
      const nextDayStatus =
        localPunchIsNewer && active.dayStatus !== undefined
          ? active.dayStatus
          : data.dayStatus !== undefined
            ? data.dayStatus
            : active.dayStatus;

      const next: MobileSession = {
        ...active,
        employee: nextEmployee,
        fences: nextFences,
        geofence: nextGeofence,
        dayStatus: nextDayStatus,
        offline: false,
      };

      const changed =
        active.offline !== false ||
        JSON.stringify(active.fences) !== JSON.stringify(next.fences) ||
        JSON.stringify(active.geofence) !== JSON.stringify(next.geofence) ||
        JSON.stringify(active.employee) !== JSON.stringify(next.employee) ||
        JSON.stringify(active.dayStatus) !== JSON.stringify(next.dayStatus);

      if (changed) {
        sessionRef.current = next;
        await writeSession(next);
        setSession(next);
      }

      // Coming back online after an offline unlock is the moment to make sure
      // the background fix stream is actually running again (permissions may
      // have been granted since the cached sign-in).
      if (active.offline) {
        setTracking(await startGeofenceTracking(next));
      }

      return { updated: changed, count: nextFences.length };
    } catch {
      // Keep existing cached session if server is temporarily unreachable
    }
    return { updated: false, count: active.fences?.length ?? 0 };
  }, []);

  const signIn = useCallback(async (input: SignInInput): Promise<SignInOutcome> => {
    const base = normaliseApiUrl(input.apiUrl) || configuredApiUrl();
    const mobileKey = configuredMobileKey();
    const empRef = (input.employeeNumber ?? input.employeeId ?? "").trim();

    try {
      const hw = await getDeviceIdentity();
      const result = await loginRequest({
        employeeNumber: empRef,
        employeeId: empRef,
        pin: input.pin || undefined,
        deviceId: hw.deviceId,
        deviceName: hw.deviceName,
        apiUrl: base,
        mobileKey,
      });

      const next: MobileSession = {
        employee: result.employee,
        fences: result.fences ?? [],
        geofence: result.geofence,
        apiUrl: base,
        mobileKey,
        deviceId: hw.deviceId,
        deviceName: hw.deviceName,
        signedInAt: Date.now(),
        offline: false,
      };
      sessionRef.current = next;
      await writeSession(next);
      if (input.pin) await writePin(input.pin);
      await writeSavedApiUrl(base);

      setSession(next);
      setStatus("signed-in");
      setTracking(await maybeStartTracking(next));

      return { ok: true, offline: false, error: null, message: result.message };
    } catch (err) {
      // ── Offline: fall back to the session already verified on this device ──
      if (err instanceof NetworkError) {
        const cached = (await readSession()) ?? (await readLastVerifiedSession());
        if (cached && matchesEmployee(cached, empRef)) {
          const next: MobileSession = { ...cached, apiUrl: base, offline: true };
          sessionRef.current = next;
          await writeSession(next);
          await writeSavedApiUrl(base);
          setSession(next);
          setStatus("signed-in");
          setTracking(await maybeStartTracking(next));
          return {
            ok: true,
            offline: true,
            error: null,
            message: "Bridge unreachable — unlocked with this device's saved session.",
          };
        }
        return {
          ok: false,
          offline: false,
          error:
            "Cannot reach the bridge, and this device has no saved session for that Employee Number. Connect once to sign in.",
          message: null,
        };
      }

      if (err instanceof HttpError) {
        return { ok: false, offline: false, error: err.message, message: null };
      }

      return {
        ok: false,
        offline: false,
        error: err instanceof Error ? err.message : "Unexpected sign-in error.",
        message: null,
      };
    }
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    await stopGeofenceTracking();
    if (current) {
      // Remove this phone from the Field Tracker immediately. Best effort and
      // bounded: signing out must not hang on a flaky connection.
      await Promise.race([
        clearPresence(
          { apiUrl: current.apiUrl, mobileKey: current.mobileKey },
          current.employee.erpUserId,
          current.deviceId ?? null
        ).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 4_000)),
      ]);
    }
    sessionRef.current = null;
    await writeSession(null);
    setSession(null);
    setTracking(null);
    setStatus("signed-out");
  }, []);

  const retryTracking = useCallback(async (): Promise<void> => {
    if (!session) return;
    setTracking(await startGeofenceTracking(session));
  }, [session]);

  const recordLocalPunch = useCallback(
    async (direction: "IN" | "OUT", time: number = Date.now()): Promise<void> => {
      const active = sessionRef.current;
      if (!active) return;
      const nextDayStatus: MobileDayStatus = {
        clockedIn: direction === "IN",
        lastPunchAt: time,
        lastDirection: direction,
      };
      const next: MobileSession = {
        ...active,
        dayStatus: nextDayStatus,
      };
      sessionRef.current = next;
      await writeSession(next);
      setSession(next);
    },
    []
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      tracking,
      initialApiUrl,
      deviceId,
      deviceName,
      signIn,
      signOut,
      retryTracking,
      refreshFences,
      recordLocalPunch,
    }),
    [
      status,
      session,
      tracking,
      initialApiUrl,
      deviceId,
      deviceName,
      signIn,
      signOut,
      retryTracking,
      refreshFences,
      recordLocalPunch,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth() must be used inside <AuthProvider>.");
  return context;
}
