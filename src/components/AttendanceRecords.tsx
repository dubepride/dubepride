"use client";

import Link from "next/link";
import { useState } from "react";
import { dateKeyOf, formatDayLabel, formatDuration, formatTime12 } from "@/lib/format";
import type { AttendanceRecord, AttendanceRecordsResponse } from "@/lib/types";
import { usePoll } from "@/lib/use-poll";
import { IconFilter } from "./icons";

/**
 * ============================================================================
 *  Attendance Records (Phase 11) — paginated day-by-day punch table
 * ============================================================================
 *
 *  One row per employee × calendar day: clock in / clock out, worked time
 *  and status (Present / In Progress / Missing Punch), newest day first.
 *
 *  The filter bar (department, shift, date range, page size) is wired
 *  straight into the polled query string — `usePoll` re-fetches whenever
 *  `url` changes, so every filter edit lands as a fresh GET. Both date
 *  inputs start empty on purpose: the server then falls back to its
 *  default range (last 7 days, inclusive of today), and the page stays
 *  hydration-safe because nothing time-dependent is rendered upfront.
 */

/** How often the bridge refreshes the current page in the background. */
const POLL_MS = 5000;

const FIELD =
  "w-full rounded-xl border border-white/10 bg-panel-deep px-3 py-2 text-xs text-ink outline-none transition focus:border-neon/50";
const LABEL = "mb-1.5 block text-[10px] font-bold tracking-[0.18em] text-muted uppercase";

/** Status → chip tone (neon = complete, amber = still running, red = gap). */
const STATUS_CHIP: Record<AttendanceRecord["status"], string> = {
  Present: "chip chip--neon",
  "In Progress": "chip chip--warn",
  "Missing Punch": "chip chip--danger",
};

