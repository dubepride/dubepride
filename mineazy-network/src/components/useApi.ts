/**
 * ============================================================================
 *  useApi.ts — the polling hook every live screen uses
 * ============================================================================
 *
 *  The console is a live view of a running collector, so screens poll. The
 *  hook is deliberately boring: fetch, keep the last good payload, surface
 *  the error, and never clear the screen while a refresh is in flight (a
 *  flickering map is unreadable during a fault).
 * ============================================================================
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "./api";

export interface UseApiOptions {
  /** Poll interval in milliseconds. 0 (the default) means "fetch once". */
  pollMs?: number;
  /** Set to false to pause the fetches (e.g. while a form is open). */
  enabled?: boolean;
}

export interface UseApiResult<T> {
  data: T | null;
  error: string | null;
  /** True only for the very first load. */
  loading: boolean;
  /** True while any refresh is in flight. */
  refreshing: boolean;
  /** The epoch millisecond of the last successful load. */
  loadedAt: number | null;
  /** Force an immediate refresh. */
  reload: () => void;
}

/**
 * Fetch `path` and keep it fresh.
 *
 * Passing `null` disables the request entirely (useful while a route
 * parameter is still unknown).
 */
export function useApi<T>(path: string | null, options: UseApiOptions = {}): UseApiResult<T> {
  const { pollMs = 0, enabled = true } = options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);

  const active = Boolean(path) && enabled;

  useEffect(() => {
    if (!path || !enabled) return;

    let cancelled = false;

    const load = async (): Promise<void> => {
      setRefreshing(true);
      try {
        const result = await apiGet<T>(path);
        if (cancelled) return;
        setData(result);
        setError(null);
        setLoadedAt(Date.now());
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (cancelled) return;
        setRefreshing(false);
      }
    };

    void load();

    let timer: ReturnType<typeof setInterval> | null = null;
    if (pollMs > 0) {
      timer = setInterval(() => void load(), pollMs);
    }

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [path, enabled, pollMs, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // "Loading" means: a request is wanted and there is nothing to show yet.
  // It is derived rather than stored, so it can never get stuck on true.
  const loading = active && data === null && error === null;

  return { data, error, loading, refreshing, loadedAt, reload };
}
