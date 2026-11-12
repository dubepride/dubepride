"use client";

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  IconAlert,
  IconCalendar,
  IconChart,
  IconCheck,
  IconClock,
  IconDownload,
  IconPrint,
  IconUsers,
  IconX,
} from "@/components/icons";
import { formatDuration } from "@/lib/format";
import type {
  ReportId,
  ReportsAttendanceRow,
  ReportsEvent,
  ReportsResponse,
} from "@/lib/types";

interface ReportGraphicalPreviewProps {
  reportId: ReportId;
  reports: ReportsResponse;
  onClose: () => void;
  onDownloadCsv: () => void;
  onPrint: () => void;
}

const REPORT_TITLES: Record<ReportId, { title: string; subtitle: string; tone: string }> = {
  attendance: {
    title: "Attendance Report — Live Graphical Preview",
    subtitle: "Complete employee-day shift attendance, worked duration, and daily presence breakdown.",
    tone: "text-neon border-neon/40 bg-neon/10",
  },
  late: {
    title: "Late Arrivals Report — Live Graphical Preview",
    subtitle: "Analysis of shift delays, punctuality variance, and punctuality by department.",
    tone: "text-warn border-warn/40 bg-warn/10",
  },
  absent: {
    title: "Absenteeism Report — Live Graphical Preview",
    subtitle: "Scheduled shifts with zero punch recordings across site locations and teams.",
    tone: "text-danger border-danger/40 bg-danger/10",
  },
  summary: {
    title: "Executive Summary Report — Live Graphical Preview",
    subtitle: "High-level workforce KPIs, punctuality rate, attendance rate, and exception breakdown.",
    tone: "text-ink border-white/20 bg-white/[0.06]",
  },
};

