"use client";

import { useState, type ComponentType } from "react";
import ReportGraphicalPreview from "@/components/ReportGraphicalPreview";
import { IconAlert, IconCalendar, IconChart, IconClock } from "@/components/icons";
import { dateKeyOf, formatDateString, formatDuration, pad2 } from "@/lib/format";
import type {
  DashboardResponse,
  ReportId,
  ReportsEvent,
  ReportsResponse,
} from "@/lib/types";
import { usePoll } from "@/lib/use-poll";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const COLORS = {
  arrivedLate: "#F59E0B", // Amber
  leftEarly: "#F59E0B", // Amber
  missingPunch: "#EF4444", // Red
  noShow: "#EF4444", // Red
  arrivedEarly: "#3B82F6", // Blue
  bar: "#A855F7", // Purple
};

/** Reports poll slowly — it is a seven-day aggregate, not a live feed. */
const REPORT_DAYS = 7;
const REPORT_POLL_MS = 60_000;
const REPORTS_URL = `/api/reports?days=${REPORT_DAYS}`;

interface TooltipPayload {
  name: string;
  value: number;
  color: string;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
}

const ExceptionTypeChip = ({ type }: { type: ReportsEvent["exceptionType"] }) => {
  const tone =
    type === "No Show" || type === "Missing Punch"
      ? "chip--danger"
      : type === "Arrived Late" || type === "Left Early" || type === "Left Late"
      ? "chip--warn"
      : "chip--neon";

  return <span className={`chip ${tone}`}>{type}</span>;
};

