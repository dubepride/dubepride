"use client";

import { useEffect, useState } from "react";
import { formatDateTime, formatFeedTime, formatRelative } from "@/lib/format";
import type { ErpSyncGetResponse, ErpSyncPostResponse, SyncBatchDto } from "@/lib/types";
import { usePoll } from "@/lib/use-poll";
import MetricCard from "./MetricCard";
import { IconAlert, IconClock, IconSync, IconUsers } from "./icons";

/**
 * ERP Sync Logs — the diagnostics console.
 *
 *  • live statistics of the offline buffer
 *  • "Force Sync Now" → POST /api/erp/sync
 *  • full batch history; click a row to expand the exact JSON payload that
 *    was pushed to the ERP (including failures and their error text)
 *  • the oldest Pending records still awaiting delivery
 */
export default function SyncConsole() {
  const { data, loading, error, refresh } = usePoll<ErpSyncGetResponse>(
    "/api/erp/sync",
    4000
  );

  const [syncing, setSyncing] = useState(false);
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  // Auto-dismiss the force-sync result banner.
  useEffect(() => {
    if (!banner) return;
    const id = setTimeout(() => setBanner(null), 7000);
    return () => clearTimeout(id);
  }, [banner]);

  async function forceSync() {
    if (syncing) return;
    setSyncing(true);
    setBanner(null);
    try {
      const res = await fetch("/api/erp/sync", { method: "POST" });
      const result = (await res.json()) as ErpSyncPostResponse;
      setBanner({ ok: result.ok, text: result.message });
      refresh();
    } catch (err) {
      setBanner({
        ok: false,
        text: `Bridge unreachable: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setSyncing(false);
    }
  }

  const stats = data?.stats;
  const batches = data?.batches ?? [];
  const backlog = data?.backlog ?? [];

  return (
    <div className="space-y-6">
      {/* Header + force sync ------------------------------------------ */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">
            ERP Sync Logs
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Delivery history between the bridge and the external ERP. Failed
            pushes keep their records buffered locally until the ERP answers
            <span className="font-mono text-neon"> 200 OK</span>.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`chip ${data?.mode === "live" ? "chip--neon" : "chip--muted"}`}
            title={
              data?.mode === "live"
                ? `POSTing to ${data.erpUrl}`
                : "Built-in ERP simulator stands in for the external REST API"
            }
          >
            {data ? (data.mode === "live" ? `LIVE · ${data.erpUrl ?? ""}` : "ERP SIMULATOR MODE") : "…"}
          </span>
          <button
            type="button"
            onClick={() => void forceSync()}
            disabled={syncing}
            className="btn btn--neon"
            aria-busy={syncing}
          >
            {syncing ? (
              <>
                <span className="spinner" />
                Syncing…
              </>
            ) : (
              <>
                <IconSync className="h-4 w-4" />
                Force Sync Now
              </>
            )}
          </button>
        </div>
      </div>

      {/* Force-sync result ------------------------------------------- */}
      {banner ? (
        <p
          role="status"
          className={`rise rounded-xl border px-4 py-3 text-sm font-medium ${
            banner.ok
              ? "border-neon/40 bg-neon/10 text-neon"
              : "border-danger/40 bg-danger/10 text-danger"
          }`}
        >
          {banner.ok ? "✓ " : "✕ "}
          {banner.text}
        </p>
      ) : null}

      {error && !data ? (
        <p className="rise rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Sync diagnostics unavailable — {error}. Retrying…
        </p>
      ) : null}

      {/* Metrics ------------------------------------------------------ */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Pending Backlog"
          value={stats?.pendingLogs ?? 0}
          sub={
            stats && stats.pendingLogs > 0
              ? "oldest records buffered for the ERP"
              : "nothing waiting — buffer drained"
          }
          icon={<IconClock />}
          tone={stats && stats.pendingLogs > 0 ? "warn" : "neon"}
          loading={loading && !data}
        />
        <MetricCard
          label="Synced Today"
          value={stats?.syncedToday ?? 0}
          sub="records acknowledged by the ERP"
          icon={<IconUsers />}
          tone="neon"
          loading={loading && !data}
        />
        <MetricCard
          label="Successful Batches"
          value={stats?.successBatches ?? 0}
          sub={
            stats?.lastSuccessAt
              ? `last: ${formatRelative(stats.lastSuccessAt)}`
              : "no successful push yet"
          }
          icon={<IconSync />}
          loading={loading && !data}
        />
        <MetricCard
          label="Failed Batches"
          value={stats?.failedBatches ?? 0}
          sub="delivery attempts rejected / unreachable"
          icon={<IconAlert />}
          tone={stats && stats.failedBatches > 0 ? "danger" : "neon"}
          loading={loading && !data}
        />
      </div>

      {/* Batch history ------------------------------------------------ */}
      <section className="glass relative overflow-hidden">
        <div className="accent-line" aria-hidden="true" />
        <header className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
          <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">
            Payload History
          </h2>
          <span className="font-mono text-[11px] tracking-wider text-muted">
            CLICK A ROW TO INSPECT THE PUSHED JSON
          </span>
        </header>

        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[780px] border-collapse">
            <thead className="tbl-head">
              <tr>
                <th>Batch</th>
                <th>Timestamp</th>
                <th>Trigger</th>
                <th className="text-right">Records</th>
                <th>Status</th>
                <th className="text-right">HTTP</th>
                <th className="text-right">Duration</th>
              </tr>
            </thead>
            <tbody>
              {loading && batches.length === 0
                ? [0, 1, 2, 3].map((i) => (
                    <tr key={i} className="animate-pulse">
                      <td colSpan={7} className="h-[57px] bg-white/[0.03]" />
                    </tr>
                  ))
                : batches.map((b) => (
                    <BatchRow
                      key={b.batchId}
                      batch={b}
                      expanded={expanded === b.batchId}
                      onToggle={() =>
                        setExpanded((cur) => (cur === b.batchId ? null : b.batchId))
                      }
                    />
                  ))}
            </tbody>
          </table>
        </div>

        {!loading && batches.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">
            No sync attempts recorded yet — the engine runs automatically every
            20s once punches arrive.
          </p>
        ) : null}
      </section>

      {/* Pending backlog ---------------------------------------------- */}
      <section className="glass relative overflow-hidden">
        <div className="accent-line" aria-hidden="true" />
        <header className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
          <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">
            Offline Buffer
          </h2>
          <span className="chip chip--warn">
            {stats?.pendingLogs ?? 0} pending
          </span>
        </header>

        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[700px] border-collapse">
            <thead className="tbl-head">
              <tr>
                <th>Log ID</th>
                <th>Employee</th>
                <th>Punch Time</th>
                <th>Origin</th>
                <th className="text-right">Queued For</th>
              </tr>
            </thead>
            <tbody>
              {backlog.map((r) => (
                <tr key={r.logId} className="tbl-row transition-colors">
                  <td className="font-mono text-muted">#{r.logId}</td>
                  <td>
                    <span className="font-semibold text-ink">{r.employeeName}</span>
                    {r.erpUserId ? (
                      <span className="ml-2 font-mono text-[10px] text-muted">
                        {r.erpUserId}
                      </span>
                    ) : null}
                  </td>
                  <td className="font-mono text-xs text-muted">
                    {formatDateTime(r.timestamp)}
                    <span className="ml-2 text-neon/70">{formatFeedTime(r.timestamp)}</span>
                  </td>
                  <td className="text-xs text-muted">
                    {/* Origin: branch chip + terminal location (Obj. 2). */}
                    <span className="flex items-center gap-2">
                      {r.branchName ? (
                        <span className="flex-none rounded border border-neon/30 bg-panel-deep/70 px-1.5 py-px font-mono text-[9px] font-bold tracking-wider text-neon/90">
                          {r.branchName}
                        </span>
                      ) : null}
                      <span className="truncate">{r.location}</span>
                    </span>
                  </td>
                  <td className="text-right">
                    <span className="chip chip--warn">
                      {formatRelative(r.timestamp)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {backlog.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">
            Buffer empty — every punch has been acknowledged by the ERP.
          </p>
        ) : (
          <p className="border-t border-white/[0.07] px-5 py-3 text-[11px] tracking-wider text-muted uppercase">
            Records stay here (never lost) while the ERP is unreachable — the
            retry loop pushes them automatically.
          </p>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Expandable history row                                              */
/* ------------------------------------------------------------------ */

function BatchRow({
  batch,
  expanded,
  onToggle,
}: {
  batch: SyncBatchDto;
  expanded: boolean;
  onToggle: () => void;
}) {
  const ok = batch.status === "Success";
  return (
    <>
      <tr
        className="tbl-row cursor-pointer transition-colors"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <td className="font-mono text-xs text-ink">
          #{batch.batchId}
          <span className={`ml-2 inline-block transition ${expanded ? "rotate-90" : ""}`}>
            ▸
          </span>
        </td>
        <td className="text-muted">{formatDateTime(batch.createdAt)}</td>
        <td>
          <span className={`chip ${batch.trigger === "Manual" ? "chip--neon" : "chip--muted"}`}>
            {batch.trigger}
          </span>
        </td>
        <td className="text-right font-mono text-ink tabular-nums">{batch.recordCount}</td>
        <td>
          <span className={`chip ${ok ? "chip--neon" : "chip--danger"}`}>
            <span className={`status-dot ${ok ? "status-dot--on" : "status-dot--off"}`} />
            {batch.status}
          </span>
        </td>
        <td
          className={`text-right font-mono tabular-nums ${ok ? "text-neon" : "text-danger"}`}
        >
          {batch.responseCode ?? "—"}
        </td>
        <td className="text-right font-mono text-muted tabular-nums">
          {batch.durationMs !== null ? `${batch.durationMs}ms` : "—"}
        </td>
      </tr>

      {/* Payload drawer */}
      {expanded ? (
        <tr>
          <td colSpan={7} className="p-0!">
            <div className="rise border-b border-white/[0.07] bg-void/60 px-5 py-4">
              {batch.errorMessage ? (
                <p className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                  <strong className="mr-1">ERROR:</strong>
                  {batch.errorMessage}
                </p>
              ) : null}
              <p className="mb-2 text-[10px] font-bold tracking-[0.2em] text-muted uppercase">
                Exact payload pushed to the ERP
              </p>
              <pre className="scroll-thin max-h-72 overflow-auto rounded-lg border border-white/[0.07] bg-void/80 p-4 font-mono text-[11px] leading-relaxed text-muted">
                {JSON.stringify(batch.payload, null, 2)}
              </pre>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