export default function ReportGraphicalPreview({
  reportId,
  reports,
  onClose,
  onDownloadCsv,
  onPrint,
}: ReportGraphicalPreviewProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const meta = REPORT_TITLES[reportId];

  // ── 1. ATTENDANCE PREVIEW DATA ─────────────────────────────────────────
  const attendanceData = useMemo(() => {
    const list = reports.attendance;
    const presentCount = list.filter((r) => r.status === "Present" || r.status === "In Progress").length;
    const absentCount = list.filter((r) => r.status === "Absent").length;
    const missingCount = list.filter((r) => r.status === "Missing Punch").length;
    const totalWorkedMs = list.reduce((sum, r) => sum + (r.workedMs || 0), 0);
    const avgShiftHours = list.length > 0 ? (totalWorkedMs / (1000 * 3600 * Math.max(presentCount, 1))).toFixed(1) : "0.0";

    // Chart: Daily attendance trend
    const dayMap = new Map<string, { date: string; present: number; absent: number; totalWorkedHours: number }>();
    for (const r of list) {
      const entry = dayMap.get(r.date) ?? {
        date: r.date.slice(5), // "MM-DD"
        present: 0,
        absent: 0,
        totalWorkedHours: 0,
      };
      if (r.status === "Present" || r.status === "In Progress") {
        entry.present += 1;
      } else if (r.status === "Absent") {
        entry.absent += 1;
      }
      entry.totalWorkedHours += Math.round((r.workedMs || 0) / (1000 * 3600));
      dayMap.set(r.date, entry);
    }

    const chartTrend = Array.from(dayMap.values()).slice(-7);

    return {
      presentCount,
      absentCount,
      missingCount,
      totalHours: Math.round(totalWorkedMs / (1000 * 3600)),
      avgShiftHours,
      chartTrend,
      rows: list,
    };
  }, [reports]);

  // ── 2. LATE ARRIVALS PREVIEW DATA ──────────────────────────────────────
  const lateData = useMemo(() => {
    const lateEvents = reports.events.filter((e) => e.exceptionType === "Arrived Late");
    const totalLate = lateEvents.length;
    const totalDelayMin = lateEvents.reduce((s, e) => s + (e.varianceMin || 0), 0);
    const avgDelayMin = totalLate > 0 ? Math.round(totalDelayMin / totalLate) : 0;
    const maxDelayMin = totalLate > 0 ? Math.max(...lateEvents.map((e) => e.varianceMin || 0)) : 0;

    // Variance Brackets Histogram: 1-15m, 16-30m, 31-60m, 60m+
    const brackets = [
      { bracket: "1–15 mins", count: 0 },
      { bracket: "16–30 mins", count: 0 },
      { bracket: "31–60 mins", count: 0 },
      { bracket: "60+ mins", count: 0 },
    ];

    for (const e of lateEvents) {
      const v = e.varianceMin || 0;
      if (v <= 15) brackets[0].count += 1;
      else if (v <= 30) brackets[1].count += 1;
      else if (v <= 60) brackets[2].count += 1;
      else brackets[3].count += 1;
    }

    // Department grouping
    const deptMap = new Map<string, number>();
    for (const e of lateEvents) {
      const d = e.department || "General";
      deptMap.set(d, (deptMap.get(d) ?? 0) + 1);
    }
    const deptList = Array.from(deptMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    return {
      totalLate,
      avgDelayMin,
      maxDelayMin,
      mostImpactedDept: deptList[0]?.name ?? "None",
      brackets,
      deptList,
      rows: lateEvents,
    };
  }, [reports]);

  // ── 3. ABSENT PREVIEW DATA ─────────────────────────────────────────────
  const absentData = useMemo(() => {
    const absentList = reports.attendance.filter((r) => r.status === "Absent");
    const totalAbsences = absentList.length;
    const totalScheduled = reports.attendance.length;
    const absentRate = totalScheduled > 0 ? ((totalAbsences / totalScheduled) * 100).toFixed(1) : "0.0";

    // Absences grouped by branch
    const branchMap = new Map<string, number>();
    for (const r of absentList) {
      const b = r.branch || "Unassigned";
      branchMap.set(b, (branchMap.get(b) ?? 0) + 1);
    }
    const branchList = Array.from(branchMap.entries())
      .map(([branch, count]) => ({ branch, count }))
      .sort((a, b) => b.count - a.count);

    return {
      totalAbsences,
      absentRate,
      worstBranch: branchList[0]?.branch ?? "None",
      branchList,
      rows: absentList,
    };
  }, [reports]);

  // ── 4. SUMMARY PREVIEW DATA ────────────────────────────────────────────
  const summaryData = useMemo(() => {
    const s = reports.summary;
    const exceptionBreakdown = [
      { name: "Arrived Late", count: s.counts.arrived_late, color: "#F59E0B" },
      { name: "Left Early", count: s.counts.left_early, color: "#F59E0B" },
      { name: "Missing Punch", count: s.counts.missing_punch, color: "#EF4444" },
      { name: "No Show", count: s.counts.no_show, color: "#EF4444" },
      { name: "Arrived Early", count: s.counts.arrived_early, color: "#00E676" },
      { name: "Left Late", count: s.counts.left_late, color: "#06B6D4" },
    ];

    return {
      attendanceRate: s.attendanceRate,
      onTimeRate: s.onTimeRate,
      rosterSize: s.rosterSize,
      totalExceptions: s.totalExceptions,
      branchesCovered: s.branchesCovered,
      peakDay: s.peakDay,
      peakDayTotal: s.peakDayTotal,
      exceptionBreakdown,
    };
  }, [reports]);

  return (
    <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-panel-deep/80 p-6 sm:p-8 shadow-2xl backdrop-blur-2xl animate-in fade-in zoom-in-95 duration-200">
      <div className="accent-line" aria-hidden="true" />

      {/* ── HEADER & ACTIONS ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/[0.08] pb-6">
        <div>
          <div className="flex items-center gap-3">
            <span className={`grid h-9 w-9 place-items-center rounded-xl border ${meta.tone}`}>
              {reportId === "attendance" && <IconCalendar className="h-5 w-5" />}
              {reportId === "late" && <IconClock className="h-5 w-5" />}
              {reportId === "absent" && <IconAlert className="h-5 w-5" />}
              {reportId === "summary" && <IconChart className="h-5 w-5" />}
            </span>
            <div>
              <h2 className="text-lg sm:text-xl font-extrabold tracking-tight text-ink">
                {meta.title}
              </h2>
              <p className="text-xs text-muted mt-0.5">{meta.subtitle}</p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onDownloadCsv}
            className="btn btn--neon px-3.5 py-1.5 text-xs font-bold tracking-wider uppercase inline-flex items-center gap-2"
          >
            <IconDownload className="h-3.5 w-3.5" />
            <span>Export CSV</span>
          </button>
          <button
            type="button"
            onClick={onPrint}
            className="btn btn--ghost px-3.5 py-1.5 text-xs font-bold tracking-wider uppercase inline-flex items-center gap-2"
          >
            <IconPrint className="h-3.5 w-3.5" />
            <span>Print</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="rounded-xl border border-white/10 bg-white/[0.04] p-2 text-muted transition hover:bg-white/[0.08] hover:text-ink ml-2"
          >
            <IconX className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ── 1. ATTENDANCE REPORT VIEW ─────────────────────────────────────── */}
      {reportId === "attendance" && (
        <div className="mt-6 space-y-6">
          {/* KPI Bar */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
              <span className="text-[10px] font-bold tracking-widest text-muted uppercase">Attendance Rate</span>
              <p className="mt-1 font-mono text-2xl font-black text-neon">{reports.summary.attendanceRate}%</p>
              <span className="text-[11px] text-muted/70">Verified presence</span>
            </div>
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
              <span className="text-[10px] font-bold tracking-widest text-muted uppercase">Present Shifts</span>
              <p className="mt-1 font-mono text-2xl font-black text-ink">{attendanceData.presentCount}</p>
              <span className="text-[11px] text-muted/70">Completed or in progress</span>
            </div>
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
              <span className="text-[10px] font-bold tracking-widest text-muted uppercase">Total Worked Time</span>
              <p className="mt-1 font-mono text-2xl font-black text-emerald-400">{attendanceData.totalHours} hrs</p>
              <span className="text-[11px] text-muted/70">Across all rostered sites</span>
            </div>
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
              <span className="text-[10px] font-bold tracking-widest text-muted uppercase">Average Shift</span>
              <p className="mt-1 font-mono text-2xl font-black text-ink">{attendanceData.avgShiftHours} hrs</p>
              <span className="text-[11px] text-muted/70">Daily duration</span>
            </div>
          </div>

          {/* Graphical Chart: Daily Presence vs Absences */}
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-xs font-bold tracking-widest text-ink uppercase">Daily Attendance &amp; Shift Volume</h3>
              <span className="text-[11px] font-mono text-muted">7-DAY TIMELINE</span>
            </div>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={attendanceData.chartTrend} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="date" stroke="#9ca3af" fontSize={11} tickLine={false} />
                  <YAxis stroke="#9ca3af" fontSize={11} tickLine={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#111116",
                      borderColor: "rgba(255,255,255,0.12)",
                      borderRadius: "0.75rem",
                      fontSize: "12px",
                      color: "#fff",
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }} />
                  <Bar dataKey="present" name="Present Shifts" fill="#00e676" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="absent" name="Absences" fill="#ef4444" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Data Table Preview */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold tracking-widest text-ink uppercase">Shift Records Preview</h3>
              <input
                type="text"
                placeholder="Search employee or branch…"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-ink placeholder:text-muted/40 focus:border-neon focus:outline-none"
              />
            </div>
            <div className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.02]">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-white/[0.08] bg-white/[0.02] text-[10px] font-bold text-muted uppercase tracking-wider">
                  <tr>
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Employee</th>
                    <th className="py-3 px-4">Branch</th>
                    <th className="py-3 px-4">Clock In</th>
                    <th className="py-3 px-4">Clock Out</th>
                    <th className="py-3 px-4">Worked</th>
                    <th className="py-3 px-4">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {attendanceData.rows
                    .filter((r) =>
                      !searchTerm ||
                      r.employeeName.toLowerCase().includes(searchTerm.toLowerCase()) ||
                      r.branch.toLowerCase().includes(searchTerm.toLowerCase())
                    )
                    .slice(0, 8)
                    .map((r, i) => (
                      <tr key={`${r.date}-${r.employeeId}-${i}`} className="hover:bg-white/[0.03]">
                        <td className="py-2.5 px-4 font-mono text-muted">{r.date}</td>
                        <td className="py-2.5 px-4 font-semibold text-ink">{r.employeeName}</td>
                        <td className="py-2.5 px-4 text-muted">{r.branch || "Head Office"}</td>
                        <td className="py-2.5 px-4 font-mono text-emerald-400">
                          {r.clockIn ? new Date(r.clockIn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
                        </td>
                        <td className="py-2.5 px-4 font-mono text-muted">
                          {r.clockOut ? new Date(r.clockOut).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
                        </td>
                        <td className="py-2.5 px-4 font-mono text-ink">
                          {r.workedMs > 0 ? formatDuration(r.workedMs) : "—"}
                        </td>
                        <td className="py-2.5 px-4">
                          <span
                            className={`inline-block rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                              r.status === "Present"
                                ? "border border-neon/30 bg-neon/10 text-neon"
                                : r.status === "In Progress"
                                  ? "border border-cyan-400/30 bg-cyan-400/10 text-cyan-400"
                                  : "border border-danger/30 bg-danger/10 text-danger"
                            }`}
                          >
                            {r.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── 2. LATE ARRIVALS REPORT VIEW ─────────────────────────────────── */}
      {reportId === "late" && (
        <div className="mt-6 space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
              <span className="text-[10px] font-bold tracking-widest text-muted uppercase">Total Late Punches</span>
              <p className="mt-1 font-mono text-2xl font-black text-warn">{lateData.totalLate}</p>
              <span className="text-[11px] text-muted/70">Past scheduled start</span>
            </div>
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
              <span className="text-[10px] font-bold tracking-widest text-muted uppercase">Average Delay</span>
              <p className="mt-1 font-mono text-2xl font-black text-ink">{lateData.avgDelayMin} min</p>
              <span className="text-[11px] text-muted/70">Per late arrival</span>
            </div>
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
              <span className="text-[10px] font-bold tracking-widest text-muted uppercase">Maximum Variance</span>
              <p className="mt-1 font-mono text-2xl font-black text-rose-400">+{lateData.maxDelayMin} min</p>
              <span className="text-[11px] text-muted/70">Peak tardiness</span>
            </div>
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
              <span className="text-[10px] font-bold tracking-widest text-muted uppercase">Top Dept Affected</span>
              <p className="mt-1 truncate text-lg font-black text-ink">{lateData.mostImpactedDept}</p>
              <span className="text-[11px] text-muted/70">Highest late volume</span>
            </div>
          </div>

          {/* Delay Variance Chart */}
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-xs font-bold tracking-widest text-ink uppercase">Delay Duration Distribution</h3>
              <span className="text-[11px] font-mono text-muted">VARIANCE BRACKETS</span>
            </div>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={lateData.brackets} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="bracket" stroke="#9ca3af" fontSize={11} tickLine={false} />
                  <YAxis stroke="#9ca3af" fontSize={11} tickLine={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#111116",
                      borderColor: "rgba(255,255,255,0.12)",
                      borderRadius: "0.75rem",
                      fontSize: "12px",
                      color: "#fff",
                    }}
                  />
                  <Bar dataKey="count" name="Late Arrivals" fill="#f59e0b" radius={[4, 4, 0, 0]}>
                    {lateData.brackets.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={index === 3 ? "#ef4444" : "#f59e0b"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Table Preview */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold tracking-widest text-ink uppercase">Recent Late Punches</h3>
            <div className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.02]">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-white/[0.08] bg-white/[0.02] text-[10px] font-bold text-muted uppercase tracking-wider">
                  <tr>
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Employee</th>
                    <th className="py-3 px-4">Department</th>
                    <th className="py-3 px-4">Branch</th>
                    <th className="py-3 px-4">Variance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {lateData.rows.slice(0, 8).map((e) => (
                    <tr key={e.id} className="hover:bg-white/[0.03]">
                      <td className="py-2.5 px-4 font-mono text-muted">{e.date}</td>
                      <td className="py-2.5 px-4 font-semibold text-ink">{e.employeeName}</td>
                      <td className="py-2.5 px-4 text-muted">{e.department}</td>
                      <td className="py-2.5 px-4 text-muted">{e.branch}</td>
                      <td className="py-2.5 px-4">
                        <span className="rounded-md border border-warn/30 bg-warn/10 px-2 py-0.5 font-mono text-[10px] font-bold text-warn">
                          +{e.varianceMin} min late
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── 3. ABSENT REPORT VIEW ────────────────────────────────────────── */}
      {reportId === "absent" && (
        <div className="mt-6 space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
              <span className="text-[10px] font-bold tracking-widest text-muted uppercase">Total Absences</span>
              <p className="mt-1 font-mono text-2xl font-black text-rose-400">{absentData.totalAbsences}</p>
              <span className="text-[11px] text-muted/70">Scheduled shifts</span>
            </div>
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
              <span className="text-[10px] font-bold tracking-widest text-muted uppercase">Absenteeism Rate</span>
              <p className="mt-1 font-mono text-2xl font-black text-ink">{absentData.absentRate}%</p>
              <span className="text-[11px] text-muted/70">Unfulfilled days</span>
            </div>
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
              <span className="text-[10px] font-bold tracking-widest text-muted uppercase">Top Affected Branch</span>
              <p className="mt-1 truncate text-lg font-black text-ink">{absentData.worstBranch}</p>
              <span className="text-[11px] text-muted/70">Highest absence count</span>
            </div>
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
              <span className="text-[10px] font-bold tracking-widest text-muted uppercase">Attendance Score</span>
              <p className="mt-1 font-mono text-2xl font-black text-emerald-400">{reports.summary.attendanceRate}%</p>
              <span className="text-[11px] text-muted/70">Turnout rate</span>
            </div>
          </div>

          {/* Absences by Branch Chart */}
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-xs font-bold tracking-widest text-ink uppercase">Absences by Site / Branch</h3>
              <span className="text-[11px] font-mono text-muted">SITE IMPACT</span>
            </div>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={absentData.branchList} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="branch" stroke="#9ca3af" fontSize={11} tickLine={false} />
                  <YAxis stroke="#9ca3af" fontSize={11} tickLine={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#111116",
                      borderColor: "rgba(255,255,255,0.12)",
                      borderRadius: "0.75rem",
                      fontSize: "12px",
                      color: "#fff",
                    }}
                  />
                  <Bar dataKey="count" name="Unscheduled Absences" fill="#ef4444" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Table Preview */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold tracking-widest text-ink uppercase">Absence Record Preview</h3>
            <div className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.02]">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-white/[0.08] bg-white/[0.02] text-[10px] font-bold text-muted uppercase tracking-wider">
                  <tr>
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Employee</th>
                    <th className="py-3 px-4">Department</th>
                    <th className="py-3 px-4">Branch</th>
                    <th className="py-3 px-4">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {absentData.rows.slice(0, 8).map((r, i) => (
                    <tr key={`${r.date}-${r.employeeId}-${i}`} className="hover:bg-white/[0.03]">
                      <td className="py-2.5 px-4 font-mono text-muted">{r.date}</td>
                      <td className="py-2.5 px-4 font-semibold text-ink">{r.employeeName}</td>
                      <td className="py-2.5 px-4 text-muted">{r.department}</td>
                      <td className="py-2.5 px-4 text-muted">{r.branch}</td>
                      <td className="py-2.5 px-4">
                        <span className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-bold text-rose-400 uppercase">
                          No Punch Recorded
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── 4. SUMMARY REPORT VIEW ───────────────────────────────────────── */}
      {reportId === "summary" && (
        <div className="mt-6 space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
              <span className="text-[10px] font-bold tracking-widest text-muted uppercase">Attendance Rate</span>
              <p className="mt-1 font-mono text-2xl font-black text-neon">{summaryData.attendanceRate}%</p>
              <span className="text-[11px] text-muted/70">Org-wide average</span>
            </div>
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
              <span className="text-[10px] font-bold tracking-widest text-muted uppercase">On-Time Rate</span>
              <p className="mt-1 font-mono text-2xl font-black text-ink">{summaryData.onTimeRate}%</p>
              <span className="text-[11px] text-muted/70">Punctuality rate</span>
            </div>
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
              <span className="text-[10px] font-bold tracking-widest text-muted uppercase">Tracked Roster</span>
              <p className="mt-1 font-mono text-2xl font-black text-ink">{summaryData.rosterSize}</p>
              <span className="text-[11px] text-muted/70">Active employees</span>
            </div>
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
              <span className="text-[10px] font-bold tracking-widest text-muted uppercase">Total Exceptions</span>
              <p className="mt-1 font-mono text-2xl font-black text-warn">{summaryData.totalExceptions}</p>
              <span className="text-[11px] text-muted/70">All categories</span>
            </div>
          </div>

          {/* Exception Category Breakdown Chart */}
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-xs font-bold tracking-widest text-ink uppercase">Exception Categories Breakdown</h3>
              <span className="text-[11px] font-mono text-muted">7-DAY SUMMARY</span>
            </div>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={summaryData.exceptionBreakdown} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="name" stroke="#9ca3af" fontSize={11} tickLine={false} />
                  <YAxis stroke="#9ca3af" fontSize={11} tickLine={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#111116",
                      borderColor: "rgba(255,255,255,0.12)",
                      borderRadius: "0.75rem",
                      fontSize: "12px",
                      color: "#fff",
                    }}
                  />
                  <Bar dataKey="count" name="Exceptions" radius={[4, 4, 0, 0]}>
                    {summaryData.exceptionBreakdown.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Rollup Details Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 space-y-2">
              <div className="flex justify-between">
                <span className="text-muted">Analysis Window:</span>
                <span className="font-mono text-ink">{reports.summary.windowFrom} → {reports.summary.windowTo}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Branches Covered:</span>
                <span className="font-mono text-ink">{summaryData.branchesCovered} Locations</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Average Turnout:</span>
                <span className="font-mono text-neon">{summaryData.attendanceRate}%</span>
              </div>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 space-y-2">
              <div className="flex justify-between">
                <span className="text-muted">Peak Exception Day:</span>
                <span className="font-mono text-warn">{summaryData.peakDay}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Peak Day Total:</span>
                <span className="font-mono text-warn">{summaryData.peakDayTotal} exceptions</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Daily Exception Avg:</span>
                <span className="font-mono text-ink">{reports.summary.averagePerDay.toFixed(1)} / day</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
