"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  dateKeyOf,
  formatDayLabel,
  formatDuration,
  formatTime12,
} from "@/lib/format";
import { addDays, startOfWeekMs } from "@/lib/timesheet";
import { branchLocation, exportFilename, FLAG_NOTE } from "@/lib/timesheet-export";
import type {
  EmployeeTimesheetExport,
  TimesheetDayStatus,
  TimesheetExportDay,
} from "@/lib/types";
import { IconDownload, IconPrint, IconX } from "./icons";

/**
 * Timesheet Export — per-employee period picker, live preview, A4 print and
 * CSV download.
 *
 * Used from the Employee Directory (row action) and the employee's own
 * timesheet page. Everything is scoped to the single employee passed in: the
 * panel only ever fetches /api/employees/<id>/timesheet, so no other
 * employee's records can be pulled in.
 *
 * Flow: pick a period (single date / range / week / month / all) → the preview
 * refreshes automatically → Print (browser dialog, "Save as PDF") or Export
 * CSV. The print document is portalled to <body> and rendered on white "paper"
 * so the @media print stylesheet can emit only the report (see globals.css).
 */

const INPUT =
  "w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-muted/60 focus:border-neon/50 focus:bg-white/[0.06]";
const LABEL = "mb-1.5 block text-[10px] font-bold tracking-[0.18em] text-muted uppercase";

type PeriodMode =
  | "single"
  | "range"
  | "this-week"
  | "last-week"
  | "this-month"
  | "last-month"
  | "custom-month"
  | "all";

type Target = { all: true } | { all: false; from: string; to: string };

