"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import Avatar from "@/components/Avatar";
import { IconX } from "@/components/icons";
import {
  EXCEPTION_EMPTY,
  EXCEPTION_LABELS,
  EXCEPTION_RULES,
} from "@/lib/exception-meta";
import { formatTime12 } from "@/lib/format";
import type { ExceptionRow, ExceptionType } from "@/lib/types";

/**
 * Right-hand slide-out drawer for the dashboard's Exceptions widget
 * (Phase 4). One instance per drill-down: the parent keeps it mounted
 * once a box has been clicked so the panel can animate both ways, and
 * drives `open` (which also owns Escape, scroll lock and focus restore).
 *
 * Backdrop is a blurred veil — the dashboard behind it stays recognisable,
 * so drill-down never feels like navigating away.
 */

/** Variance badge skin — green early, amber late, red structural gap. */
export const BADGE = {
  neon: "border-neon/40 bg-neon/10 text-neon",
  warn: "border-warn/40 bg-warn/10 text-warn",
  danger: "border-danger/40 bg-danger/10 text-danger",
} as const;

/** Ready-to-render badge text + skin for one row (shared with /exceptions). */
export function varianceBadge(row: ExceptionRow): { text: string; skin: string } {
  if (row.note === "no_punch") return { text: "No punch recorded", skin: BADGE.danger };
  if (row.note === "missing_in") return { text: "Missing IN punch", skin: BADGE.danger };
  if (row.note === "missing_out") return { text: "Missing OUT punch", skin: BADGE.danger };

  const v = row.varianceMin ?? 0;
  const abs = Math.abs(v);
  const span =
    abs < 60 ? `${abs} mins` : `${Math.floor(abs / 60)}h ${String(abs % 60).padStart(2, "0")}m`;
  return {
    text: `${v < 0 ? "-" : "+"}${span} ${v < 0 ? "early" : "late"}`,
    skin: v < 0 ? BADGE.neon : BADGE.warn,
  };
}

/** Pulse rows shown while the API round-trip is in flight. */
function Skeleton() {
  return (
    <div role="status" aria-live="polite" className="space-y-3">
      <span className="sr-only">Loading exception records…</span>
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="flex animate-pulse items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3"
        >
          <span className="h-9 w-9 flex-none rounded-full bg-white/10" />
          <span className="flex-1 space-y-2">
            <span className="block h-3 w-1/3 rounded bg-white/10" />
            <span className="block h-2.5 w-1/4 rounded bg-white/[0.07]" />
          </span>
          <span className="hidden h-5 w-24 rounded bg-white/10 sm:block" />
          <span className="h-5 w-20 flex-none rounded bg-white/10" />
        </div>
      ))}
    </div>
  );
}

/** Fetch failed — say so and offer a retry without closing the drawer. */
function ErrorState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-danger/40 bg-danger/10 p-6 text-center">
      <p className="text-sm font-bold text-danger">Couldn’t load exception records</p>
      <p className="mt-1 text-xs text-muted">{error}</p>
      <button type="button" onClick={onRetry} className="btn btn--ghost mt-4">
        Retry
      </button>
    </div>
  );
}

/** Bucket is legitimately empty — explain the baseline that produced it. */
function EmptyState({ type }: { type: ExceptionType }) {
  const isSunday = new Date().getDay() === 0;
  return (
    <div className="rounded-xl border border-dashed border-white/15 bg-white/[0.03] px-6 py-10 text-center">
      <p className="text-sm font-semibold text-ink">No matching employees</p>
      <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted">
        {isSunday
          ? "Sunday · the bridge classifies exceptions Monday–Saturday."
          : EXCEPTION_EMPTY[type]}
      </p>
    </div>
  );
}

