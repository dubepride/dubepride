/**
 * ============================================================================
 *  usePendingQueue.ts — the dashboard's window onto the offline queue
 * ============================================================================
 *
 *  The queue is written by a headless background context, so the UI cannot be
 *  event-driven: it polls. A short interval (5 s) is plenty — a punch that
 *  just failed should show up in front of the employee almost immediately.
 */

import { useCallback, useEffect, useState } from "react";

import { flushOfflineQueue } from "@/lib/api";
import { listQueued } from "@/lib/queue";
import type { MobileSession, QueuedPunch } from "@/lib/types";

export interface PendingQueueState {
  pending: QueuedPunch[];
  syncing: boolean;
  /** Result line from the last flush — success or "still offline". */
  message: string | null;
  error: string | null;
  refresh: () => Promise<void>;
  syncNow: () => Promise<void>;
}

export function usePendingQueue(
  session: MobileSession | null,
  pollMs = 5000
): PendingQueueState {
  const [pending, setPending] = useState<QueuedPunch[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const syncNow = useCallback(async (): Promise<void> => {
    if (!session) return;
    setSyncing(true);
    setError(null);
    try {
      const result = await flushOfflineQueue(session);
      setMessage(result.message);
      // Surface anything that stayed queued with a reason worth showing.
      const blocked = result.details.find((detail) => !detail.ok && detail.reason);
      if (blocked) setError(blocked.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setSyncing(false);
      await refresh();
    }
  }, [session, refresh]);

  return { pending, syncing, message, error, refresh, syncNow };
}