const PRESETS: { mode: PeriodMode; label: string }[] = [
  { mode: "single", label: "Single date" },
  { mode: "range", label: "Custom range" },
  { mode: "this-week", label: "This week" },
  { mode: "last-week", label: "Last week" },
  { mode: "this-month", label: "This month" },
  { mode: "last-month", label: "Last month" },
  { mode: "custom-month", label: "Custom month" },
  { mode: "all", label: "All records" },
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "2026-10" month key for the current date. */
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** Full-month range for a "YYYY-MM" key (1st → last day). */
function monthRange(key: string): { from: string; to: string } {
  const [y, m] = key.split("-").map(Number);
  const from = new Date(y, m - 1, 1);
  const to = new Date(y, m, 0); // last day of the 1-based month `m`
  return { from: dateKeyOf(from.getTime()), to: dateKeyOf(to.getTime()) };
}

/** "2026-10-07" → "Wed 07 Oct 2026" (local, browser-independent logic). */
function humanDay(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function periodLabel(fromKey: string, toKey: string): string {
  return fromKey === toKey ? humanDay(fromKey) : `${humanDay(fromKey)} – ${humanDay(toKey)}`;
}

/** Client-side mirror of the server's date validation. */
function validateTarget(t: Target): string | null {
  if (t.all) return null;
  if (!t.from || !t.to) return "Choose both a start and an end date.";
  if (t.to < t.from) return "The start date must not be later than the end date.";
  return null;
}

export interface ExportEmployeeRef {
  id: number;
  fullName: string;
  erpUserId: string;
}

interface Props {
  employee: ExportEmployeeRef;
  onClose: () => void;
}

export default function TimesheetExport({ employee, onClose }: Props) {
  // One reference "now" — this component only mounts after a click, so the
  // lazy defaults never run during prerender (no hydration skew).
  const [nowRef] = useState(() => Date.now());

  const [mode, setMode] = useState<PeriodMode>("range");
  const [single, setSingle] = useState(() => dateKeyOf(Date.now()));
  const [from, setFrom] = useState(() => dateKeyOf(Date.now() - 29 * 86_400_000));
  const [to, setTo] = useState(() => dateKeyOf(Date.now()));
  const [month, setMonth] = useState(() => monthKey(new Date()));

  const [report, setReport] = useState<EmployeeTimesheetExport | null>(null);
  /** The target key the current report was generated for (loop guard). */
  const [reportKey, setReportKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = useMemo<Target>(() => {
    switch (mode) {
      case "single":
        return { all: false, from: single, to: single };
      case "this-week": {
        const mon = startOfWeekMs(nowRef);
        return { all: false, from: dateKeyOf(mon), to: dateKeyOf(addDays(mon, 5)) };
      }
      case "last-week": {
        const mon = addDays(startOfWeekMs(nowRef), -7);
        return { all: false, from: dateKeyOf(mon), to: dateKeyOf(addDays(mon, 5)) };
      }
      case "this-month":
        return { all: false, ...monthRange(monthKey(new Date(nowRef))) };
      case "last-month": {
        const d = new Date(nowRef);
        d.setDate(1);
        d.setMonth(d.getMonth() - 1);
        return { all: false, ...monthRange(monthKey(d)) };
      }
      case "custom-month":
        return { all: false, ...monthRange(month) };
      case "all":
        return { all: true };
      default:
        return { all: false, from, to };
    }
  }, [mode, single, from, to, month, nowRef]);

  const targetKey = target.all ? "all" : `${target.from}..${target.to}`;
  const validationError = validateTarget(target);

  const fetchReport = useCallback(
    async (t: Target) => {
      setBusy(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (t.all) params.set("all", "1");
        else {
          params.set("from", t.from);
          params.set("to", t.to);
        }
        const res = await fetch(
          `/api/employees/${encodeURIComponent(employee.id)}/timesheet?${params.toString()}`,
          { cache: "no-store" }
        );
        const json = (await res.json().catch(() => null)) as
          | (EmployeeTimesheetExport & { error?: string })
          | null;
        if (!res.ok || !json?.days) {
          throw new Error(json?.error || `HTTP ${res.status}`);
        }
        setReport(json);
        setReportKey(t.all ? "all" : `${t.from}..${t.to}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [employee.id]
  );

  // Refresh the preview whenever the chosen period changes (debounced).
  useEffect(() => {
    if (!report || reportKey === targetKey || validationError) return;
    const timer = setTimeout(() => {
      void fetchReport(target);
    }, 350);
    return () => clearTimeout(timer);
  }, [report, reportKey, targetKey, target, validationError, fetchReport]);

  // Escape closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Download the same period shown in the preview as a UTF-8 CSV. */
  function downloadCsv() {
    if (!report) return;
    const params = new URLSearchParams({
      from: report.period.fromKey,
      to: report.period.toKey,
      format: "csv",
    });
    const a = document.createElement("a");
    a.href = `/api/employees/${encodeURIComponent(report.employee.id)}/timesheet?${params.toString()}`;
    a.download = exportFilename(
      report.employee.fullName,
      report.period.fromKey,
      report.period.toKey,
      "csv"
    );
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function printReport() {
    window.print();
  }

  const large = report !== null && (report.period.days > 92 || report.totals.punches > 800);

  const content = (
    <div
      className="tsx-print-root tsx-root fixed inset-0 z-[85] overflow-y-auto bg-black/75 p-4 backdrop-blur-md sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`Timesheet export for ${employee.fullName}`}
    >
      <div className="tsx-root-inner mx-auto w-full max-w-4xl">
        {/* ── Period picker + actions (screen only) ───────────────────── */}
        <div className="tsx-screen-only glass rise mb-4 overflow-hidden">
          <div className="accent-line" aria-hidden="true" />
          <header className="flex items-start justify-between gap-4 border-b border-white/[0.07] px-5 py-4">
            <div>
              <h3 className="text-sm font-bold tracking-[0.18em] text-ink uppercase">
                Timesheet Export
              </h3>
              <p className="mt-1 text-xs text-muted">
                {employee.fullName} · {employee.erpUserId} — choose a period,
                preview it, then print or export CSV.
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

          <div className="space-y-4 px-5 py-5">
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.mode}
                  type="button"
                  onClick={() => setMode(p.mode)}
                  aria-pressed={mode === p.mode}
                  className={`rounded-xl border px-3 py-2 text-[11px] font-bold tracking-[0.12em] uppercase transition-colors ${
                    mode === p.mode
                      ? "border-neon/60 bg-neon/10 text-neon"
                      : "border-white/[0.09] bg-white/[0.03] text-muted hover:border-white/20 hover:text-ink"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {mode === "single" ? (
              <div>
                <label className={LABEL} htmlFor="tsx-single">
                  Date
                </label>
                <input
                  id="tsx-single"
                  type="date"
                  className={INPUT}
                  value={single}
                  onChange={(e) => setSingle(e.target.value)}
                />
              </div>
            ) : null}

            {mode === "range" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className={LABEL} htmlFor="tsx-from">
                    From date
                  </label>
                  <input
                    id="tsx-from"
                    type="date"
                    className={INPUT}
                    value={from}
                    max={to || undefined}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </div>
                <div>
                  <label className={LABEL} htmlFor="tsx-to">
                    To date
                  </label>
                  <input
                    id="tsx-to"
                    type="date"
                    className={INPUT}
                    value={to}
                    min={from || undefined}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </div>
              </div>
            ) : null}

            {mode === "custom-month" ? (
              <div>
                <label className={LABEL} htmlFor="tsx-month">
                  Month &amp; year
                </label>
                <input
                  id="tsx-month"
                  type="month"
                  className={INPUT}
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                />
              </div>
            ) : null}

            {mode === "all" ? (
              <p className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-[11px] leading-relaxed text-warn">
                All Records — every punch ever recorded for {employee.fullName}{" "}
                will be included. Large exports can take a moment to build.
              </p>
            ) : null}

            <p className="text-[11px] text-muted">
              Period in scope:{" "}
              <span className="text-ink">
                {target.all
                  ? "all recorded punches"
                  : periodLabel(target.from, target.to)}
              </span>
            </p>

            {validationError ? (
              <p className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                {validationError}
              </p>
            ) : null}

            {error ? (
              <p className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                {error}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-white/[0.07] pt-4">
              <button type="button" onClick={onClose} className="btn btn--ghost">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void fetchReport(target);
                }}
                className="btn btn--neon"
                disabled={busy || validationError !== null}
              >
                {busy ? <span className="spinner" aria-hidden="true" /> : null}
                {busy
                  ? "Generating…"
                  : report
                    ? "Refresh preview"
                    : mode === "all"
                      ? "Generate All Records"
                      : "Generate preview"}
              </button>
            </div>
          </div>
        </div>

        {/* ── Preview actions (screen only) ───────────────────────────── */}
        {report ? (
          <div className="tsx-screen-only mb-3 flex flex-wrap items-center justify-between gap-3">
            <span className="chip chip--muted">
              {report.totals.daysRecorded} days · {report.totals.punches} punches ·{" "}
              {formatDuration(report.totals.workedMs)}
            </span>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="btn btn--ghost px-3! py-2! text-[11px]! tracking-[0.14em]! uppercase"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={downloadCsv}
                className="btn btn--ghost px-3! py-2! text-[11px]! tracking-[0.14em]! uppercase"
              >
                <IconDownload className="h-3.5 w-3.5" />
                Export CSV
              </button>
              <button
                type="button"
                onClick={printReport}
                className="btn btn--neon px-3! py-2! text-[11px]! tracking-[0.14em]! uppercase"
              >
                <IconPrint className="h-3.5 w-3.5" />
                Print Timesheet
              </button>
            </div>
          </div>
        ) : null}

        {large ? (
          <p className="tsx-screen-only mb-3 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-[11px] text-warn">
            Large export: {report?.totals.punches} punches across{" "}
            {report?.period.days} days. Printing may span several A4 pages.
          </p>
        ) : null}

        {/* ── Reporting period note + document ─────────────────────────── */}
        {report ? (
          <>
            <div className="tsx-screen-only mb-2 flex flex-wrap items-center gap-3 text-[11px] tracking-wider text-muted uppercase">
              <span>Preview · {periodLabel(report.period.fromKey, report.period.toKey)}</span>
              {report.totals.issues > 0 ? (
                <span className="text-warn">
                  {report.totals.issues} unmatched / incomplete event
                  {report.totals.issues === 1 ? "" : "s"} flagged
                </span>
              ) : null}
            </div>
            <TimesheetDocument data={report} />
          </>
        ) : (
          <p className="glass px-5 py-6 text-center text-sm text-muted">
            Choose a reporting period, then generate the preview.
          </p>
        )}
      </div>
    </div>
  );

  // Portal to <body> so the print stylesheet can hide the whole app and paginate
  // only the report. The panel only mounts client-side (after a click).
  if (typeof document === "undefined") return null;
  return createPortal(content, document.body);
}

/* ------------------------------------------------------------------ */
/* Print document                                                      */
/* ------------------------------------------------------------------ */

function TimesheetDocument({ data }: { data: EmployeeTimesheetExport }) {
  const { employee, period, totals, days } = data;
  const generated = new Date(data.generatedAt);

  const issues: { when: string; text: string }[] = [];
  for (const d of days) {
    for (const it of d.issues) {
      issues.push({
        when: `${formatDayLabel(new Date(d.dateMs))} · ${d.dayName}`,
        text: it,
      });
    }
  }

  return (
    <div className="tsr-paper tsx-paper rise" id="biobridge-timesheet-export">
      <header className="tsr-head">
        <div className="flex items-center justify-between">
          <span className="tsr-brand">
            BIOBRIDGE
            <span className="tsr-brand-sub">T&amp;A · ERP Connector</span>
          </span>
          <span className="tsr-muted">EMPLOYEE ATTENDANCE TIMESHEET</span>
        </div>
        <h1>Employee Attendance Timesheet</h1>
        <dl className="tsx-meta">
          <Meta label="Employee" value={employee.fullName} />
          <Meta label="Employee ID" value={employee.erpUserId} />
          <Meta label="Department" value={employee.department || "—"} />
          <Meta label="Position" value={employee.position || "—"} />
          <Meta label="Branch" value={employee.branch || "—"} />
          <Meta label="Reporting period" value={periodLabel(period.fromKey, period.toKey)} />
          <Meta
            label="Generated"
            value={`${formatDayLabel(generated)}, ${generated.toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
            })}`}
          />
        </dl>
      </header>

      <div className="tsr-kpis">
        <Kpi label="Days recorded" value={String(totals.daysRecorded)} />
        <Kpi label="Days worked" value={String(totals.daysWorked)} />
        <Kpi label="Punches" value={String(totals.punches)} />
        <Kpi label="Total hours" value={formatDuration(totals.workedMs)} />
      </div>

      <section className="tsr-section">
        <h2>Daily attendance &amp; punch sequence</h2>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Day</th>
              <th>First in</th>
              <th>Last out</th>
              <th>Punch sequence (In → Out)</th>
              <th className="tsr-r">Hours</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <DocumentDayRow key={d.dateKey} day={d} />
            ))}
          </tbody>
          <tfoot>
            <tr className="tsx-total">
              <td colSpan={5} className="tsr-strong">
                Period totals · {totals.daysRecorded} days recorded ·{" "}
                {totals.punches} punches
              </td>
              <td className="tsr-num tsr-r tsr-strong">
                {formatDuration(totals.workedMs)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </section>

      {issues.length > 0 ? (
        <section className="tsr-section">
          <h2>Missing / unmatched events</h2>
          <ul className="tsx-issues">
            {issues.map((it, i) => (
              <li key={`${it.when}-${i}`}>
                <span className="tsr-strong tsr-num">{it.when}</span> — {it.text}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="tsr-muted tsx-clean">
          No missing or unmatched clock events in this period — every clock-in
          has a matching clock-out.
        </p>
      )}

      <section className="tsr-section tsx-signatures">
        <h2>Sign-off</h2>
        <div className="tsx-sign">
          <SignLine label="Employee signature" />
          <SignLine label="Supervisor / Manager signature" />
          <SignLine label="Date of approval" />
        </div>
      </section>

      <footer className="tsr-foot tsr-muted">
        BIOBRIDGE · Enterprise Biometric Time &amp; Attendance · Working week
        Monday – Saturday · Generated {formatDayLabel(generated)}
      </footer>
    </div>
  );
}

function DocumentDayRow({ day }: { day: TimesheetExportDay }) {
  return (
    <tr className={day.isRestDay ? "tsx-rest" : undefined}>
      <td className="tsr-num">{formatDayLabel(new Date(day.dateMs))}</td>
      <td>{day.dayName}</td>
      <td className="tsr-num">
        {day.firstIn !== null ? formatTime12(day.firstIn) : "—"}
      </td>
      <td className="tsr-num">
        {day.lastOut !== null ? formatTime12(day.lastOut) : "—"}
      </td>
      <td>
        {day.punches.length === 0 ? (
          <span className="tsr-muted">— no punches —</span>
        ) : (
          <ul className="tsx-punches">
            {day.punches.map((p) => (
              <li
                key={p.logId}
                className={p.flag ? `tsx-punch tsx-punch--${p.flag}` : "tsx-punch"}
              >
                <span className="tsx-seq">{p.seq}</span>
                <span className="tsr-num tsx-time">{formatTime12(p.timestamp)}</span>
                <span className="tsx-dir">{p.direction}</span>
                <span className="tsx-label">{p.label}</span>
                {p.branch ? (
                  <span className="tsx-branch">
                    {branchLocation(p.branch, p.location)}
                  </span>
                ) : null}
                {p.flag ? (
                  <span className="tsx-flag">⚠ {FLAG_NOTE[p.flag]}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="tsr-num tsr-r">
        {day.workedMs > 0 ? formatDuration(day.workedMs) : "—"}
      </td>
      <td>
        <DayStatusPill status={day.status} />
      </td>
    </tr>
  );
}

function DayStatusPill({ status }: { status: TimesheetDayStatus }) {
  const tone =
    status === "Present"
      ? "tsr-st-ok"
      : status === "Incomplete"
        ? "tsr-st-warn"
        : "tsr-st-muted";
  return <span className={`tsr-st ${tone}`}>{status}</span>;
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="tsr-kpi">
      <span className="tsr-kpi-value">{value}</span>
      <span className="tsr-kpi-label">{label}</span>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="tsx-meta-item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function SignLine({ label }: { label: string }) {
  return (
    <div className="tsx-sign-line">
      <span className="tsx-sign-rule" aria-hidden="true" />
      <span className="tsx-sign-label">{label}</span>
    </div>
  );
}
