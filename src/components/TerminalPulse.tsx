"use client";

import Link from "next/link";
import { formatRelative } from "@/lib/format";
import type { TerminalsResponse } from "@/lib/types";
import { usePoll } from "@/lib/use-poll";

/** Compact device strip on the dashboard — full table lives in Terminal Manager. */
export default function TerminalPulse() {
  const { data, loading } = usePoll<TerminalsResponse>("/api/terminals", 3000);
  const terminals = data?.terminals ?? [];
  const online = terminals.filter((t) => t.status === "Online").length;

  return (
    <section className="glass relative overflow-hidden">
      <div className="accent-line" aria-hidden="true" />
      <header className="flex items-center justify-between border-b border-white/[0.07] px-5 py-3.5">
        <h2 className="text-[11px] font-bold tracking-[0.24em] text-ink uppercase">
          Terminals
        </h2>
        <span
          className={`chip ${terminals.length > 0 && online === terminals.length ? "chip--neon" : "chip--warn"}`}
        >
          {loading ? "…" : `${online}/${terminals.length} online`}
        </span>
      </header>

      <ul className="divide-y divide-white/5">
        {loading && terminals.length === 0
          ? [0, 1, 2].map((i) => (
              <li key={i} className="h-[52px] animate-pulse bg-white/[0.03]" />
            ))
          : terminals.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-5 py-3">
                <span
                  className={`status-dot ${t.status === "Online" ? "status-dot--on" : "status-dot--off"}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-xs font-semibold text-ink">
                    {/* Branch badge — the scan's physical location cluster. */}
                    <span
                      className="flex-none rounded border border-neon/30 bg-panel-deep/70 px-1.5 py-px font-mono text-[9px] font-bold tracking-wider text-neon/90"
                      title="Branch this terminal serves"
                    >
                      {t.branch || "—"}
                    </span>
                    <span className="truncate">{t.location}</span>
                  </p>
                  <p className="font-mono text-[10px] text-muted">{t.ip}</p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-xs text-muted tabular-nums">
                    {t.scansToday} <span className="text-[10px]">SCANS</span>
                  </p>
                  <p className="text-[10px] text-muted/70">
                    {t.status === "Online" ? formatRelative(t.lastPing) : "offline"}
                  </p>
                </div>
              </li>
            ))}
      </ul>

      <div className="border-t border-white/[0.07] px-5 py-3">
        <Link
          href="/terminals"
          className="text-[11px] font-bold tracking-[0.16em] text-neon uppercase transition hover:text-white"
        >
          Manage devices →
        </Link>
      </div>
    </section>
  );
}