export default function AttendanceRecords() {
  const [department, setDepartment] = useState("");
  const [shift, setShift] = useState("");
  const [from, setFrom] = useState(""); // empty = server default (last 7 days)
  const [to, setTo] = useState(""); // empty = server default (today, inclusive)
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);

  // One query string drives both the fetch and its re-fetch triggers.
  const query = new URLSearchParams();
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  if (department) query.set("department", department);
  if (shift) query.set("shift", shift);
  query.set("page", String(page));
  query.set("pageSize", String(pageSize));

  const { data, loading, error } = usePoll<AttendanceRecordsResponse>(
    `/api/attendance-records?${query.toString()}`,
    POLL_MS
  );

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pages = data?.pages ?? 1;
  // Server-confirmed pagination — wins over local state while a tick is in flight.
  const current = data?.page ?? page;
  const size = data?.pageSize ?? pageSize;
  const pending = !data || data.page !== page || data.pageSize !== pageSize;

  const first = total === 0 ? 0 : (current - 1) * size + 1;
  const last = total === 0 ? 0 : Math.min(current * size, total);

  /** Any filter edit restarts the result set at page 1. */
  const onDepartment = (value: string) => {
    setDepartment(value);
    setPage(1);
  };
  const onShift = (value: string) => {
    setShift(value);
    setPage(1);
  };
  const onFrom = (value: string) => {
    setFrom(value);
    setPage(1);
  };
  const onTo = (value: string) => {
    setTo(value);
    setPage(1);
  };
  const onPageSize = (value: number) => {
    setPageSize(value);
    setPage(1);
  };

  return (
    <div className="space-y-6">
      {/* Page header -------------------------------------------------- */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Attendance Records</h1>
          <p className="mt-1 text-sm text-muted">
            Day-by-day punches — clock in/out, worked time and status across the organisation.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="chip chip--muted">{total} records</span>
          <span className="chip chip--neon">
            <span className="status-dot status-dot--on" />
            Live
          </span>
        </div>
      </div>

      {error ? (
        <p className="rise rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Attendance records unavailable — {error}. Retrying…
        </p>
      ) : null}

      {/* Filter bar --------------------------------------------------- */}
      <section className="glass relative overflow-hidden">
        <div className="accent-line" aria-hidden="true" />
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-3 sm:px-5">
          <div className="flex items-center gap-2">
            <IconFilter className="h-4 w-4 flex-none text-neon" />
            <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">Filters</h2>
          </div>
          <span className="hidden font-mono text-[10px] tracking-wider text-muted sm:inline">
            NEWEST DAY FIRST
          </span>
        </header>

        <div className="grid gap-4 px-4 py-4 sm:grid-cols-2 sm:px-5 xl:grid-cols-5">
          <div>
            <label className={LABEL} htmlFor="att-department">
              Department
            </label>
            <select
              id="att-department"
              className={FIELD}
              value={department}
              onChange={(e) => onDepartment(e.target.value)}
            >
              <option value="">All Departments</option>
              {(data?.departments ?? []).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={LABEL} htmlFor="att-shift">
              Shift
            </label>
            <select
              id="att-shift"
              className={FIELD}
              value={shift}
              onChange={(e) => onShift(e.target.value)}
            >
              <option value="">All Shifts</option>
              {(data?.shifts ?? []).map((s) => (
                <option key={s.id} value={String(s.id)}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-2 xl:col-span-2">
            <span className={LABEL}>Date range</span>
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="date"
                aria-label="From date"
                className={`${FIELD} flex-1 min-w-[9.5rem] font-mono`}
                value={from}
                onChange={(e) => onFrom(e.target.value)}
              />
              <input
                type="date"
                aria-label="To date"
                className={`${FIELD} flex-1 min-w-[9.5rem] font-mono`}
                value={to}
                onChange={(e) => onTo(e.target.value)}
              />
            </div>
            <p className="mt-1.5 text-[10px] text-muted">Default range: last 7 days</p>
          </div>

          <div>
            <label className={LABEL} htmlFor="att-page-size">
              Rows per page
            </label>
            <select
              id="att-page-size"
              className={FIELD}
              value={String(pageSize)}
              onChange={(e) => onPageSize(Number(e.target.value))}
            >
              <option value="25">25 / page</option>
              <option value="50">50 / page</option>
              <option value="100">100 / page</option>
            </select>
          </div>
        </div>
      </section>

      {/* Records table ------------------------------------------------ */}
      <section className="glass relative overflow-hidden">
        <div className="accent-line" aria-hidden="true" />
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-5 py-4">
          <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">
            Daily Attendance
          </h2>
          <span className="font-mono text-[10px] tracking-wider text-muted">
            {pending ? "SYNCING…" : `PAGE ${current} OF ${pages}`}
          </span>
        </header>

        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse">
            <thead className="tbl-head">
              <tr>
                <th>Date</th>
                <th>Employee</th>
                <th>Department</th>
                <th>Shift</th>
                <th>Clock In</th>
                <th>Clock Out</th>
                <th>Worked</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center">
                    {error && !data ? (
                      <span className="text-sm text-danger">
                        Attendance records unavailable — {error}.
                      </span>
                    ) : pending || (loading && !data) ? (
                      <span className="inline-flex items-center gap-2 text-sm text-muted">
                        <span className="spinner inline-block text-neon" aria-hidden="true" />
                        Loading attendance records…
                      </span>
                    ) : (
                      <span className="text-sm text-muted">
                        No attendance records match these filters.
                      </span>
                    )}
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.key} className="tbl-row transition-colors">
                    <td>
                      <span
                        className="font-mono text-xs text-ink tabular-nums"
                        title={dateKeyOf(r.dateMs)}
                      >
                        {formatDayLabel(new Date(r.dateMs))}
                      </span>
                    </td>
                    <td>
                      <Link
                        href={`/employees/${r.employeeId}`}
                        className="text-sm font-semibold text-ink transition-colors hover:text-neon"
                        title={r.position}
                      >
                        {r.fullName}
                      </Link>
                      <span className="block font-mono text-[10px] text-muted">{r.erpUserId}</span>
                    </td>
                    <td>
                      <span className="text-xs text-ink">{r.department}</span>
                    </td>
                    <td>
                      <span className="chip chip--muted">{r.shiftName ?? "—"}</span>
                    </td>
                    <td>
                      <span className="font-mono text-xs text-ink tabular-nums">
                        {r.clockIn !== null ? formatTime12(r.clockIn) : <span className="text-muted/60">—</span>}
                      </span>
                    </td>
                    <td>
                      <span className="font-mono text-xs text-ink tabular-nums">
                        {r.clockOut !== null ? formatTime12(r.clockOut) : <span className="text-muted/60">—</span>}
                      </span>
                    </td>
                    <td>
                      <span className="font-mono text-xs text-ink tabular-nums">
                        {r.workedMs > 0 ? formatDuration(r.workedMs) : <span className="text-muted/60">—</span>}
                      </span>
                    </td>
                    <td>
                      <span className={STATUS_CHIP[r.status]}>{r.status}</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination footer ------------------------------------------- */}
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] px-4 py-3 sm:px-5">
          <p className="text-xs text-muted">
            Showing{" "}
            <span className="font-mono text-ink tabular-nums">
              {first}–{last}
            </span>{" "}
            of{" "}
            <span className="font-mono text-ink tabular-nums">{total}</span>{" "}
            {total === 1 ? "record" : "records"}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn--ghost"
              disabled={pending || current <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </button>
            <span className="px-1 font-mono text-[11px] tracking-wider text-muted">
              Page {current} / {pages}
            </span>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={pending || current >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
