/**
 * ============================================================================
 *  usePendingQueue.ts — the dashboard's window onto the offline queue
 * ============================================================================
 *
 *  The queue is written by a headless background context, so the UI cannot be
 *  event-driven: it polls. A short interval (5 s) is plenty — a punch that
 *  just failed should show up in front of the employee almost immediately.
 *
 *  Automatic replay
 *  ----------------
 *  Punches are never lost while offline, but leaving them on the device until
 *  someone taps "Sync Now" is not good enough. The queue is therefore flushed
 *  automatically — silently, without stealing the button's spinner — whenever:
 *
 *    • the OS reports the network coming back (expo-network listener),
 *    • the app returns to the foreground (a phone that was asleep in a dead
 *      spot is usually online again by then), or
 *    • a 20 s backstop interval fires while the screen is open.
 *
 *  A transport failure aborts the walk inside `flushQueue`, so a still-offline
 *  phone costs one request every 20 s, not a storm.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import * as Network from "expo-network";

import { flushOfflineQueue } from "@/lib/api";
import { listQueued } from "@/lib/queue";
import type { MobileSession, QueuedPunch } from "@/lib/types";

/** How often the screen re-reads the queue (cheap AsyncStorage read). */
const POLL_MS = 5000;

/** Backstop replay attempt while the app is open. */
const AUTO_SYNC_MS = 20_000;

export interface PendingQueueState {
  pending: QueuedPunch[];
  syncing: boolean;
  /** Result line from the last flush — success or "still offline". */
  message: string | null;
  error: string | null;
  /** True while an automatic (non-button) flush is in flight. */
  autoSyncing: boolean;
  refresh: () => Promise<void>;
  syncNow: () => Promise<void>;
}

export function usePendingQueue(
  session: MobileSession | null,
  pollMs = POLL_MS
): PendingQueueState {
  const [pending, setPending] = useState<QueuedPunch[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [autoSyncing, setAutoSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Guards against the poll timer, the network listener and the button all
  // starting a flush at the same moment.
  const inFlight = useRef(false);

  // The listeners are registered once per session; reading the session from a
  // ref keeps them from re-subscribing every time the object identity changes.
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const refresh = useCallback(async (): Promise<void> => {
    setPending(await listQueued());
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  /**
   * One flush attempt. `silent` = automatic replay: no spinner on the button,
   * and no error text for the ordinary "still offline" case.
   */
  const flush = useCallback(
    async (silent: boolean): Promise<void> => {
      const active = sessionRef.current;
      if (!active || inFlight.current) return;

      // Nothing queued — don't touch the network at all.
      if ((await listQueued()).length === 0) return;

      inFlight.current = true;
      if (silent) setAutoSyncing(true);
      else {
        setSyncing(true);
        setError(null);
      }

      try {
        const result = await flushOfflineQueue(active);
        setMessage(result.message);

        // Surface anything that stayed queued with a reason worth showing.
        const blocked = result.details.find((detail) => !detail.ok && detail.reason);
        if (blocked) setError(blocked.message);
        else if (!silent && result.remaining === 0) setError(null);
      } catch (err) {
        // A silent attempt that fails because we are still offline is normal.
        if (!silent) {
          setError(err instanceof Error ? err.message : "Sync failed.");
        }
      } finally {
        inFlight.current = false;
        if (silent) setAutoSyncing(false);
        else setSyncing(false);
        await refresh();
      }
    },
    [refresh]
  );

  const syncNow = useCallback(async (): Promise<void> => {
    await flush(false);
  }, [flush]);

  // Automatic replay: connectivity regained, app foregrounded, or backstop.
  useEffect(() => {
    if (!session) return;

    let cancelled = false;

    const attempt = async (): Promise<void> => {
      if (cancelled) return;
      // Confirm the radio really is usable before spending a request.
      const state = await Network.getNetworkStateAsync().catch(() => null);
      if (state && state.isConnected === false) return;
      if (state && state.isInternetReachable === false) return;
      await flush(true);
    };

    // Fires the instant Wi-Fi/mobile data comes back.
    const networkSub = Network.addNetworkStateListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) {
        void attempt();
      }
    });

    // A phone that slept in a dead spot is usually online again on wake.
    const appSub = AppState.addEventListener("change", (status) => {
      if (status === "active") void attempt();
    });

    const timer = setInterval(() => {
      void attempt();
    }, AUTO_SYNC_MS);

    // Try once on mount (covers "reopened the app after a dead zone").
    void attempt();

    return () => {
      cancelled = true;
      networkSub.remove();
      appSub.remove();
      clearInterval(timer);
    };
  }, [session, flush]);

  return { pending, syncing, message, error, autoSyncing, refresh, syncNow };
}
