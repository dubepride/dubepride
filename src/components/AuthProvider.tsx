"use client";

/**
 * ============================================================================
 *  AuthProvider / useAuth — client access to the signed-in account's matrix
 * ============================================================================
 *
 *  Phase 14: every permission-sensitive piece of UI reads the logged-in
 *  System Account's permission matrix through this context:
 *
 *    const { can } = useAuth();
 *    can("can_view_my_portal")  → true | false
 *
 *  The matrix is fetched from GET /api/auth/me (server-resolved from the
 *  account's Access_Level) and refreshed on mount, after login/logout
 *  (`biobridge:auth` event), on back/forward navigation and on a light
 *  polling cadence so a matrix edit made by the IT admin propagates to
 *  already-open sessions.
 *
 *  Important: this module deliberately does NOT call usePathname() — the
 *  provider wraps the whole app including dynamic routes (/employees/[id]),
 *  where usePathname suspends during streaming. All location reads happen
 *  inside effects on window.location instead, so the provider never blocks
 *  the app shell.
 *
 *  While `status === "loading"` the sidebar renders no privileged nav links,
 *  so a restricted account never sees a flash of items it cannot use.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { allPermissions, type PermissionKey, type PermissionsMap } from "@/lib/rbac";
import type { MeAccount, MeResponse } from "@/lib/types";

export interface AuthState {
  /** "loading" until the first /api/auth/me response settles. */
  status: "loading" | "ready";
  account: MeAccount | null;
  permissions: PermissionsMap | null;
  /** Convenience gate — `permissions[perm] === true` with a null-safe short-circuit. */
  can: (perm: PermissionKey) => boolean;
}

const NO_PERMS = allPermissions(false);

const DEFAULT_STATE: AuthState = {
  status: "loading",
  account: null,
  permissions: null,
  can: () => false,
};

const AuthContext = createContext<AuthState>(DEFAULT_STATE);

/** Read the signed-in account's identity + permissions (sidebar, settings…). */
export function useAuth(): AuthState {
  return useContext(AuthContext);
}

/** Refresh cadence (ms) — matches the app's existing usePoll heartbeat. */
const REFRESH_MS = 6000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [account, setAccount] = useState<MeAccount | null>(null);
  const [permissions, setPermissions] = useState<PermissionsMap | null>(null);
  // Guards against overlapping refetches when several triggers fire at once.
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      let json: MeResponse | null = null;
      try {
        json = (await res.json()) as MeResponse;
      } catch {
        json = null;
      }
      if (res.ok && json?.ok && json.account) {
        setAccount(json.account);
        setPermissions(json.permissions ?? NO_PERMS);
      } else {
        // No valid session (login wall) or mid-sign-out — drop to anonymous.
        setAccount(null);
        setPermissions(null);
      }
    } catch {
      // Network hiccup vs. the auth endpoint — keep the previous state so
      // the app never blanks out on a transient fetch error.
      setAccount((prev) => prev);
      setPermissions((prev) => prev);
    } finally {
      inFlight.current = false;
      setStatus("ready");
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());

    const refresh = () => void load();
    // Login / logout flows signal us right at the navigation boundary.
    window.addEventListener("biobridge:auth", refresh);
    // Back/forward through the history (new page = maybe new account).
    window.addEventListener("popstate", refresh);
    // Returning to the tab re-checks without waiting for the next tick.
    window.addEventListener("focus", refresh);
    const id = window.setInterval(refresh, REFRESH_MS);

    return () => {
      window.removeEventListener("biobridge:auth", refresh);
      window.removeEventListener("popstate", refresh);
      window.removeEventListener("focus", refresh);
      window.clearInterval(id);
    };
  }, [load]);

  const can = useCallback(
    (perm: PermissionKey): boolean => permissions?.[perm] === true,
    [permissions]
  );

  return (
    <AuthContext.Provider value={{ status, account, permissions, can }}>
      {children}
    </AuthContext.Provider>
  );
}