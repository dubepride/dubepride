"use client";

import { formatFeedTime, initials } from "@/lib/format";
import type { FeedEntry } from "@/lib/types";
import { IconArrow } from "./icons";

interface LiveFeedProps {
  entries: FeedEntry[];
  loading: boolean;
  error: string | null;
}

/**
 * Live Scan Feed — newest punch first.
 *
 * Rows are keyed by Log_ID, so when polling swaps the list only genuinely
 * new entries mount, which triggers the `.feed-enter` slide/glow animation
 * exactly once per punch.
 */
export default function LiveFeed({ entries, loading, error }: LiveFeedProps) {
  return (
    <section className="glass relative flex min-h-[420px] flex-col overflow-hidden">
      <div className="accent-line" aria-hidden="true" />

      {/* Header ------------------------------------------------------- */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-5 py-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">
            Live Scan Feed
          </h2>
          <span className="chip chip--neon">
            <span className="status-dot status-dot--on" />
            Streaming
          </span>
        </div>
        <span className="font-mono text-[11px] tracking-wider text-muted">
          {entries.length} EVENTS · AUTO-REFRESH 2.5s
        </span>
      </header>

      {/* Body --------------------------------------------------------- */}
      <div className="scroll-thin flex-1 overflow-y-auto">
        {loading && entries.length === 0 ? (
          <ul className="animate-pulse divide-y divide-white/5">
            {[0, 1, 2, 3, 4].map((i) => (
              <li key={i} className="flex items-center gap-3 px-5 py-4">
                <div className="h-9 w-9 rounded-full bg-white/10" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-1/3 rounded bg-white/10" />
                  <div className="h-2.5 w-1/2 rounded bg-white/[0.06]" />
                </div>
                <div className="h-5 w-16 rounded bg-white/10" />
              </li>
            ))}
          </ul>
        ) : entries.length === 0 ? (
          <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="status-dot status-dot--warn h-3! w-3!" />
            <p className="text-sm font-semibold text-ink">Awaiting first scan</p>
            <p className="max-w-xs text-xs leading-relaxed text-muted">
              The terminal listener is armed — punches pushed to{" "}
              <span className="font-mono text-neon">/api/biometrics/push</span> will
              appear here instantly.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-white/5">
            {entries.map((e) => {
              const denied = e.verifyResult === "Denied";
              return (
                <li key={e.logId} className="feed-enter flex items-center gap-3 px-5 py-3.5">
                  {/* Avatar */}
                  <span
                    className={`grid h-9 w-9 flex-none place-items-center rounded-full border text-[11px] font-bold ${
                      denied
                        ? "border-danger/50 bg-danger/10 text-danger"
                        : e.registered
                          ? "border-neon/50 bg-panel-deep text-neon"
                          : "border-warn/50 bg-warn/10 text-warn"
                    }`}
                  >
                    {initials(e.employeeName)}
                  </span>

                  {/* Identity + origin */}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink">
                      {e.employeeName}
                      {e.erpUserId ? (
                        <span className="ml-2 font-mono text-[10px] font-normal text-muted">
                          {e.erpUserId}
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted">
                      {/* Sequence # of this punch within the working day —
                          makes the In → Out → In → Out order explicit. */}
                      {e.daySeq !== null ? (
                        <span
                          className="flex-none font-mono text-[10px] font-bold text-muted/80"
                          title={`Punch #${e.daySeq} of this employee's working day`}
                        >
                          #{e.daySeq}
                        </span>
                      ) : null}
                      <IconArrow direction={e.direction} />
                      <span className={e.direction === "IN" ? "text-neon/80" : "text-muted"}>
                        {e.direction}
                      </span>
                      <span className="opacity-40">·</span>
                      {/* Branch where the scan physically took place. */}
                      {e.branchName ? (
                        <span
                          className="flex-none rounded border border-neon/30 bg-panel-deep/70 px-1.5 py-px font-mono text-[9px] font-bold tracking-wider text-neon/90"
                          title={`Scanned at ${e.branchName}`}
                        >
                          {e.branchName}
                        </span>
                      ) : null}
                      <span className="truncate">{e.location}</span>
                    </p>
                  </div>

                  {/* Time + verification + sync state */}
                  <div className="flex flex-none flex-col items-end gap-1.5">
                    <time
                      dateTime={new Date(e.timestamp).toISOString()}
                      className="font-mono text-sm font-semibold text-neon tabular-nums"
                    >
                      {formatFeedTime(e.timestamp)}
                    </time>
                    <div className="flex items-center gap-1.5">
                      <span className={`chip ${denied ? "chip--danger" : "chip--neon"}`}>
                        {denied ? "Denied" : "✓ Verified"}
                      </span>
                      <span
                        className={`chip ${
                          e.syncStatus === "Pending"
                            ? "chip--warn"
                            : e.syncStatus === "Failed"
                              ? "chip--danger"
                              : "chip--muted"
                        }`}
                        title={`ERP sync status: ${e.syncStatus}`}
                      >
                        {e.syncStatus === "Success" ? "Synced" : e.syncStatus}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Error ticker — data keeps rendering even when a poll fails. */}
      {error ? (
        <p className="border-t border-danger/30 bg-danger/10 px-5 py-2 text-[11px] tracking-wider text-danger">
          BRIDGE LINK DEGRADED — {error} (retrying…)
        </p>
      ) : null}
    </section>
  );
}
