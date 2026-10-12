"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  formatDuration,
  formatRelative,
  formatTime12,
  initials,
} from "@/lib/format";
import type {
  EmployeeProfileResponse,
  TimesheetDay,
  TimesheetPunch,
  TimesheetWeek,
} from "@/lib/types";
import TimesheetExport from "./TimesheetExport";
import { IconPrint } from "./icons";

/**
 * Employee Profile + formal weekly timesheet (Objectives 3 & 4).
 *
 * Data flow: static page shell → useParams() (client) → GET
 * /api/employees/[id] → grouped weeks (Mon–Sat, chronological punch
 * sequences). The week selector buckets consecutive weeks under month
 * headings ("Weeks in October" · "Weeks in November"); selecting a week
 * re-renders that week's calendar grid without refetching.
 */
export default function EmployeeProfile() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [data, setData] = useState<EmployeeProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  /** Per-employee Timesheet Export overlay (custom period → print / CSV). */
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/employees/${encodeURIComponent(id)}`, {
          cache: "no-store",
        });
        if (res.status === 404) {
          if (!cancelled) {
            setError(`No employee matches “${id}”.`);
            setData(null);
          }
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as EmployeeProfileResponse;
        if (!cancelled) {
          setData(json);
          setError(null);
          // Default to the most recent week that actually has activity.
          const active = [...json.weeks].reverse().find((w) => w.totals.punches > 0);
          setSelected((prev) =>
            prev !== null && prev <= json.weeks.length ? prev : (active?.index ?? json.weeks.length)
          );
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, refreshNonce]);

  const week = useMemo(
    () =>
      data?.weeks.find((w) => w.index === selected) ??
      data?.weeks[data.weeks.length - 1] ??
      null,
    [data, selected]
  );

  /**
   * Consecutive weeks bucketed by the month of their Monday — one section
   * per month ("Weeks in August" · "Weeks in September" …). The 8-week
   * window can cross a year boundary but never repeats a month name, so
   * the plain month label stays unambiguous.
   */
  const monthGroups = useMemo(() => {
    const groups: { key: string; name: string; weeks: TimesheetWeek[] }[] = [];
    for (const w of data?.weeks ?? []) {
      const d = new Date(w.startMs);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const name = d.toLocaleString("en-GB", { month: "long" });
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.weeks.push(w);
      else groups.push({ key, name, weeks: [w] });
    }
    return groups;
  }, [data]);

  /* ── Loading / error states ────────────────────────────────────── */
  if (loading && !data) {
    return <TimesheetSkeleton />;
  }

  if (error && !data) {
    return (
      <div className="glass rise space-y-4 p-8 text-center">
        <p className="text-sm text-danger">✕ {error}</p>
        <Link href="/" className="btn btn--ghost mx-auto">
          ← Back to dashboard
        </Link>
      </div>
    );
  }

  if (!data || !week) return null;

  const e = data.employee;

  return (
    <div className="space-y-6">
      {/* ── Breadcrumb + refresh ───────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href="/"
            className="text-[11px] font-bold tracking-[0.16em] text-neon uppercase transition hover:text-white"
          >
            ← Dashboard
          </Link>
          <Link
            href="/employees"
            className="text-[11px] font-bold tracking-[0.16em] text-muted uppercase transition hover:text-white"
          >
            ← Employees
          </Link>
          {/* Guarded: a hidden route tree can re-render with the incoming
              route's params (id undefined) — never emit that href. */}
          {id ? (
            <Link
              href={`/employees/${id}/fingerprints`}
              className="text-[11px] font-bold tracking-[0.16em] text-neon uppercase transition hover:text-white"
            >
              ✋ Enrol fingerprints
            </Link>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setRefreshNonce((n) => n + 1)}
            className="btn btn--ghost py-1.5! text-[11px] tracking-[0.14em] uppercase"
          >
            ↻ Refresh timesheet
          </button>
          <button
            type="button"
            onClick={() => setExportOpen(true)}
            className="btn btn--neon py-1.5! text-[11px] tracking-[0.14em] uppercase"
          >
            <IconPrint className="h-3.5 w-3.5" />
            Print Timesheet
          </button>
        </div>
      </div>

      {/* ── Profile header ─────────────────────────────────────────── */}
      <section className="glass relative overflow-hidden">
        <div className="accent-line" aria-hidden="true" />
        <div className="flex flex-col gap-5 px-5 py-6 sm:flex-row sm:items-center sm:px-6">
          <span className="grid h-16 w-16 flex-none place-items-center rounded-2xl border border-neon/50 bg-panel-deep text-xl font-bold text-neon shadow-[0_0_24px_rgba(0,230,118,0.22)]">
            {initials(e.fullName)}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight text-ink">
                {e.fullName}
              </h1>
              <span className="chip chip--muted">{e.erpUserId}</span>
              <span className="chip chip--muted">{e.department || "Unassigned"}</span>
              <span className={`chip ${e.enrolled ? "chip--neon" : "chip--warn"}`}>
                {e.enrolled
                  ? `${e.fingers.length}/5 fingerprints enrolled`
                  : "Not enrolled"}
              </span>
            </div>
            <p className="mt-1.5 text-sm text-muted">
              Timesheet · {formatRelative(data.window.fromMs)} → now ·{" "}
              {data.stats.branchesUsed.length > 0
                ? `branches visited: ${data.stats.branchesUsed.join(", ")}`
                : "no branch scans in window"}
              {data.stats.lastPunch ? ` · last scan ${formatRelative(data.stats.lastPunch)}` : ""}
            </p>
          </div>

          {/* Window stats ------------------------------------------- */}
          <div className="grid grid-cols-3 gap-3 sm:flex-none">
            <HeaderStat label="Punches" value={String(data.stats.punchesInWindow)} />
            <HeaderStat label="Days" value={String(data.stats.daysPresent)} />
            <HeaderStat label="Hours" value={formatDuration(data.stats.workedMs)} />
          </div>
        </div>
      </section>

      {/* ── Week selector — grouped by month (calendar synchronisation) ─ */}
      <div className="space-y-5">
        {monthGroups.map((group) => (
          <div key={group.key}>
            <div className="mb-3 flex items-center gap-3">
              <span className="text-[10px] font-bold tracking-[0.22em] text-muted uppercase">
                Weeks in {group.name}
              </span>
              <span
                className="h-px flex-1 bg-white/[0.07]"
                aria-hidden="true"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {group.weeks.map((w) => {
                const active = w.index === week.index;
                return (
                  <button
                    key={w.index}
                    type="button"
                    onClick={() => setSelected(w.index)}
                    className={`flex-none rounded-xl border px-4 py-2.5 text-left transition-colors ${
                      active
                        ? "border-neon/60 bg-neon/10 shadow-[0_0_16px_rgba(0,230,118,0.18)]"
                        : "border-white/[0.07] bg-white/[0.03] hover:border-white/15"
                    }`}
                  >
                    <span
                      className={`block text-xs font-bold tracking-[0.14em] uppercase ${
                        active ? "text-neon" : "text-ink"
                      }`}
                    >
                      Week {w.index}
                    </span>
                    <span className="mt-0.5 block font-mono text-[10px] whitespace-nowrap text-muted">
                      {w.label.replace(/^Week \d+ · /, "")}
                      {w.totals.punches === 0 ? " · no activity" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* ── The timesheet ──────────────────────────────────────────── */}
      <section className="glass relative overflow-hidden">
        <div className="accent-line" aria-hidden="true" />
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-5 py-4">
          <div>
            <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">
              {week.label}
            </h2>
            <p className="mt-1 text-[11px] text-muted">
              Formal timesheet · Monday → Saturday · punches in chronological
              order (In → Out → In → Out)
            </p>
          </div>
          <span className="chip chip--muted">
            {week.totals.daysWorked} days · {week.totals.punches} punches ·{" "}
            {formatDuration(week.totals.workedMs)}
          </span>
        </header>

        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[880px] border-collapse">
            <thead className="tbl-head">
              <tr>
                <th>Day</th>
                <th>Date</th>
                <th>Punch sequence</th>
                <th>First in</th>
                <th>Last out</th>
                <th className="text-right">Worked</th>
              </tr>
            </thead>
            <tbody>
              {week.days.map((day) => (
                <DayRow key={day.dateKey} day={day} />
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-neon/25 bg-panel-deep/30">
                <td
                  colSpan={3}
                  className="px-5 py-3 text-[11px] font-bold tracking-[0.18em] text-ink uppercase"
                >
                  Week totals
                </td>
                <td className="px-5 py-3" />
                <td className="px-5 py-3" />
                <td className="px-5 py-3 text-right font-mono text-sm font-bold text-neon tabular-nums">
                  {formatDuration(week.totals.workedMs)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <p className="border-t border-white/[0.07] px-5 py-3 text-[11px] tracking-wider text-muted uppercase">
          Working week: Monday – Saturday · Sundays are rest days and are never
          scheduled
          {error ? (
            <span className="ml-2 text-danger">(stale snapshot — {error})</span>
          ) : null}
        </p>
      </section>

      {exportOpen ? (
        <TimesheetExport
          key={`export-${e.id}`}
          employee={{ id: e.id, fullName: e.fullName, erpUserId: e.erpUserId }}
          onClose={() => setExportOpen(false)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

/**
 * Skeleton shown while the profile loads — also used as the page-level
 * `<Suspense>` fallback: `useParams()` suspends during prerendering of
 * this dynamic route (Cache Components), so an outer boundary must have
 * something to render into the static shell.
 */
export function TimesheetSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="glass h-32 animate-pulse" />
      <div className="glass h-64 animate-pulse" />
      <div className="glass h-96 animate-pulse" />
    </div>
  );
}

function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass-inset rounded-xl px-3 py-2.5 text-center">
      <p className="font-mono text-base font-bold text-neon tabular-nums">{value}</p>
      <p className="mt-0.5 text-[9px] font-bold tracking-[0.16em] text-muted uppercase">
        {label}
      </p>
    </div>
  );
}

/** One Monday–Saturday row of the timesheet. */
function DayRow({ day }: { day: TimesheetDay }) {
  const absent = day.punches.length === 0;
  return (
    <tr
      className={`tbl-row transition-colors ${day.isToday ? "bg-neon/[0.04]" : ""}`}
    >
      <td className="whitespace-nowrap">
        <span className="font-semibold text-ink">{day.dayName}</span>
        {day.isToday ? (
          <span className="chip chip--neon ml-2 py-0.5! text-[9px]!">Today</span>
        ) : null}
      </td>
      <td className="font-mono text-xs whitespace-nowrap text-muted">{day.dateLabel}</td>

      {/* Full multi-punch sequence, chronological ─────────────────── */}
      <td className="min-w-[320px]">
        {absent ? (
          <span className="text-xs text-muted/60 italic">No punches</span>
        ) : (
          <ul className="space-y-1.5 py-1">
            {day.punches.map((p) => (
              <PunchLine key={p.logId} punch={p} />
            ))}
          </ul>
        )}
      </td>

      <td className="font-mono text-xs whitespace-nowrap text-neon tabular-nums">
        {day.firstIn !== null ? formatTime12(day.firstIn) : "—"}
      </td>
      <td className="font-mono text-xs whitespace-nowrap text-ink tabular-nums">
        {day.lastOut !== null ? formatTime12(day.lastOut) : "—"}
      </td>
      <td className="text-right">
        {day.workedMs > 0 ? (
          <span className="font-mono text-xs font-semibold text-ink tabular-nums">
            {formatDuration(day.workedMs)}
          </span>
        ) : (
          <span className="text-xs text-muted/60">—</span>
        )}
        {day.openShift ? (
          <span className="chip chip--warn ml-2 py-0.5! text-[9px]!" title="IN punch without a closing OUT yet">
            Open
          </span>
        ) : null}
      </td>
    </tr>
  );
}

/** One punch inside a day cell: #seq · time · direction · label · branch. */
function PunchLine({ punch }: { punch: TimesheetPunch }) {
  const denied = punch.verifyResult === "Denied";
  const isIn = punch.direction === "IN";
  return (
    <li className="flex flex-wrap items-center gap-2 text-xs">
      <span className="w-5 flex-none font-mono text-[10px] text-muted/70" title={`Punch #${punch.seq} of the day`}>
        {punch.seq}
      </span>
      <span className="font-mono font-semibold text-ink tabular-nums">
        {formatTime12(punch.timestamp)}
      </span>
      <span
        className={`chip py-0.5! text-[9px]! ${
          denied ? "chip--danger" : isIn ? "chip--neon" : "chip--muted"
        }`}
      >
        {punch.direction}
      </span>
      <span className={denied ? "text-danger" : "text-muted"}>{punch.label}</span>
      {punch.branch ? (
        <span
          className="rounded border border-neon/30 bg-panel-deep/70 px-1.5 py-px font-mono text-[9px] font-bold tracking-wider text-neon/90"
          title={punch.location ?? undefined}
        >
          {punch.branch}
        </span>
      ) : null}
      <span
        className={`chip py-0.5! text-[9px]! ${
          punch.syncStatus === "Pending"
            ? "chip--warn"
            : punch.syncStatus === "Failed"
              ? "chip--danger"
              : "chip--muted"
        }`}
        title={`ERP sync: ${punch.syncStatus}`}
      >
        {punch.syncStatus === "Success" ? "Synced" : punch.syncStatus}
      </span>
    </li>
  );
}
