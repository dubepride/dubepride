"use client";

import Link from "next/link";
import { formatRelative } from "@/lib/format";
import type { ErpSyncGetResponse } from "@/lib/types";
import { usePoll } from "@/lib/use-poll";
import { IconSync } from "./icons";

/** ERP buffer widget — shows what is queued for the external ERP right now. */
export default function SyncMini() {
  const { data, loading } = usePoll<ErpSyncGetResponse>("/api/erp/sync", 5000);
  const stats = data?.stats;
  const pending = stats?.pendingLogs ?? 0;

  return (
    <section className="glass relative overflow-hidden">
      <div className="accent-line" aria-hidden="true" />
      <header className="flex items-center justify-between border-b border-white/[0.07] px-5 py-3.5">
        <h2 className="text-[11px] font-bold tracking-[0.24em] text-ink uppercase">
          ERP Sync
        </h2>
        <span className={`chip ${data?.mode === "live" ? "chip--neon" : "chip--muted"}`}>
          {data ? (data.mode === "live" ? "LIVE ERP" : "ERP SIMULATOR") : "…"}
        </span>
      </header>

      <div className="px-5 py-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold tracking-[0.18em] text-muted uppercase">
              Pending buffer
            </p>
            <p
              className={`mt-1 text-4xl font-bold tabular-nums ${
                loading ? "text-muted" : pending > 0 ? "text-warn" : "text-neon"
              }`}
            >
              {loading ? "––" : pending}
            </p>
          </div>
          <span
            className={`grid h-11 w-11 place-items-center rounded-xl border ${
              pending > 0
                ? "border-warn/40 bg-warn/10 text-warn"
                : "border-neon/40 bg-neon/10 text-neon"
            }`}
          >
            <IconSync className="h-5 w-5" />
          </span>
        </div>

        <div className="mt-4 space-y-1.5 border-t border-white/[0.07] pt-3 text-xs">
          <p className="flex items-center justify-between gap-2">
            <span className="text-muted">Last push</span>
            <span className="font-mono text-ink">
              {stats?.lastBatchAt ? formatRelative(stats.lastBatchAt) : "never"}
            </span>
          </p>
          <p className="flex items-center justify-between gap-2">
            <span className="text-muted">Synced today</span>
            <span className="font-mono text-neon">{stats?.syncedToday ?? "––"}</span>
          </p>
          <p className="flex items-center justify-between gap-2">
            <span className="text-muted">Failed batches</span>
            <span
              className={`font-mono ${stats && stats.failedBatches > 0 ? "text-danger" : "text-ink"}`}
            >
              {stats?.failedBatches ?? "––"}
            </span>
          </p>
        </div>
      </div>

      <div className="border-t border-white/[0.07] px-5 py-3">
        <Link
          href="/sync"
          className="text-[11px] font-bold tracking-[0.16em] text-neon uppercase transition hover:text-white"
        >
          Open sync console →
        </Link>
      </div>
    </section>
  );
}