/** Result table: Employee · Branch · Timestamp · Variance · Action. */
function RowTable({
  rows,
  onNavigate,
}: {
  rows: ExceptionRow[];
  onNavigate: () => void;
}) {
  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left">
        <thead className="tbl-head">
          <tr>
            <th scope="col">Employee</th>
            <th scope="col">Branch</th>
            <th scope="col">Timestamp</th>
            <th scope="col">Variance</th>
            <th scope="col" className="text-right">
              Action
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const badge = varianceBadge(row);
            return (
              <tr key={row.employeeId} className="tbl-row transition-colors">
                <td>
                  <span className="flex items-center gap-3">
                    <Avatar name={row.fullName} tone={row.timestamp === null ? "muted" : "neon"} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-ink">
                        {row.fullName}
                      </span>
                      <span className="block truncate text-[11px] text-muted">
                        {row.erpUserId} · {row.department}
                      </span>
                    </span>
                  </span>
                </td>
                <td className="whitespace-nowrap text-muted">{row.branchName ?? "—"}</td>
                <td className="whitespace-nowrap font-mono tabular-nums text-ink">
                  {row.timestamp !== null ? formatTime12(row.timestamp) : "—"}
                </td>
                <td>
                  <span
                    className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-bold ${badge.skin}`}
                  >
                    {badge.text}
                  </span>
                </td>
                <td className="whitespace-nowrap text-right">
                  <Link
                    href={`/employees/${row.employeeId}`}
                    onClick={onNavigate}
                    className="text-xs font-semibold text-neon/80 underline-offset-2 transition hover:text-neon hover:underline"
                  >
                    View Timesheet
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface ExceptionDrawerProps {
  type: ExceptionType;
  /** Slide-in state, owned by the metric box that opened the drawer. */
  open: boolean;
  rows: ExceptionRow[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
  /** View Timesheet was followed — parent closes before the route swaps. */
  onNavigate: () => void;
}

export default function ExceptionDrawer({
  type,
  open,
  rows,
  loading,
  error,
  onClose,
  onRetry,
  onNavigate,
}: ExceptionDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Park focus on the close button each time the panel slides in; the
  // parent returns focus to the originating metric box when it closes.
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  const chip = loading
    ? "Loading…"
    : error
      ? "—"
      : `${rows.length} record${rows.length === 1 ? "" : "s"}`;

  return (
    <div
      className={`fixed inset-0 z-[60] ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
      inert={!open}
    >
      {/* Backdrop veil ------------------------------------------------ */}
      <button
        type="button"
        aria-label="Close exception details"
        onClick={onClose}
        className={`absolute inset-0 cursor-default bg-black/40 backdrop-blur-sm transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />

      {/* Panel -------------------------------------------------------- */}
      <aside
        role="dialog"
        aria-modal={open ? "true" : undefined}
        aria-labelledby="exception-drawer-title"
        className={`absolute inset-y-0 right-0 flex w-full max-w-2xl flex-col border-l border-white/10 bg-void/95 shadow-[-24px_0_60px_rgba(0,0,0,0.6)] backdrop-blur-xl transition-transform duration-300 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="accent-line" aria-hidden="true" />

        <header className="relative flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.08] px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="text-[10px] font-bold tracking-[0.24em] text-muted uppercase">
              Exception drill-down
            </p>
            <h2
              id="exception-drawer-title"
              className="mt-1 text-lg font-bold tracking-tight text-ink"
            >
              {EXCEPTION_LABELS[type]} - Today
            </h2>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              {EXCEPTION_RULES[type]}
            </p>
          </div>
          <div className="flex flex-none items-center gap-2">
            <span className="chip chip--muted hidden sm:inline-flex">{chip}</span>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close exception details"
              className="rounded-lg border border-white/10 bg-white/[0.04] p-2 text-muted transition hover:border-white/25 hover:text-ink"
            >
              <IconX className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div
          className="scroll-thin flex-1 overflow-y-auto px-5 py-4 sm:px-6"
          aria-busy={loading || undefined}
        >
          {loading ? (
            <Skeleton />
          ) : error ? (
            <ErrorState error={error} onRetry={onRetry} />
          ) : rows.length === 0 ? (
            <EmptyState type={type} />
          ) : (
            <RowTable rows={rows} onNavigate={onNavigate} />
          )}
        </div>
      </aside>
    </div>
  );
}
