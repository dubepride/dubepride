/**
 * ============================================================================
 *  auth.tsx — who is signed in, and what they may do
 * ============================================================================
 *
 *  The console asks the server who it is (`/api/auth/me`) and keeps that
 *  answer in one place. The `can()` helper hides controls a role cannot use
 *  — but it is a COURTESY, not a security boundary: every API handler
 *  re-checks the permission server-side.
 * ============================================================================
 */

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost } from "./api";
import type { PermissionKey } from "@/lib/rbac";
import type { UserRole } from "@/lib/types";

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  email: string;
  role: UserRole;
  permissions: Partial<Record<PermissionKey, boolean>>;
}

interface AuthValue {
  user: SessionUser | null;
  loading: boolean;
  /** True when the signed-in role holds the capability. */
  can: (permission: PermissionKey) => boolean;
  signOut: () => Promise<void>;
  reload: () => void;
}

const AuthContext = createContext<AuthValue>({
  user: null,
  loading: true,
  can: () => false,
  signOut: async () => {},
  reload: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const result = await apiGet<{ user: SessionUser }>("/api/auth/me");
        if (cancelled) return;
        setUser(result.user);
      } catch {
        if (cancelled) return;
        setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const signOut = useCallback(async () => {
    try {
      await apiPost("/api/auth/logout");
    } catch {
      // The cookie is cleared by the server; a failure here is not fatal.
    }
    setUser(null);
    router.push("/login");
    router.refresh();
  }, [router]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      loading,
      can: (permission) => user?.permissions?.[permission] === true,
      signOut,
      reload,
    }),
    [user, loading, signOut, reload]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** The signed-in account and its capabilities. */
export function useAuth(): AuthValue {
  return useContext(AuthContext);
}
