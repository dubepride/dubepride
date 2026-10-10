"use client";

import { IconArrow } from "@/components/icons";
import { formatClockTime } from "@/lib/format";
import type { FeedEntry } from "@/lib/types";

/**
 * Recent Clocking Activity (Phase 11) — the dashboard's compact punch log.
 *
 * Columns: Time · Employee · Action (Clock In / Clock Out) · Status.
 * Fed by the same 2.5s dashboard poll as the metric tiles, so rows refresh
 * with the rest of the page. Newest punch first; 8 rows max.
 */

const ROWS = 8;

function StatusChip({ entry }: { entry: FeedEntry }) {
  if (!entry.registered) {
    return <span className="chip chip--warn">Unregistered ID</span>;
  }
  if (entry.verifyResult !== "Verified") {
    return <span className="chip chip--danger">Denied</span>;
  }
  return <span className="chip chip--neon">Verified</span>;
}

export default function RecentActivity({
  entries,
  loading = false,
}: {
  entries: FeedEntry[];
  loading?: boolean;
}) {
  const rows = entries.slice(0, ROWS);

  return (
    <section className="glass relative flex flex-col overflow-hidden">
      <div className="accent-line" aria-hidden="true" />

      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-5 py-4">
        <div>
          <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">
            Recent Clocking Activity
          </h2>
          <p className="mt-1 text-[11px] text-muted">Latest punches captured by the bridge</p>
        </div>
        <span className="chip chip--neon">
          <span className="status-dot status-dot--on" aria-hidden="true" />
          Live
        </span>
      </header>

      <div className="scroll-thin min-h-[264px] flex-1 overflow-x-auto">
        {loading && rows.length === 0 ? (
          <div className="grid h-[264px] place-items-center">
            <span className="spinner" aria-label="Loading recent activity" />
          </div>
        ) : rows.length === 0 ? (
          <div className="grid h-[264px] place-items-center px-6 text-center">
            <div>
              <p className="text-xs font-semibold tracking-[0.16em] text-muted uppercase">
                No clocking activity yet
              </p>
              <p className="mt-1 text-[11px] text-muted/70">
                Punches appear here the moment a terminal reports them.
              </p>
            </div>
          </div>
        ) : (
          <table className="w-full min-w-[520px] border-collapse">
            <thead className="tbl-head">
              <tr>
                <th>Time</th>
                <th>Employee</th>
                <th>Action</th>
                <th className="text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.logId} className="tbl-row transition-colors">
                  <td className="font-mono text-xs text-muted tabular-nums">
                    {formatClockTime(new Date(e.timestamp))}
                  </td>
                  <td>
                    <span
                      className={`block text-xs font-semibold ${
                        e.registered ? "text-ink" : "text-warn"
                      }`}
                    >
                      {e.employeeName}
                    </span>
                    <span className="block font-mono text-[10px] text-muted">
                      {e.erpUserId ?? "—"}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`chip ${e.direction === "IN" ? "chip--neon" : "chip--muted"}`}
                    >
                      <IconArrow direction={e.direction} />
                      {e.direction === "IN" ? "Clock In" : "Clock Out"}
                    </span>
                  </td>
                  <td>
                    <div className="flex justify-end">
                      <StatusChip entry={e} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