const CustomTooltip = ({ active, payload, label }: CustomTooltipProps) => {
  if (!active || !payload || !payload.length) return null;

  return (
    <div className="rounded-xl border border-white/[0.12] bg-panel-deep/95 p-3 shadow-[0_10px_30px_rgba(74,20,140,0.55)] backdrop-blur">
      <p className="text-[11px] font-bold tracking-[0.16em] text-neon uppercase">
        {label}
      </p>
      <div className="mt-2 space-y-1.5">
        {payload.map((entry, index) => (
          <div key={index} className="flex items-center justify-between gap-4">
            <span className="text-[11px] text-muted">{entry.name}</span>
            <span className="font-mono text-xs font-bold text-ink tabular-nums">
              {entry.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

function ChartEmpty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center">
      <div>
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="mt-1 text-xs text-muted">{hint}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Report cards                                                        */
/* ------------------------------------------------------------------ */

interface ReportCard {
  id: ReportId;
  /** Filename segment: biobridge-<slug>-report-YYYY-MM-DD.csv */
  slug: string;
  title: string;
  description: string;
  Icon: ComponentType<{ className?: string }>;
  /** Icon tile tint — neon / warn / danger / muted. */
  tone: string;
}

const REPORT_CARDS: ReportCard[] = [
  {
    id: "attendance",
    slug: "attendance",
    title: "Attendance Report",
    description: "Every employee-day in the window with clock in/out and worked hours.",
    Icon: IconCalendar,
    tone: "border-neon/40 bg-neon/10 text-neon",
  },
  {
    id: "late",
    slug: "late-arrivals",
    title: "Late Arrivals Report",
    description: "Everyone who clocked in after their own shift start.",
    Icon: IconClock,
    tone: "border-warn/40 bg-warn/10 text-warn",
  },
  {
    id: "absent",
    slug: "absent",
    title: "Absent Report",
    description: "Scheduled employee-days with no verified punch.",
    Icon: IconAlert,
    tone: "border-danger/40 bg-danger/10 text-danger",
  },
  {
    id: "summary",
    slug: "summary",
    title: "Summary Report",
    description: "Headline KPIs: totals, on-time rate, averages.",
    Icon: IconChart,
    tone: "border-white/15 bg-white/[0.05] text-muted",
  },
];

/* ------------------------------------------------------------------ */
/* CSV plumbing — built from the live payload inside click handlers    */
/* ------------------------------------------------------------------ */

type CsvRow = (string | number)[];

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Blob → temporary <a download> → revoke. Call only from event handlers. */
function downloadCsv(filename: string, rows: CsvRow[]): void {
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** 24-hour clock for CSV cells: "08:45". */
function clockOf(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Attendance — every employee × day row, including absences. */
function attendanceRows(reports: ReportsResponse): CsvRow[] {
  const rows = reports.attendance.map<CsvRow>((row) => [
    row.date,
    row.employeeName,
    row.department,
    row.branch,
    row.clockIn !== null ? clockOf(row.clockIn) : "—",
    row.clockOut !== null ? clockOf(row.clockOut) : "—",
    row.workedMs > 0 ? formatDuration(row.workedMs) : "—",
    row.status,
  ]);

  return [
    ["Date", "Employee", "Department", "Branch", "In", "Out", "Worked", "Status"],
    ...rows,
  ];
}

/** Late arrivals — live events where the first punch beat the shift start. */
function lateArrivalRows(reports: ReportsResponse): CsvRow[] {
  const rows = reports.events
    .filter((event) => event.exceptionType === "Arrived Late")
    .map<CsvRow>((event) => [
      event.date,
      event.employeeName,
      event.branch,
      event.department,
      event.varianceMin ?? 0,
    ]);

  return [["Date", "Employee", "Branch", "Department", "Minutes Late"], ...rows];
}

/** Absent — scheduled days with no verified punch. */
function absentRows(reports: ReportsResponse): CsvRow[] {
  const rows = reports.attendance
    .filter((row) => row.status === "Absent")
    .map<CsvRow>((row) => [row.date, row.employeeName, row.branch, row.department]);

  return [["Date", "Employee", "Branch", "Department"], ...rows];
}

/** Summary — headline KPIs computed by the live reports query. */
function summaryRows(reports: ReportsResponse): CsvRow[] {
  const { summary } = reports;

  return [
    ["Metric", "Value"],
    ["Window", `${summary.windowFrom} → ${summary.windowTo}`],
    ["Days", summary.windowDays],
    ["Roster Size", summary.rosterSize],
    ["Total Exception Records", summary.totalExceptions],
    ["Arrived Early", summary.counts.arrived_early],
    ["Arrived Late", summary.counts.arrived_late],
    ["Left Early", summary.counts.left_early],
    ["Left Late", summary.counts.left_late],
    ["Missing Punch", summary.counts.missing_punch],
    ["No Show", summary.counts.no_show],
    ["Branches Covered", summary.branchesCovered],
    ["Peak Exception Day", summary.peakDay],
    ["Peak Day Exceptions", summary.peakDayTotal],
    ["On-Time Rate %", summary.onTimeRate],
    ["Average Day", summary.averagePerDay.toFixed(1)],
    ["Attendance %", summary.attendanceRate],
  ];
}

const CSV_BUILDERS: Record<ReportId, (reports: ReportsResponse) => CsvRow[]> = {
  attendance: attendanceRows,
  late: lateArrivalRows,
  absent: absentRows,
  summary: summaryRows,
};

/** Event-handler helper: builds one report CSV and downloads it. */
function generateReportCsv(card: ReportCard, reports: ReportsResponse): void {
  const stamp = dateKeyOf(Date.now());
  downloadCsv(`biobridge-${card.slug}-report-${stamp}`, CSV_BUILDERS[card.id](reports));
}

/** True when an interaction started inside one of the card's own buttons. */
function fromInnerButton(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button") !== null;
}

export default function ReportsDashboard() {
  const [activeReport, setActiveReport] = useState<ReportId | null>("attendance");
  /**
   * Quick stats come from /api/dashboard (the same payload the dashboard
   * summary cards render). Everything below — trends, branch breakdown,
   * event table and CSV rows — comes from the live /api/reports aggregate.
   */
  const { data: dashboard } = usePoll<DashboardResponse>("/api/dashboard", 10000);
  const {
    data: reports,
    error: reportsError,
    loading: reportsLoading,
  } = usePoll<ReportsResponse>(REPORTS_URL, REPORT_POLL_MS);

  const summary = dashboard?.summary ?? null;
  const reportSummary = reports?.summary ?? null;
  const trends = reports?.trends ?? [];
  const branches = reports?.branches ?? [];
  const events = reports?.events ?? [];

  const quickStats: { label: string; value: string; sub: string; tone: string }[] = [
    {
      label: "Total Employees",
      value: summary ? String(summary.total) : "—",
      sub: "roster size",
      tone: "via-white/40",
    },
    {
      label: "Present",
      value: summary ? String(summary.present) : "—",
      sub: "first punch ≤ shift start",
      tone: "via-neon/60",
    },
    {
      label: "Late",
      value: summary ? String(summary.late) : "—",
      sub: "first punch after shift start",
      tone: "via-warn/60",
    },
    {
      label: "Absent",
      value: summary ? String(summary.absent) : "—",
      sub: "no punch today",
      tone: "via-danger/60",
    },
  ];

  const handlePrint = () => window.print();

  return (
    <div className="space-y-6">
      {/* Page header -------------------------------------------------- */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">
            Reports &amp; Analytics
          </h1>
          <p className="mt-1 text-sm text-muted">
            Generate period reports or dig into exceptions across branches and time.
          </p>
        </div>
        <span className="chip chip--muted">
          <span className="flex items-center gap-2">
            <IconChart className="h-4 w-4 text-neon" />
            Live · Last {reportSummary?.windowDays ?? REPORT_DAYS} days
          </span>
        </span>
      </div>

      {reportsError ? (
        <div className="rounded-xl border border-danger/30 bg-danger/[0.08] px-4 py-3 text-xs text-danger">
          Live report data could not be refreshed ({reportsError}).
          {reports
            ? " Showing the last successful snapshot."
            : " The charts and export will fill in when the bridge responds."}
        </div>
      ) : null}

      {/* Report generators -------------------------------------------- */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {REPORT_CARDS.map((card) => {
          const disabled = !reports;
          const isSelected = activeReport === card.id;

          return (
            <section
              key={card.id}
              role="button"
              tabIndex={disabled ? -1 : 0}
              aria-disabled={disabled}
              aria-label={`Preview and generate ${card.title}`}
              onClick={(e) => {
                if (!reports) return;
                if (fromInnerButton(e.target)) return;
                setActiveReport(card.id);
              }}
              onKeyDown={(e) => {
                if (!reports) return;
                if (fromInnerButton(e.target)) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setActiveReport(card.id);
                }
              }}
              className={`glass relative overflow-hidden transition-all duration-200 hover:-translate-y-0.5 ${
                isSelected
                  ? "border-neon ring-2 ring-neon/40 bg-white/[0.07] shadow-[0_0_24px_rgba(0,230,118,0.25)]"
                  : "hover:border-white/20 hover:bg-white/[0.04]"
              } ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
            >
              <div className="accent-line" aria-hidden="true" />
              <div className="flex h-full flex-col gap-4 p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <span
                      className={`grid h-10 w-10 flex-none place-items-center rounded-xl border ${card.tone}`}
                      aria-hidden="true"
                    >
                      <card.Icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-sm font-bold text-ink">{card.title}</h3>
                      <p className="mt-1 text-xs text-muted">{card.description}</p>
                    </div>
                  </div>
                </div>

                <div className="mt-auto flex items-center justify-between border-t border-white/[0.07] pt-4">
                  <button
                    type="button"
                    disabled={disabled}
                    className={`rounded-lg px-2.5 py-1 text-[10px] font-bold tracking-wider uppercase transition ${
                      isSelected
                        ? "bg-neon text-black font-extrabold shadow-[0_0_12px_rgba(0,230,118,0.4)]"
                        : "border border-white/10 bg-white/[0.04] text-muted hover:border-neon/40 hover:text-neon"
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveReport(card.id);
                    }}
                  >
                    {isSelected ? "● Previewing" : "Preview"}
                  </button>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={disabled}
                      className="btn btn--neon px-2.5! py-1! text-[10px]! tracking-wider! uppercase disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (reports) generateReportCsv(card, reports);
                      }}
                      title="Download as CSV"
                    >
                      CSV
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost px-2.5! py-1! text-[10px]! tracking-wider! uppercase"
                      onClick={(e) => {
                        e.stopPropagation();
                        handlePrint();
                      }}
                      title="Print report"
                    >
                      Print
                    </button>
                  </div>
                </div>
              </div>
            </section>
          );
        })}
      </div>

      {/* ── Interactive Graphical Preview Panel ────────────────────────── */}
      {activeReport && reports ? (
        <ReportGraphicalPreview
          reportId={activeReport}
          reports={reports}
          onClose={() => setActiveReport(null)}
          onDownloadCsv={() => {
            const card = REPORT_CARDS.find((c) => c.id === activeReport);
            if (card) generateReportCsv(card, reports);
          }}
          onPrint={handlePrint}
        />
      ) : null}

      {/* Quick statistics --------------------------------------------- */}
      <section className="space-y-3">
        <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">
          Quick Statistics
        </h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {quickStats.map((stat) => (
            <div key={stat.label} className="glass relative overflow-hidden p-4">
              <div
                className={`absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent ${stat.tone} to-transparent`}
                aria-hidden="true"
              />
              <p className="text-[10px] font-semibold tracking-[0.2em] text-muted uppercase">
                {stat.label}
              </p>
              <p className="mt-2 font-mono text-2xl font-bold text-ink tabular-nums">
                {stat.value}
              </p>
              <p className="mt-1 text-[11px] text-muted">{stat.sub}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Charts Grid --------------------------------------------------- */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Chart A: Exceptions Timeline */}
        <section className="glass relative overflow-hidden">
          <div className="accent-line" aria-hidden="true" />
          <header className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
            <div className="flex items-center gap-2">
              <IconChart className="h-4 w-4 text-neon" />
              <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">
                Exceptions Timeline
              </h2>
            </div>
            <span className="font-mono text-[10px] tracking-wider text-muted">
              LAST {REPORT_DAYS} DAYS
            </span>
          </header>
          <div className="h-[320px] p-4 sm:p-5">
            {reports ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={trends}
                  margin={{ top: 10, right: 10, left: -10, bottom: 10 }}
                >
                  <defs>
                    <linearGradient id="late" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.arrivedLate} stopOpacity={0.25} />
                      <stop offset="95%" stopColor={COLORS.arrivedLate} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="early" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.leftEarly} stopOpacity={0.25} />
                      <stop offset="95%" stopColor={COLORS.leftEarly} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="missing" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.missingPunch} stopOpacity={0.25} />
                      <stop offset="95%" stopColor={COLORS.missingPunch} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="noshow" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.noShow} stopOpacity={0.25} />
                      <stop offset="95%" stopColor={COLORS.noShow} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(160, 174, 192, 0.12)" />
                  <XAxis
                    dataKey="date"
                    stroke="#A0AEC0"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value: string) => formatDateString(value)}
                  />
                  <YAxis
                    stroke="#A0AEC0"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend
                    wrapperStyle={{ fontSize: "11px", paddingTop: "12px" }}
                    iconType="circle"
                  />
                  <Area
                    type="monotone"
                    dataKey="arrivedLate"
                    name="Arrived Late"
                    stroke={COLORS.arrivedLate}
                    fillOpacity={1}
                    fill="url(#late)"
                  />
                  <Area
                    type="monotone"
                    dataKey="leftEarly"
                    name="Left Early"
                    stroke={COLORS.leftEarly}
                    fillOpacity={1}
                    fill="url(#early)"
                  />
                  <Area
                    type="monotone"
                    dataKey="missingPunch"
                    name="Missing Punch"
                    stroke={COLORS.missingPunch}
                    fillOpacity={1}
                    fill="url(#missing)"
                  />
                  <Area
                    type="monotone"
                    dataKey="noShow"
                    name="No Show"
                    stroke={COLORS.noShow}
                    fillOpacity={1}
                    fill="url(#noshow)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <ChartEmpty
                title={reportsLoading ? "Loading live data…" : "Reports unavailable"}
                hint={
                  reportsLoading
                    ? "Aggregating the last seven days of verified punches."
                    : "The bridge did not return a report payload."
                }
              />
            )}
          </div>
        </section>

        {/* Chart B: Exceptions by Branch */}
        <section className="glass relative overflow-hidden">
          <div className="accent-line" aria-hidden="true" />
          <header className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
            <div className="flex items-center gap-2">
              <IconChart className="h-4 w-4 text-neon" />
              <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">
                Exceptions by Branch
              </h2>
            </div>
            <span className="font-mono text-[10px] tracking-wider text-muted">
              TOP {Math.min(8, branches.length) || "—"}
            </span>
          </header>
          <div className="h-[320px] p-4 sm:p-5">
            {reports && branches.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={branches.slice(0, 8)}
                  layout="vertical"
                  margin={{ top: 10, right: 20, left: 10, bottom: 10 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="rgba(160, 174, 192, 0.12)"
                    horizontal={false}
                  />
                  <XAxis
                    type="number"
                    stroke="#A0AEC0"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="branchName"
                    stroke="#A0AEC0"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={90}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar
                    dataKey="totalExceptions"
                    name="Total Exceptions"
                    radius={[8, 8, 8, 8]}
                    fill={COLORS.bar}
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <ChartEmpty
                title={
                  reportsLoading
                    ? "Loading live data…"
                    : reports
                    ? "No branch exceptions yet"
                    : "Reports unavailable"
                }
                hint={
                  reportsLoading
                    ? "Grouping verified punches by their branch."
                    : reports
                    ? "Exceptions appear here once punches are recorded."
                    : "The bridge did not return a report payload."
                }
              />
            )}
          </div>
        </section>
      </div>

      {/* Data Table ---------------------------------------------------- */}
      <section className="glass relative overflow-hidden">
        <div className="accent-line" aria-hidden="true" />
        <header className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
          <div className="flex items-center gap-2">
            <IconAlert className="h-4 w-4 text-neon" />
            <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">
              Recent Exception Events
            </h2>
          </div>
          <span className="font-mono text-[10px] tracking-wider text-muted">
            {reports
              ? `${events.length} OF ${reportSummary?.totalExceptions ?? 0} RECORDS`
              : "— RECORDS"}
          </span>
        </header>
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse">
            <thead className="tbl-head">
              <tr>
                <th>ID</th>
                <th>Date</th>
                <th>Employee</th>
                <th>Branch</th>
                <th>Exception Type</th>
                <th>Variance</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id} className="tbl-row">
                  <td>
                    <span className="font-mono text-xs text-muted tabular-nums">
                      {event.id}
                    </span>
                  </td>
                  <td>
                    <span className="font-mono text-xs text-ink tabular-nums">
                      {event.date}
                    </span>
                  </td>
                  <td>
                    <span className="font-semibold text-ink">
                      {event.employeeName}
                    </span>
                  </td>
                  <td>
                    <span className="text-xs font-medium text-ink">
                      {event.branch}
                    </span>
                  </td>
                  <td>
                    <ExceptionTypeChip type={event.exceptionType} />
                  </td>
                  <td>
                    {event.variance !== "—" ? (
                      <span className="font-mono text-xs font-bold tabular-nums text-warn">
                        {event.variance}
                      </span>
                    ) : (
                      <span className="font-mono text-xs text-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {events.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center">
                    <p className="text-sm font-semibold text-ink">
                      {reportsLoading
                        ? "Loading live exceptions…"
                        : reports
                        ? "No exception events in this window."
                        : "Live report data unavailable."}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {reportsLoading
                        ? "Verified punches are being aggregated."
                        : reports
                        ? "Late arrivals, early departures, missing punches and no-shows will appear here."
                        : "Check the bridge connection and reload the page."}
                    </p>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
