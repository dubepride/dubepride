"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { AttendanceSummary } from "@/lib/types";

/**
 * Today's Attendance Overview — the doughnut that replaced the dashboard's
 * exceptions grid (Phase 11).
 *
 * Three mutually exclusive buckets (present + late + absent === total):
 *   present — first verified punch at/before the 08:00 shift start
 *   late    — first verified punch after 08:00
 *   absent  — no verified punch today
 *
 * Static hex fills (theme: neon / warn / danger) so SSR and hydration
 * paint identical marks — no CSS-variable indirection inside SVG.
 */

const SLICES = [
  { key: "present", label: "Present", fill: "#00e676" },
  { key: "late", label: "Late", fill: "#ffc400" },
  { key: "absent", label: "Absent", fill: "#ff5252" },
] as const;

interface SlicePayload {
  name: string;
  value: number;
  fill?: string;
}

interface DoughnutTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: SlicePayload }>;
}

function DoughnutTooltip({ active, payload }: DoughnutTooltipProps) {
  const slice = payload?.[0]?.payload;
  if (!active || !slice) return null;
  return (
    <div className="rounded-lg border border-white/15 bg-panel-deep/95 px-3 py-2 shadow-xl backdrop-blur">
      <p className="text-[11px] font-bold tracking-[0.14em] uppercase" style={{ color: slice.fill }}>
        {slice.name}
      </p>
      <p className="font-mono text-sm text-ink">{slice.value} employees</p>
    </div>
  );
}

const pct = (value: number, total: number): number =>
  total > 0 ? Math.round((value / total) * 100) : 0;

export default function AttendanceOverviewCard({
  summary,
  loading = false,
}: {
  summary: AttendanceSummary | null;
  loading?: boolean;
}) {
  const s = summary;
  const data = s
    ? [
        { name: "Present", value: s.present },
        { name: "Late", value: s.late },
        { name: "Absent", value: s.absent },
      ]
    : [];
  const hasData = !!s && s.total > 0;

  return (
    <section className="glass relative overflow-hidden">
      <div className="accent-line" aria-hidden="true" />

      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-5 py-4">
        <div>
          <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">
            Today&apos;s Attendance Overview
          </h2>
          <p className="mt-1 text-[11px] text-muted">Present vs. late vs. absent · live</p>
        </div>
        <span className="chip chip--neon">Today</span>
      </header>

      <div className="px-5 pt-5 pb-4">
        {loading || !s ? (
          <div className="grid h-[224px] place-items-center">
            <span className="spinner" aria-label="Loading attendance overview" />
          </div>
        ) : !hasData ? (
          <div className="grid h-[224px] place-items-center text-center">
            <div>
              <p className="text-xs font-semibold tracking-[0.16em] text-muted uppercase">
                No punches yet today
              </p>
              <p className="mt-1 text-[11px] text-muted/70">
                The overview fills in as terminals push their first scans.
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Donut + centred total ------------------------------------ */}
            <div className="relative h-[196px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="64%"
                    outerRadius="92%"
                    paddingAngle={2}
                    stroke="none"
                    isAnimationActive={false}
                  >
                    {data.map((slice, i) => (
                      <Cell key={slice.name} fill={SLICES[i].fill} />
                    ))}
                  </Pie>
                  <Tooltip content={<DoughnutTooltip />} />
                </PieChart>
              </ResponsiveContainer>

              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="font-mono text-3xl font-bold text-ink tabular-nums">
                  {s.total}
                </span>
                <span className="text-[10px] font-bold tracking-[0.2em] text-muted uppercase">
                  Employees
                </span>
              </div>
            </div>

            {/* Legend ---------------------------------------------------- */}
            <ul className="mt-3 space-y-1.5">
              {SLICES.map((slice, i) => {
                const value = [s.present, s.late, s.absent][i];
                return (
                  <li
                    key={slice.key}
                    className="flex items-center gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2"
                  >
                    <span
                      className="status-dot flex-none"
                      style={{ background: slice.fill, boxShadow: `0 0 8px ${slice.fill}` }}
                      aria-hidden="true"
                    />
                    <span className="flex-1 text-xs font-semibold text-ink">{slice.label}</span>
                    <span className="font-mono text-xs text-muted tabular-nums">{value}</span>
                    <span
                      className="w-11 text-right font-mono text-xs font-bold tabular-nums"
                      style={{ color: slice.fill }}
                    >
                      {pct(value, s.total)}%
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
