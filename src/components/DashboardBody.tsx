"use client";

import AttendanceOverviewCard from "@/components/AttendanceOverviewCard";
import EmployeeStatusCard from "@/components/EmployeeStatusCard";
import LiveFeed from "@/components/LiveFeed";
import MetricCard from "@/components/MetricCard";
import OvertimeCard from "@/components/OvertimeCard";
import RecentActivity from "@/components/RecentActivity";
import SyncMini from "@/components/SyncMini";
import TerminalPulse from "@/components/TerminalPulse";
import TimeOffCard from "@/components/TimeOffCard";
import WelcomeToast from "@/components/WelcomeToast";
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconScan,
  IconServer,
  IconSync,
  IconUsers,
} from "@/components/icons";
import type { DashboardResponse } from "@/lib/types";
import { usePoll } from "@/lib/use-poll";

/**
 * Dashboard body.
 *
 * Layout (top → bottom):
 *   1. post-login welcome toast
 *   2. headline summary cards — Total Employees / Present / Late / Absent
 *      (Phase 11: one poll drives every panel below)
 *   3. live metric tiles (scans, terminals, ERP buffer)
 *   4. the widget grid — Employee Status (search + roster), Today's
 *      Attendance Overview doughnut (replaced the exceptions grid in
 *      Phase 11), Approaching Overtime, Time Off Requests
 *   5. Recent Clocking Activity table
 *   6. live scan feed + terminal health / sync side panels
 *
 * The grid stacks to a single column below lg and splits into two
 * columns on desktop (grid order A, B, C, D = top-left, top-right,
 * bottom-left, bottom-right).
 */
export default function DashboardBody() {
  const { data, loading, error } = usePoll<DashboardResponse>("/api/dashboard", 2500);
  const m = data?.metrics;
  const s = data?.summary;

  const terminalsHealthy = m ? m.terminalsOnline === m.terminalsTotal : true;
  const share = (n: number) => (s && s.total > 0 ? `${Math.round((n / s.total) * 100)}% of roster` : "awaiting first punch");

  return (
    <div className="space-y-6">
      {/* Post-login greeting (Objective 1) */}
      <WelcomeToast />

      {/* ── Headline attendance summary (Phase 11) ────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Total Employees"
          value={s?.total ?? "—"}
          sub="active roster on this bridge"
          icon={<IconUsers />}
          tone="ink"
          loading={loading && !s}
        />
        <MetricCard
          label="Present"
          value={s?.present ?? "—"}
          sub={s ? share(s.present) : "first punch ≤ 08:00"}
          icon={<IconCheck />}
          tone="neon"
          loading={loading && !s}
        />
        <MetricCard
          label="Late"
          value={s?.late ?? "—"}
          sub={s ? share(s.late) : "first punch after 08:00"}
          icon={<IconClock />}
          tone="warn"
          loading={loading && !s}
        />
        <MetricCard
          label="Absent"
          value={s?.absent ?? "—"}
          sub={s ? share(s.absent) : "no punch today"}
          icon={<IconAlert />}
          tone="danger"
          loading={loading && !s}
        />
      </div>

      {/* ── Top-level metrics ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Clocked In Today"
          value={m?.clockedInToday ?? 0}
          sub="distinct employees with a punch"
          icon={<IconScan />}
          tone="neon"
          loading={loading && !m}
        />
        <MetricCard
          label="Scans Today"
          value={m?.scansToday ?? 0}
          sub="punch events captured by the bridge"
          icon={<IconScan />}
          loading={loading && !m}
        />
        <MetricCard
          label="Terminals Online"
          value={m ? `${m.terminalsOnline}/${m.terminalsTotal}` : "0/0"}
          sub="devices currently reporting"
          icon={<IconServer />}
          tone={terminalsHealthy ? "neon" : "warn"}
          loading={loading && !m}
        />
        <MetricCard
          label="Pending ERP Sync"
          value={m?.pendingSync ?? 0}
          sub={m && m.pendingSync > 0 ? "buffered — awaiting ERP push" : "buffer fully drained"}
          icon={<IconSync />}
          tone={m && m.pendingSync > 0 ? "warn" : "neon"}
          loading={loading && !m}
        />
      </div>

      {error && !data ? (
        <p className="rise rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Live data unavailable — {error}. The bridge keeps retrying automatically.
        </p>
      ) : null}

      {/* ── Main widget grid (redesign) ───────────────────────────── */}
      <section
        aria-label="Dashboard widgets"
        className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2"
      >
        <EmployeeStatusCard />
        <AttendanceOverviewCard summary={s ?? null} loading={loading && !s} />
        <OvertimeCard />
        <TimeOffCard />
      </section>

      {/* ── Recent clocking activity ──────────────────────────────── */}
      <RecentActivity entries={data?.feed ?? []} loading={loading} />

      {/* ── Feed + side panels ────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <LiveFeed
            entries={data?.feed ?? []}
            loading={loading}
            error={error && data ? "stale snapshot" : error}
          />
        </div>
        <div className="space-y-6">
          <TerminalPulse />
          <SyncMini />
        </div>
      </div>
    </div>
  );
}
