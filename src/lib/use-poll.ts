"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface PollState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Re-fetch immediately (e.g. after a Force Sync POST). */
  refresh: () => void;
}

/**
 * Tiny polling client used by every live panel.
 *
 * - fetches immediately on mount, then on a fixed interval
 * - skips ticks while a request is still in flight (slow bridge = no pile-up)
 * - de-duplicates rapid `refresh()` calls via a nonce
 * - swallows results from unmounted/stale effects
 */
export function usePoll<T>(url: string, intervalMs = 3000): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const inFlight = useRef(false);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as T;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        inFlight.current = false;
        if (!cancelled) setLoading(false);
      }
    };

    void tick();
    const id = setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [url, intervalMs, nonce]);

  return { data, error, loading, refresh };
}
