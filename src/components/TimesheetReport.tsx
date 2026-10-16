"use client";

import { useRef, useState } from "react";
import { dateKeyOf, formatDuration, formatTime12, formatDayLabel } from "@/lib/format";
import type { TimesheetReportResponse } from "@/lib/types";
import { IconPrint, IconX } from "./icons";

/**
 * Timesheet Report (Employee Directory) — generate a printable report for a
 * custom date period, then hand it straight to the browser's print dialog
 * (which is also "Save as PDF"). The document is rendered on white "paper"
 * with explicit dark ink so the printout matches an official HR report.
 *
 * Flow:  pick period (default last 30 days) → Generate → report preview →
 *        Print / Save as PDF. `?q=` from the directory search scopes the
 *        roster when the admin is filtering.
 *
 * The modal only mounts after a click, so its lazy date defaults using
 * Date.now() never run during prerender — no hydration skew.
 */

const INPUT =
  "w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-muted/60 focus:border-neon/50 focus:bg-white/[0.06]";
const LABEL = "mb-1.5 block text-[10px] font-bold tracking-[0.18em] text-muted uppercase";

/** "2026-10-07" → "Wed 07 Oct 2026" (local, browser-independent logic). */
function humanDay(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Inclusive default window: the last 30 days ending today. */
function defaultPeriod(): { from: string; to: string } {
  const now = Date.now();
  return {
    to: dateKeyOf(now),
    from: dateKeyOf(now - 29 * 86_400_000),
  };
}

interface Props {
  /** Trimmed directory search (empty = whole roster). */
  query: string;
  /** Human scope label, e.g. "All 15 employees" / "3 matches for “mar”". */
  scopeLabel: string;
  onClose: () => void;
}

export default function TimesheetReport({ query, scopeLabel, onClose }: Props) {
  const [period, setPeriod] = useState(defaultPeriod);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<TimesheetReportResponse | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  /** Fetch the report for the chosen period + search scope. */
  async function generate(event?: React.FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        from: period.from,
        to: period.to,
        ...(query ? { q: query } : {}),
      });
      const res = await fetch(`/api/employees/timesheet-report?${params}`, {
        cache: "no-store",
      });
      const json = ((await res.json()).catch(() => null)) as
        | (TimesheetReportResponse & { error?: string })
        | null;
      if (!res.ok || !json?.employees) {
        throw new Error(json?.error || `HTTP ${res.status}`);
      }
      setReport(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** Reset scroll, then hand the white paper to the print dialog. */
  function printReport() {
    scrollerRef.current?.scrollTo({ top: 0 });
    window.print();
  }

  function backToPeriod() {
    setReport(null);
    setError(null);
  }

  return (
    <div
      ref={scrollerRef}
      role="dialog"
      aria-modal="true"
      aria-label="Timesheet Report"
      className="fixed inset-0 z-[80] overflow-y-auto bg-black/70 p-4 backdrop-blur-md sm:p-6"
    >
      <div className="mx-auto w-full max-w-4xl">
        {/* ── Building / adjusting the report ──────────────────────── */}
        {report === null ? (
          <div className="glass rise relative overflow-hidden">
            <div className="accent-line" aria-hidden="true" />
            <header className="flex items-start justify-between gap-4 border-b border-white/[0.07] px-5 py-4">
              <div>
                <h3 className="text-sm font-bold tracking-[0.18em] text-ink uppercase">
                  Timesheet Report
                </h3>
                <p className="mt-1 text-xs text-muted">
                  Choose the date period you want to export · {scopeLabel}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="rounded-lg border border-white/10 bg-white/[0.04] p-2 text-muted transition hover:border-white/25 hover:text-ink"
              >
                <IconX className="h-4 w-4" />
              </button>
            </header>

            <form onSubmit={generate} className="space-y-4 px-5 py-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className={LABEL} htmlFor="tsr-from">
                    From date
                  </label>
                  <input
                    id="tsr-from"
                    type="date"
                    className={INPUT}
                    value={period.from}
                    max={period.to}
                    onChange={(e) =>
                      setPeriod((p) => ({ ...p, from: e.target.value }))
                    }
                    required
                  />
                </div>
                <div>
                  <label className={LABEL} htmlFor="tsr-to">
                    To date
                  </label>
                  <input
                    id="tsr-to"
                    type="date"
                    className={INPUT}
                    value={period.to}
                    min={period.from}
                    onChange={(e) =>
                      setPeriod((p) => ({ ...p, to: e.target.value }))
                    }
                    required
                  />
                </div>
              </div>

              <p className="text-[11px] leading-relaxed text-muted">
                The report covers every calendar day in the period for each
                employee in scope — first in, last out, worked time and punch
                count, exactly as their timesheet calculates it.
              </p>

              {error ? (
                <p className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                  {error}
                </p>
              ) : null}

              <div className="flex flex-wrap items-center justify-end gap-3 border-t border-white/[0.07] pt-4">
                <button type="button" onClick={onClose} className="btn btn--ghost">
                  Cancel
                </button>
                <button type="submit" className="btn btn--neon" disabled={busy}>
                  {busy ? <span className="spinner" aria-hidden="true" /> : null}
                  {busy ? "Generating…" : "Generate Report"}
                </button>
              </div>
            </form>
          </div>
        ) : (
          /* ── Generated report ───────────────────────────────────── */
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                onClick={backToPeriod}
                className="btn btn--ghost px-3! py-2! text-[11px]! tracking-[0.14em]! uppercase"
              >
                ← Adjust period
              </button>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => onClose()}
                  className="btn btn--ghost px-3! py-2! text-[11px]! tracking-[0.14em]! uppercase"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={printReport}
                  className="btn btn--neon px-3! py-2! text-[11px]! tracking-[0.14em]! uppercase"
                >
                  <IconPrint className="h-3.5 w-3.5" />
                  Print / Save as PDF
                </button>
              </div>
            </div>

            <div className="tsr-paper rise" id="biobridge-print-report">
              {/* Document header */}
              <header className="tsr-head">
                <div className="flex items-center justify-between">
                  <span className="tsr-brand">
                    BIOBRIDGE
                    <span className="tsr-brand-sub">T&amp;A · ERP Connector</span>
                  </span>
                  <span className="tsr-muted">EMPLOYEE TIMESHEET REPORT</span>
                </div>
                <h1>Employee Timesheet Report</h1>
                <p className="tsr-muted">
                  Period: {humanDay(report.period.fromKey)} – {humanDay(report.period.toKey)}
                  {" · "}
                  {scopeLabel} · Generated {humanDay(dateKeyOf(report.generatedAt))},{" "}
                  {new Date(report.generatedAt).toLocaleTimeString("en-GB", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </header>

              {/* KPI strip */}
              <div className="tsr-kpis">
                <Kpi label="Employees" value={String(report.totals.employees)} />
                <Kpi label="Days worked" value={String(report.totals.daysWorked)} />
                <Kpi label="Punches" value={String(report.totals.punches)} />
                <Kpi label="Total hours" value={formatDuration(report.totals.workedMs)} />
              </div>

              {/* Summary table */}
              <section className="tsr-section">
                <h2>Summary by employee</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>ERP ID</th>
                      <th>Department</th>
                      <th className="tsr-r">Days</th>
                      <th className="tsr-r">Punches</th>
                      <th className="tsr-r">Hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.employees.map((e) => (
                      <tr key={e.id}>
                        <td className="tsr-strong">{e.fullName}</td>
                        <td className="tsr-num">{e.erpUserId}</td>
                        <td>{e.department || "—"}</td>
                        <td className="tsr-num tsr-r">{e.daysWorked}</td>
                        <td className="tsr-num tsr-r">{e.punches}</td>
                        <td className="tsr-num tsr-r">{formatDuration(e.workedMs)}</td>
                      </tr>
                    ))}
                    {report.employees.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="tsr-emp-head tsr-muted">
                          No employees in scope for this period.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </section>

              {/* Daily detail — one block per employee */}
              <section className="tsr-section">
                <h2>Daily detail</h2>
                {report.employees.length === 0 ? (
                  <p className="tsr-muted">—</p>
                ) : (
                  report.employees.map((e) => (
                    <div key={e.id} className="tsr-emp">
                      <div className="tsr-emp-head">
                        <span className="tsr-strong">{e.fullName}</span>
                        <span className="tsr-num tsr-muted">
                          {e.erpUserId} · {e.department || "No department"}{" "}
                          {e.position ? `· ${e.position}` : ""}
                        </span>
                        <span className="tsr-num tsr-muted">
                          {e.daysWorked} days · {e.punches} punches ·{" "}
                          {formatDuration(e.workedMs)}
                        </span>
                      </div>
                      <table>
                        <thead>
                          <tr>
                            <th>Date</th>
                            <th>Day</th>
                            <th>First in</th>
                            <th>Last out</th>
                            <th>Worked</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {e.days.map((d) => {
                            const restDay = d.dayName === "Sunday";
                            const present = d.firstIn !== null;
                            const status = restDay
                              ? "Rest day"
                              : d.openShift
                                ? "Open shift"
                                : present
                                  ? "Present"
                                  : "No punches";
                            return (
                              <tr key={d.dateKey}>
                                <td className="tsr-num">{formatDayLabel(new Date(d.dateMs))}</td>
                                <td>{d.dayName}</td>
                                <td className="tsr-num">
                                  {d.firstIn !== null ? formatTime12(d.firstIn) : "—"}
                                </td>
                                <td className="tsr-num">
                                  {d.lastOut !== null ? formatTime12(d.lastOut) : "—"}
                                </td>
                                <td className="tsr-num">
                                  {d.workedMs > 0 ? formatDuration(d.workedMs) : "—"}
                                </td>
                                <td>
                                  <StatusPill restDay={restDay} open={d.openShift} status={status} />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ))
                )}
              </section>

              <footer className="tsr-foot tsr-muted">
                BIOBRIDGE · Enterprise Biometric Time &amp; Attendance · Working week
                Monday – Saturday · Generated by admin session
              </footer>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Small building blocks                                              */
/* ------------------------------------------------------------------ */

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="tsr-kpi">
      <span className="tsr-kpi-value">{value}</span>
      <span className="tsr-kpi-label">{label}</span>
    </div>
  );
}

function StatusPill({
  restDay,
  open,
  status,
}: {
  restDay: boolean;
  open: boolean;
  status: string;
}) {
  const tone = restDay
    ? "tsr-st-muted"
    : open
      ? "tsr-st-warn"
      : status === "Present"
        ? "tsr-st-ok"
        : "tsr-st-muted";
  return <span className={`tsr-st ${tone}`}>{status}</span>;
}