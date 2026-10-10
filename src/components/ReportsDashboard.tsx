"use client";

import type { ComponentType } from "react";
import { IconAlert, IconCalendar, IconChart, IconClock } from "@/components/icons";
import { dateKeyOf, pad2 } from "@/lib/format";
import {
  mockBranchExceptions,
  mockExceptionEvents,
  mockExceptionTrends,
} from "@/lib/mock-reports";
import type { DashboardResponse } from "@/lib/types";
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

const ExceptionTypeChip = ({
  type,
}: {
  type: (typeof mockExceptionEvents)[0]["exceptionType"];
}) => {
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

/* ------------------------------------------------------------------ */
/* Report generation — deterministic stats derived from the mock sets  */
/* ------------------------------------------------------------------ */

/** Daily-series totals across the 7-day window. */
const TREND_TOTAL = mockExceptionTrends.reduce(
  (sum, d) => sum + d.arrivedLate + d.leftEarly + d.missingPunch + d.noShow,
  0
);
const LATE_TOTAL = mockExceptionTrends.reduce((s, d) => s + d.arrivedLate, 0);
const EARLY_TOTAL = mockExceptionTrends.reduce((s, d) => s + d.leftEarly, 0);
const MISSING_TOTAL = mockExceptionTrends.reduce((s, d) => s + d.missingPunch, 0);
const NOSHOW_TOTAL = mockExceptionTrends.reduce((s, d) => s + d.noShow, 0);

/** Mean exceptions per day: 140 records ÷ 7 days. */
const AVG_PER_DAY = mockExceptionTrends.length
  ? TREND_TOTAL / mockExceptionTrends.length
  : 0;

/** Staff appearing in the exception table who were never late. */
const UNIQUE_EMPLOYEES = new Set(mockExceptionEvents.map((e) => e.employeeName)).size;
const LATE_EMPLOYEES = new Set(
  mockExceptionEvents
    .filter((e) => e.exceptionType === "Arrived Late")
    .map((e) => e.employeeName)
).size;
const ON_TIME_RATE = UNIQUE_EMPLOYEES
  ? Math.round(((UNIQUE_EMPLOYEES - LATE_EMPLOYEES) / UNIQUE_EMPLOYEES) * 100)
  : 100;

/** Share of expected punches that were present (no-show + missing punch out). */
const ATTENDANCE_RATE = TREND_TOTAL
  ? Math.round((1 - (NOSHOW_TOTAL + MISSING_TOTAL) / TREND_TOTAL) * 100)
  : 100;

/** Busiest exception day in the daily series. */
const PEAK_DAY = mockExceptionTrends.reduce(
  (best, d) => {
    const total = d.arrivedLate + d.leftEarly + d.missingPunch + d.noShow;
    return total > best.total ? { date: d.date, total } : best;
  },
  { date: mockExceptionTrends[0]?.date ?? "", total: 0 }
);

type ReportId = "attendance" | "late" | "absent" | "summary";

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
    description: "Full period attendance with worked hours per employee.",
    Icon: IconCalendar,
    tone: "border-neon/40 bg-neon/10 text-neon",
  },
  {
    id: "late",
    slug: "late-arrivals",
    title: "Late Arrivals Report",
    description: "Everyone who clocked in after the 08:00 shift start.",
    Icon: IconClock,
    tone: "border-warn/40 bg-warn/10 text-warn",
  },
  {
    id: "absent",
    slug: "absent",
    title: "Absent Report",
    description: "Enrolled employees with no verified punch.",
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
/* CSV plumbing — every builder runs inside the click handler          */
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

/** "08:00" → 480 minutes. */
function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/** Slide a wall clock by ±minutes, wrapping past midnight. */
function shiftClock(hhmm: string, delta: number): string {
  const total = (((minutesOf(hhmm) + delta) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/** "08:45" → "17:00" becomes "8h 15m". */
function durationBetween(start: string, end: string): string {
  const delta = minutesOf(end) - minutesOf(start);
  if (delta <= 0) return "0h 00m";
  return `${Math.floor(delta / 60)}h ${pad2(delta % 60)}m`;
}

/** "+45 mins" → 45, "-32 mins" → -32, "—" → null. */
function varianceMinutes(variance: string): number | null {
  const match = /^\+?(-?\d+)\s*mins?$/.exec(variance.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Attendance — one line per logged exception, reconstructed into
 * In / Out / Worked around the 08:00–17:00 shift (deterministic; the
 * mock dataset tags each row with its branch, used as the department
 * unit in exports).
 */
function attendanceRows(): CsvRow[] {
  const rows = mockExceptionEvents.map<CsvRow>((e) => {
    const delta = varianceMinutes(e.variance);
    let clockIn = "08:00";
    let clockOut = "17:00";

    if (
      delta !== null &&
      (e.exceptionType === "Arrived Late" || e.exceptionType === "Arrived Early")
    ) {
      clockIn = shiftClock("08:00", delta);
    }
    if (delta !== null && e.exceptionType === "Left Early") {
      clockOut = shiftClock("17:00", delta);
    }
    if (delta !== null && e.exceptionType === "Left Late") {
      clockOut = shiftClock("17:00", Math.abs(delta));
    }
    if (e.exceptionType === "Missing Punch") clockOut = "";
    if (e.exceptionType === "No Show") {
      clockIn = "";
      clockOut = "";
    }

    const worked = clockIn && clockOut ? durationBetween(clockIn, clockOut) : "";
    return [
      e.date,
      e.employeeName,
      e.branch,
      clockIn || "—",
      clockOut || "—",
      worked || "—",
    ];
  });

  return [["Date", "Employee", "Department", "In", "Out", "Worked"], ...rows];
}

/** Late arrivals — everyone punched in after the 08:00 shift start. */
function lateArrivalRows(): CsvRow[] {
  const rows = mockExceptionEvents
    .filter((e) => e.exceptionType === "Arrived Late")
    .map<CsvRow>((e) => [
      e.date,
      e.employeeName,
      e.branch,
      varianceMinutes(e.variance) ?? 0,
    ]);

  return [["Date", "Employee", "Department", "Minutes Late"], ...rows];
}

/** Absent — enrolled staff with a "No Show" (no verified punch). */
function absentRows(): CsvRow[] {
  const rows = mockExceptionEvents
    .filter((e) => e.exceptionType === "No Show")
    .map<CsvRow>((e) => [e.date, e.employeeName, e.branch]);

  return [["Date", "Employee", "Department"], ...rows];
}

/** Summary — headline KPIs computed from the daily series + event table. */
function summaryRows(): CsvRow[] {
  return [
    ["Metric", "Value"],
    ["Total Exception Records", TREND_TOTAL],
    ["Exception Rows Logged", mockExceptionEvents.length],
    ["Arrived Late", LATE_TOTAL],
    ["Left Early", EARLY_TOTAL],
    ["Missing Punch", MISSING_TOTAL],
    ["No Show", NOSHOW_TOTAL],
    ["Branches Covered", mockBranchExceptions.length],
    ["Peak Exception Day", PEAK_DAY.date],
    ["Peak Day Exceptions", PEAK_DAY.total],
    ["On-Time Rate %", ON_TIME_RATE],
    ["Average Day", AVG_PER_DAY.toFixed(1)],
    ["Attendance %", ATTENDANCE_RATE],
  ];
}

const CSV_BUILDERS: Record<ReportId, () => CsvRow[]> = {
  attendance: attendanceRows,
  late: lateArrivalRows,
  absent: absentRows,
  summary: summaryRows,
};

/** Event-handler helper: builds one report CSV and downloads it. */
function generateReportCsv(card: ReportCard): void {
  const stamp = dateKeyOf(Date.now());
  downloadCsv(`biobridge-${card.slug}-report-${stamp}`, CSV_BUILDERS[card.id]());
}

/** True when an interaction started inside one of the card's own buttons. */
function fromInnerButton(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button") !== null;
}

export default function ReportsDashboard() {
  /**
   * Live headline summary — same payload the dashboard's summary cards
   * render (Total / Present / Late / Absent). While the first tick is in
   * flight, or if the endpoint fails, every tile degrades to "—" and the
   * rest of the page keeps rendering from the mock sets.
   */
  const { data: dashboard } = usePoll<DashboardResponse>("/api/dashboard", 10000);
  const summary = dashboard?.summary ?? null;

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
      sub: "first punch ≤ 08:00",
      tone: "via-neon/60",
    },
    {
      label: "Late",
      value: summary ? String(summary.late) : "—",
      sub: "first punch after 08:00",
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
            Exception Analysis
          </span>
        </span>
      </div>

      {/* Report generators -------------------------------------------- */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {REPORT_CARDS.map((card) => (
          <section
            key={card.id}
            role="button"
            tabIndex={0}
            aria-label={`Download the ${card.title} as CSV`}
            onClick={(e) => {
              // Interactions that started on an inner button keep their own
              // single action — the card never double-fires the export.
              if (fromInnerButton(e.target)) return;
              generateReportCsv(card);
            }}
            onKeyDown={(e) => {
              if (fromInnerButton(e.target)) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                generateReportCsv(card);
              }
            }}
            className="glass relative cursor-pointer overflow-hidden transition duration-200 hover:-translate-y-0.5 hover:border-neon/40! hover:bg-white/[0.05]! focus-visible:border-neon/40!"
          >
            <div className="accent-line" aria-hidden="true" />
            <div className="flex h-full flex-col gap-4 p-5">
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
              <div className="mt-auto flex items-center gap-2 border-t border-white/[0.07] pt-4">
                <button
                  type="button"
                  className="btn btn--neon px-3! py-1.5! text-[11px]! tracking-[0.14em]! uppercase"
                  onClick={() => generateReportCsv(card)}
                >
                  CSV
                </button>
                <button
                  type="button"
                  className="btn btn--ghost px-3! py-1.5! text-[11px]! tracking-[0.14em]! uppercase"
                  onClick={handlePrint}
                >
                  Print
                </button>
              </div>
            </div>
          </section>
        ))}
      </div>

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
              LAST 7 DAYS
            </span>
          </header>
          <div className="h-[320px] p-4 sm:p-5">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={mockExceptionTrends}
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
              TOP BRANCHES
            </span>
          </header>
          <div className="h-[320px] p-4 sm:p-5">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={mockBranchExceptions}
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
                  width={70}
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
            {mockExceptionEvents.length} RECORDS
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
              {mockExceptionEvents.map((event) => (
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
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
