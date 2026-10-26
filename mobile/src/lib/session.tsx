/**
 * ============================================================================
 *  session.ts — the authenticated session, and the app's only context
 * ============================================================================
 *
 *  As small as a context can be: who you are, which registered sites the phone
 *  may clock you in at, and whether the background tasks are running.
 *  Everything the background tasks need is ALSO persisted to SecureStore,
 *  because a React context cannot be read from a headless JS context — the
 *  store, not this provider, is what the background engine relies on.
 *
 *  Offline behaviour: sign-in normally requires the bridge, because only the
 *  bridge can verify the PIN and say where the employee's fence is. If the
 *  bridge is unreachable but this device already holds a verified session for
 *  the SAME employee and the same PIN, the app unlocks against that cached
 *  session and flags itself `offline`. Punches still work — they queue.
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
  configuredApiUrl,
  configuredHandsFree,
  configuredMobileKey,
  HttpError,
  login as loginRequest,
  NetworkError,
  normaliseApiUrl,
} from "./api";
import {
  readPin,
  readSavedApiUrl,
  readSession,
  writePin,
  writeSavedApiUrl,
  writeSession,
} from "./storage";
import type { MobileSession } from "./types";
import {
  startGeofenceTracking,
  stopGeofenceTracking,
  type TrackingResult,
} from "@/tasks/geofenceTask";

export type AuthStatus = "restoring" | "signed-in" | "signed-out";

export interface SignInInput {
  employeeId: string;
  pin: string;
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
  /** Outcome of the last attempt to arm the background tasks. */
  tracking: TrackingResult | null;
  /** Last base URL that worked — pre-fills the login screen. */
  initialApiUrl: string;
  signIn: (input: SignInInput) => Promise<SignInOutcome>;
  signOut: () => Promise<void>;
  /** Re-arm the background tasks after the employee fixes a permission. */
  retryTracking: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Arm the background geofencing tasks only when hands-free clocking is
 * enabled in app.json (`extra.handsFree === true`). With it off the app is
 * button-only, needs no background location, and never schedules a persisted
 * geofencing job.
 */
async function maybeStartTracking(session: MobileSession): Promise<TrackingResult | null> {
  if (!configuredHandsFree()) return null;
  try {
    return await startGeofenceTracking(session);
  } catch {
    return null;
  }
}

/** Does a cached session belong to the ID the employee just typed? */
function matchesEmployee(session: MobileSession, ref: string): boolean {
  const value = ref.trim().toLowerCase();
  if (!value) return false;
  const erp = session.employee.erpUserId.toLowerCase();
  const erpDigits = erp.replace(/^erp-/, "");
  const id = String(session.employee.employeeId);
  return value === erp || value === erpDigits || value === id || value === `erp-${id}`;
}

export function AuthProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [status, setStatus] = useState<AuthStatus>("restoring");
  const [session, setSession] = useState<MobileSession | null>(null);
  const [tracking, setTracking] = useState<TrackingResult | null>(null);
  const [initialApiUrl, setInitialApiUrl] = useState<string>(() => configuredApiUrl());

  // Restore a previous session on launch, and re-arm the background tasks —
  // they do not survive a process restart on their own.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const savedUrl = await readSavedApiUrl();
      if (!cancelled && savedUrl) setInitialApiUrl(savedUrl);

      const restored = await readSession();
      if (cancelled) return;
      setSession(restored);
      setStatus(restored ? "signed-in" : "signed-out");

      if (restored) {
        const result = await maybeStartTracking(restored);
        if (!cancelled) setTracking(result);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (input: SignInInput): Promise<SignInOutcome> => {
    const base = normaliseApiUrl(input.apiUrl) || configuredApiUrl();
    const mobileKey = configuredMobileKey();

    try {
      const result = await loginRequest({
        employeeId: input.employeeId,
        pin: input.pin,
        apiUrl: base,
        mobileKey,
      });

      const next: MobileSession = {
        employee: result.employee,
        // Phase 17 — the phone watches every registered site, because an
        // employee may travel and clock in wherever they are.
        fences: result.fences ?? [],
        geofence: result.geofence,
        apiUrl: base,
        mobileKey,
        signedInAt: Date.now(),
        offline: false,
      };
      await writeSession(next);
      await writePin(input.pin);
      await writeSavedApiUrl(base);

      setSession(next);
      setStatus("signed-in");
      setTracking(await maybeStartTracking(next));

      return { ok: true, offline: false, error: null, message: result.message };
    } catch (err) {
      // ── Offline: fall back to the session already verified on this device ──
      if (err instanceof NetworkError) {
        const cached = await readSession();
        const cachedPin = await readPin();
        if (cached && cachedPin === input.pin && matchesEmployee(cached, input.employeeId)) {
          const next: MobileSession = { ...cached, apiUrl: base, offline: true };
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
            "Cannot reach the bridge, and this device has no saved session for that ID. Connect once to sign in.",
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
    await stopGeofenceTracking();
    await writeSession(null);
    setSession(null);
    setTracking(null);
    setStatus("signed-out");
  }, []);

  const retryTracking = useCallback(async (): Promise<void> => {
    if (!session || !configuredHandsFree()) return;
    setTracking(await startGeofenceTracking(session));
  }, [session]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, session, tracking, initialApiUrl, signIn, signOut, retryTracking }),
    [status, session, tracking, initialApiUrl, signIn, signOut, retryTracking]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth() must be used inside <AuthProvider>.");
  return context;
}
