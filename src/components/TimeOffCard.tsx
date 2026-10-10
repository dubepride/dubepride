"use client";

import { useState } from "react";
import Avatar from "@/components/Avatar";
import WidgetShell from "@/components/WidgetShell";
import { TIME_OFF_REQUESTS, type TimeOffRequest } from "@/lib/dashboard-mock";

/** Single-day requests collapse to their lone label instead of an arrow. */
function rangeLabel(r: TimeOffRequest): string {
  return r.fromLabel === r.toLabel ? r.fromLabel : `${r.fromLabel} → ${r.toLabel}`;
}

/**
 * Widget D — Time Off Requests (bottom right).
 *
 * Pending requests with per-row Approve (green outline) / Deny (red
 * outline) actions. Seeded from mock data so it renders fully populated
 * on first paint; deciding removes the row and updates the pending chip
 * (with an all-clear empty state).
 */
export default function TimeOffCard() {
  const [requests, setRequests] = useState<TimeOffRequest[]>(TIME_OFF_REQUESTS);

  function decide(id: number) {
    setRequests((rs) => rs.filter((r) => r.id !== id));
  }

  return (
    <WidgetShell
      title="Time Off Requests"
      meta={
        <span className={requests.length > 0 ? "chip chip--warn" : "chip chip--neon"}>
          {requests.length > 0 ? `${requests.length} pending` : "All clear"}
        </span>
      }
      bodyClassName="p-0"
    >
      {requests.length === 0 ? (
        <p className="rise flex items-center justify-center gap-2 px-5 py-10 text-sm text-muted">
          <span className="text-neon">✓</span> All requests handled — nothing pending.
        </p>
      ) : (
        <ul className="divide-y divide-white/5">
          {requests.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center gap-3 px-5 py-3.5"
            >
              <Avatar name={r.name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-ink">
                  {r.name}
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-2">
                  <span className="chip chip--muted">
                    {r.hours} Hr(s) {r.type}
                  </span>
                  <span className="font-mono text-[11px] text-muted">
                    {rangeLabel(r)}
                  </span>
                </span>
              </span>
              <span className="flex flex-none gap-2">
                <button
                  type="button"
                  onClick={() => decide(r.id)}
                  className="rounded-lg border border-neon/50 bg-neon/[0.06] px-3.5 py-1.5 text-[11px] font-bold tracking-[0.12em] text-neon uppercase transition hover:bg-neon/15 hover:shadow-[0_0_12px_rgba(0,230,118,0.25)]"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => decide(r.id)}
                  className="rounded-lg border border-danger/50 bg-danger/[0.06] px-3.5 py-1.5 text-[11px] font-bold tracking-[0.12em] text-danger uppercase transition hover:bg-danger/15 hover:shadow-[0_0_12px_rgba(255,82,82,0.22)]"
                >
                  Deny
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </WidgetShell>
  );
}
