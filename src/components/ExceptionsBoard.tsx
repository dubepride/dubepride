"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatDateTime, formatPunchTime } from "@/lib/format";
import {
  EXCEPTION_LABELS,
  EXCEPTION_RULES,
  EXCEPTION_TYPES,
} from "@/lib/exception-meta";
import type {
  ExceptionRow,
  ExceptionType,
  ExceptionsResponse,
} from "@/lib/types";
import { varianceBadge } from "./ExceptionDrawer";

/** One drawer row tagged with the bucket it came from. */
type MergedRow = ExceptionRow & { type: ExceptionType };

/** Type pill skin — mirrors the dashboard boxes' tone. */
const TYPE_CHIP: Record<ExceptionType, string> = {
  arrived_early: "chip chip--neon",
  arrived_late: "chip chip--warn",
  left_early: "chip chip--warn",
  left_late: "chip chip--warn",
  no_show: "chip chip--danger",
  missing_punch: "chip chip--danger",
};

/**
 * Exception Resolution (Phase 7, Objective 3) — every flag raised TODAY
 * across all branches, filterable by branch and exception type.
 *
 * Data flow: six parallel GET /api/dashboard/exceptions?type=… calls
 * (one per bucket — the verified Phase 4 API), merged into a single row
 * list tagged with its type. Both filters run client-side; the merged
 * set refreshes silently every 15 s (in-flight ticks are skipped, same
 * as usePoll). Row action links to the employee's timesheet.
 */
