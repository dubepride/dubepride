/**
 * ============================================================================
 *  usePendingQueue.ts — Offline Punch Queue with Automatic Network Sync
 * ============================================================================
 *
 *  The app auto-detects internet connectivity:
 *    • If the person clocked in whilst offline, punches are queued safely.
 *    • As soon as internet is detected, the app automatically syncs with the
 *      main system — the user never has to manually sync.
 *
 *  Network auto-detection triggers:
 *    1. Instant OS network recovery listener (expo-network).
 *    2. App foreground / resume listener (AppState).
 *    3. Periodic polling interval (10s) while pending punches exist.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import * as Network from "expo-network";

import { flushOfflineQueue } from "@/lib/api";
import { listQueued } from "@/lib/queue";
import type { MobileSession, QueuedPunch } from "@/lib/types";

/** How often the screen re-reads the queue count (AsyncStorage read). */
const POLL_MS = 4000;

/** Background backstop auto-sync cadence when items are queued. */
const AUTO_SYNC_INTERVAL_MS = 10_000;

export interface PendingQueueState {
  pending: QueuedPunch[];
  syncing: boolean;
  /** Status line from the last sync */
  message: string | null;
  error: string | null;
  /** True while an automatic sync is actively uploading */
  autoSyncing: boolean;
  refresh: () => Promise<void>;
  triggerAutoSync: () => Promise<void>;
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

  const inFlight = useRef(false);

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
   * Flushes queued punches to the bridge. Always automatic — never requires user action.
   */
  const flush = useCallback(
    async (): Promise<void> => {
      const active = sessionRef.current;
      if (!active || inFlight.current) return;

      const currentQueue = await listQueued();
      if (currentQueue.length === 0) return;

      inFlight.current = true;
      setAutoSyncing(true);
      setSyncing(true);

      try {
        const result = await flushOfflineQueue(active);
        if (result.sent > 0) {
          setMessage(`Auto-synced ${result.sent} offline punch${result.sent === 1 ? "" : "es"} to main system.`);
        } else {
          setMessage(result.message);
        }

        const blocked = result.details.find((detail) => !detail.ok && detail.reason);
        if (blocked) {
          setError(blocked.message);
        } else if (result.remaining === 0) {
          setError(null);
        }
      } catch (err) {
        // Still offline: quiet fail, will retry automatically when internet returns
      } finally {
        inFlight.current = false;
        setAutoSyncing(false);
        setSyncing(false);
        await refresh();
      }
    },
    [refresh]
  );

  const triggerAutoSync = useCallback(async (): Promise<void> => {
    const state = await Network.getNetworkStateAsync().catch(() => null);
    if (state && state.isConnected && state.isInternetReachable !== false) {
      await flush();
    }
  }, [flush]);

  // Automatic internet detection
  useEffect(() => {
    if (!session) return;

    let cancelled = false;

    const checkAndSync = async (): Promise<void> => {
      if (cancelled) return;
      const state = await Network.getNetworkStateAsync().catch(() => null);
      if (state && state.isConnected && state.isInternetReachable !== false) {
        await flush();
      }
    };

    // Instant Wi-Fi / Cellular network recovery
    const networkSub = Network.addNetworkStateListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) {
        void checkAndSync();
      }
    });

    // App coming back from background
    const appSub = AppState.addEventListener("change", (status) => {
      if (status === "active") void checkAndSync();
    });

    // Periodic backstop check
    const timer = setInterval(() => {
      void checkAndSync();
    }, AUTO_SYNC_INTERVAL_MS);

    // Initial check on mount
    void checkAndSync();

    return () => {
      cancelled = true;
      networkSub.remove();
      appSub.remove();
      clearInterval(timer);
    };
  }, [session, flush]);

  return { pending, syncing, message, error, autoSyncing, refresh, triggerAutoSync };
}