export default function ExceptionsBoard() {
  const [rows, setRows] = useState<MergedRow[]>([]);
  const [counts, setCounts] = useState<
    Partial<Record<ExceptionType, number>> | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<ExceptionType | "ALL">("ALL");
  const [branchFilter, setBranchFilter] = useState("ALL");
  // Bumped by the Retry button — re-runs the effect immediately.
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const results = await Promise.all(
          EXCEPTION_TYPES.map(async (t) => {
            const res = await fetch(`/api/dashboard/exceptions?type=${t}`, {
              cache: "no-store",
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return (await res.json()) as ExceptionsResponse;
          })
        );
        const merged: MergedRow[] = results.flatMap((r) =>
          r.type === null
            ? []
            : r.rows.map((row) => ({ ...row, type: r.type as ExceptionType }))
        );
        // Newest punch first; rows without a timestamp (no_show) sink last.
        merged.sort((a, b) => (b.timestamp ?? -1) - (a.timestamp ?? -1));
        if (!cancelled) {
          setRows(merged);
          setCounts(results[0]?.counts ?? null);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    };

    void tick();
    const id = setInterval(() => void tick(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [nonce]);

  const retry = () => {
    setLoading(true);
    setNonce((n) => n + 1);
  };

  // Branch options come from the flags actually raised today.
  const branches = [...new Set(rows.map((r) => r.branchName ?? "Unassigned"))].sort();
  const visible = rows.filter(
    (r) =>
      (typeFilter === "ALL" || r.type === typeFilter) &&
      (branchFilter === "ALL" ||
        (r.branchName ?? "Unassigned") === branchFilter)
  );

  return (
    <div className="space-y-6">
      {/* Page header -------------------------------------------------- */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">
            Exception Resolution
          </h1>
          <p className="mt-1 text-sm text-muted">
            Every flag raised today across all 17 branches — filter by branch
            and exception type, then open the employee&apos;s timesheet.
          </p>
        </div>
        <span className="chip chip--muted">
          {loading && rows.length === 0
            ? "LOADING…"
            : `${rows.length} FLAGGED TODAY`}
        </span>
      </div>

      {error && rows.length === 0 ? (
        <p className="rise rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Exceptions unavailable — {error}.{" "}
          <button
            type="button"
            onClick={retry}
            className="font-bold underline"
          >
            Retry
          </button>
        </p>
      ) : null}

      <section className="glass relative overflow-hidden">
        <div className="accent-line" aria-hidden="true" />

        {/* Bucket chips — click to filter by type ---------------------- */}
        <div className="flex flex-wrap gap-2 border-b border-white/[0.06] px-4 py-3 sm:px-5">
          {EXCEPTION_TYPES.map((t) => {
            const active = typeFilter === t;
            return (
              <button
                key={t}
                type="button"
                aria-pressed={active}
                onClick={() => setTypeFilter(active ? "ALL" : t)}
                className={`rounded-xl border px-3 py-1.5 text-[10px] font-bold tracking-[0.14em] uppercase transition ${
                  active
                    ? "border-neon/50 bg-neon/10 text-neon"
                    : "border-white/10 bg-white/[0.03] text-muted hover:border-white/25 hover:text-ink"
                }`}
              >
                {EXCEPTION_LABELS[t]}
                <span className="ml-1.5 font-mono tabular-nums">
                  {counts?.[t] ?? 0}
                </span>
              </button>
            );
          })}
        </div>

        {/* Rule hint + branch filter ----------------------------------- */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3 sm:px-5">
          <p className="min-w-0 flex-1 text-xs text-muted">
            {typeFilter !== "ALL"
              ? EXCEPTION_RULES[typeFilter]
              : "Showing all six exception types."}
          </p>
          <select
            value={branchFilter}
            onChange={(e) => setBranchFilter(e.target.value)}
            aria-label="Filter by branch"
            className="flex-none rounded-xl border border-white/10 bg-panel-deep px-3 py-2 text-[11px] font-bold tracking-wider text-ink uppercase focus:outline-none"
          >
            <option value="ALL">All branches</option>
            {branches.map((b) => (
              <option key={b} value={b} className="bg-panel-deep text-ink">
                {b}
              </option>
            ))}
          </select>
        </div>

        {/* Flags table -------------------------------------------------- */}
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[880px] border-collapse">
            <thead className="tbl-head">
              <tr>
                <th>Type</th>
                <th>Employee</th>
                <th>Branch</th>
                <th>Punch</th>
                <th>Variance</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                [0, 1, 2, 3, 4].map((i) => (
                  <tr key={i} className="animate-pulse">
                    <td colSpan={6} className="h-[57px] bg-white/[0.03]" />
                  </tr>
                ))
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center">
                    <span className="text-sm text-muted">
                      {rows.length === 0
                        ? "No flags raised today."
                        : "No exceptions match this view."}
                    </span>
                  </td>
                </tr>
              ) : (
                visible.map((r) => {
                  const badge = varianceBadge(r);
                  return (
                    <tr key={`${r.type}-${r.employeeId}`} className="tbl-row">
                      <td>
                        <span className={TYPE_CHIP[r.type]}>
                          {EXCEPTION_LABELS[r.type]}
                        </span>
                      </td>
                      <td>
                        <span className="font-semibold text-ink">
                          {r.fullName}
                        </span>
                        <span className="mt-0.5 block text-[10px] text-muted">
                          {r.erpUserId}
                          {r.department ? ` · ${r.department}` : ""}
                        </span>
                      </td>
                      <td>
                        {r.branchName !== null ? (
                          <span className="text-xs font-medium text-ink">
                            {r.branchName}
                          </span>
                        ) : (
                          <span className="text-xs text-muted">Unassigned</span>
                        )}
                      </td>
                      <td>
                        {r.timestamp !== null ? (
                          <>
                            <span
                              className="font-mono text-xs text-ink"
                              title={new Date(r.timestamp).toString()}
                            >
                              {formatPunchTime(r.timestamp)}
                            </span>
                            <span className="ml-2 hidden font-mono text-[10px] text-muted/70 xl:inline">
                              {formatDateTime(r.timestamp)}
                            </span>
                          </>
                        ) : (
                          <span className="font-mono text-xs text-muted">—</span>
                        )}
                      </td>
                      <td>
                        <span
                          className={`inline-flex items-center rounded-lg border px-2 py-0.5 text-[10px] font-bold ${badge.skin}`}
                        >
                          {badge.text}
                        </span>
                      </td>
                      <td>
                        <Link
                          href={`/employees/${r.employeeId}`}
                          className="text-[10px] font-bold tracking-[0.14em] text-neon uppercase hover:underline"
                        >
                          View Timesheet
                        </Link>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
