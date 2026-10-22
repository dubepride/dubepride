/**
 * ============================================================================
 *  Overview — "what is the network doing right now?"
 * ============================================================================
 *
 *  The first screen an operator sees. It answers four questions:
 *
 *    1. Is the monitoring pipeline itself alive? (A stopped collector must
 *       never look like a healthy network.)
 *    2. How many devices are in each of the ten health states — never
 *       collapsed into "up / down".
 *    3. What is broken, and where is the fault most likely to be?
 *    4. What changed most recently?
 * ============================================================================
 */

"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { useApi } from "@/components/useApi";
import { useAuth } from "@/components/auth";
import { apiPost } from "@/components/api";
import {
  Chip,
  ErrorNote,
  Grid,
  Loading,
  Notice,
  PageHeader,
  Panel,
  SeverityBadge,
  StateBadge,
  StatTile,
} from "@/components/ui";
import { durationSince, formatDateTime, humanise, timeAgo } from "@/components/format";
import { HEALTH_STATES, type HealthState, type Incident, type NetworkEvent } from "@/lib/types";

interface OverviewPayload {
  states: Partial<Record<HealthState, number>>;
  categories: Record<string, number>;
  devices: number;
  monitored: number;
  connections: number;
  downLinks: number;
  ports: number;
  incidents: {
    total: number;
    critical: number;
    major: number;
    minor: number;
    acknowledged: number;
  };
  activeIncidents: (Incident & { deviceName: string | null })[];
  events: NetworkEvent[];
  busiestLinks: {
    connectionId: number;
    state: string;
    deviceName: string | null;
    portName: string | null;
    speedBps: number | null;
    rateBps: number | null;
    rateLabel: string;
  }[];
  collector: { at: number; detail: string } | null;
  collectorMode: string;
  demoMode: boolean;
}

const STATE_TONE: Record<HealthState, string> = {
  ONLINE: "bg-neon",
  OFFLINE: "bg-red-500",
  LINK_DOWN: "bg-red-500",
  NO_INTERNET: "bg-red-500",
  DEGRADED: "bg-amber-400",
  STALE: "bg-amber-400",
  NO_TRAFFIC: "bg-amber-400",
  UNKNOWN: "bg-slate-400",
  UNMONITORED: "bg-slate-500",
};

export default function OverviewPage() {
  const { data, error, loading, refreshing, loadedAt, reload } = useApi<OverviewPayload>(
    "/api/overview",
    { pollMs: 15_000 }
  );
  const { can } = useAuth();
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoMsg, setDemoMsg] = useState<string | null>(null);

  /**
   * Inject (or clear) a labelled demo fault.
   *
   * The endpoint refuses to do anything unless the console is running with
   * MINEAZY_DEMO=1, so this control can never affect a live installation.
   */
  const demoAction = async (body: Record<string, unknown>, message: string): Promise<void> => {
    setDemoBusy(true);
    setDemoMsg(null);
    try {
      await apiPost("/api/demo", body);
      setDemoMsg(message);
      reload();
    } catch (e) {
      setDemoMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setDemoBusy(false);
    }
  };

  if (loading && !data) return <Loading label="Reading the network…" />;
  if (error && !data) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return null;

  // The age is measured against the moment the payload was fetched, not
  // against the clock — a component must not read the current time while it
  // renders, or two renders of the same data could disagree.
  const collectorAge = data.collector && loadedAt !== null ? loadedAt - data.collector.at : null;
  const collectorStale = collectorAge === null || collectorAge > 5 * 60_000;
  const totalDevices = Object.values(data.states).reduce((sum, n) => sum + (n ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Overview"
        description="Live health of every device on the estate, the state of the monitoring pipeline, and what changed most recently."
        actions={
          <>
            <span className="chip chip--muted">
              <span className={`status-dot ${refreshing ? "status-dot--warn" : "status-dot--on"}`} />
              {loadedAt ? `updated ${timeAgo(loadedAt)}` : "loading"}
            </span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={reload}>
              <Icon name="refresh" size={13} />
              Refresh
            </button>
          </>
        }
      />

      {data.demoMode ? (
        <div className="mb-4">
          <Notice tone="warn" title="Demo mode — this data is simulated">
            Mineazy Network is running with <code className="font-mono">MINEAZY_DEMO=1</code>. Every
            device, port, counter and incident below comes from the built-in simulator. No real
            hardware is being polled.
          </Notice>
        </div>
      ) : null}

      {/* ------------------------------------------------------------ */}
      {/* Demo fault controls                                         */}
      {/* ------------------------------------------------------------ */}
      {data.demoMode ? (
        <div className="mb-4">
          <Panel
            title="Demo controls"
            subtitle="Inject a labelled fault into the SIMULATED estate to see the incident engine work. Nothing here touches real hardware."
          >
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={demoBusy || !can("can_config_monitoring")}
                onClick={() =>
                  void demoAction(
                    { uplinkDown: true },
                    "The uplink between the edge router and the admin switch was cut. The next collector cycle will raise ONE link incident and take everything below it offline."
                  )
                }
              >
                <Icon name="incidents" size={13} />
                Cut the uplink
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={demoBusy || !can("can_config_monitoring")}
                onClick={() =>
                  void demoAction(
                    { noInternet: true },
                    "External connectivity checks were failed. Only the internet-boundary devices will report NO_INTERNET."
                  )
                }
              >
                <Icon name="refresh" size={13} />
                Take the internet away
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={demoBusy || !can("can_config_monitoring")}
                onClick={() =>
                  void demoAction(
                    { action: "clear" },
                    "Every injected fault was cleared. The next collector cycle will resolve the incidents."
                  )
                }
              >
                <Icon name="refresh" size={13} />
                Clear all faults
              </button>
              {demoMsg ? <span className="text-xs text-muted">{demoMsg}</span> : null}
            </div>
            {!can("can_config_monitoring") ? (
              <p className="mt-2 text-xs text-muted">
                Your role cannot change the monitoring configuration, so the demo controls are
                read-only for you.
              </p>
            ) : null}
          </Panel>
        </div>
      ) : null}

      {/* ------------------------------------------------------------ */}
      {/* Collector heartbeat                                           */}
      {/* ------------------------------------------------------------ */}
      <div className="mb-4">
        <Panel
          title="Monitoring pipeline"
          tone={collectorStale ? "warn" : "ok"}
          actions={
            <Chip tone={collectorStale ? "warn" : "neon"}>
              {collectorStale ? "NOT CONFIRMED RUNNING" : "RUNNING"}
            </Chip>
          }
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <div className="text-[0.6rem] font-bold tracking-[0.16em] text-muted uppercase">
                Last collector cycle
              </div>
              <div className="mt-1 text-sm text-white">
                {data.collector ? timeAgo(data.collector.at) : "never"}
              </div>
              <div className="text-xs text-muted">
                {data.collector ? formatDateTime(data.collector.at) : "No heartbeat recorded yet"}
              </div>
            </div>
            <div>
              <div className="text-[0.6rem] font-bold tracking-[0.16em] text-muted uppercase">
                Collector mode
              </div>
              <div className="mt-1 text-sm text-white">{humanise(data.collectorMode)}</div>
              <div className="text-xs text-muted">
                {data.collectorMode === "simulated"
                  ? "Simulated data only"
                  : data.collectorMode === "off"
                    ? "Collection is disabled"
                    : "Polling configured devices"}
              </div>
            </div>
            <div>
              <div className="text-[0.6rem] font-bold tracking-[0.16em] text-muted uppercase">
                Last cycle detail
              </div>
              <div className="mt-1 text-sm text-white">
                {data.collector?.detail ?? "The collector has not reported yet."}
              </div>
            </div>
          </div>
          {collectorStale ? (
            <p className="mt-3 text-xs leading-relaxed text-amber-200/90">
              A stale collector does <strong>not</strong> mean the devices are down. Device states
              below are the last known states; treat them as unconfirmed until the collector
              reports again.
            </p>
          ) : null}
        </Panel>
      </div>

      {/* ------------------------------------------------------------ */}
      {/* Tiles                                                         */}
      {/* ------------------------------------------------------------ */}
      <Grid className="mb-4 grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Devices" value={data.devices} hint={`${data.monitored} monitored`} />
        <StatTile label="Ports" value={data.ports} hint="interfaces inventoried" />
        <StatTile
          label="Links"
          value={data.connections}
          hint={`${data.downLinks} down`}
          tone={data.downLinks > 0 ? "danger" : "default"}
        />
        <StatTile
          label="Open incidents"
          value={data.incidents.total}
          hint={`${data.incidents.acknowledged} acknowledged`}
          tone={data.incidents.critical > 0 ? "danger" : data.incidents.total > 0 ? "warn" : "ok"}
        />
        <StatTile
          label="Critical"
          value={data.incidents.critical}
          hint="need attention now"
          tone={data.incidents.critical > 0 ? "danger" : "muted"}
        />
        <StatTile
          label="Devices online"
          value={data.states.ONLINE ?? 0}
          hint={`of ${totalDevices} inventoried`}
          tone="ok"
        />
      </Grid>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* ---------------------------------------------------------- */}
        {/* State distribution                                         */}
        {/* ---------------------------------------------------------- */}
        <Panel
          title="Device states"
          subtitle="All nine states are reported separately — nothing is collapsed."
          className="xl:col-span-1"
        >
          <ul className="space-y-1.5">
            {HEALTH_STATES.map((state) => {
              const count = data.states[state] ?? 0;
              const share = totalDevices > 0 ? (count / totalDevices) * 100 : 0;
              return (
                <li key={state}>
                  <Link
                    href={`/devices?state=${encodeURIComponent(state)}`}
                    className="flex items-center gap-2 rounded-lg px-1.5 py-1 transition hover:bg-white/5"
                  >
                    <span className="w-28 shrink-0">
                      <StateBadge state={state} />
                    </span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/8">
                      <span
                        className={`block h-full rounded-full ${STATE_TONE[state]}`}
                        style={{ width: `${share}%` }}
                      />
                    </span>
                    <span className="w-8 shrink-0 text-right text-sm font-semibold tabular-nums text-white">
                      {count}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>

          <div className="mt-4 border-t border-white/8 pt-3">
            <div className="text-[0.6rem] font-bold tracking-[0.16em] text-muted uppercase">
              Devices by category
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.entries(data.categories)
                .sort((a, b) => b[1] - a[1])
                .map(([category, count]) => (
                  <Chip key={category} tone="muted">
                    {humanise(category)} · {count}
                  </Chip>
                ))}
              {Object.keys(data.categories).length === 0 ? (
                <span className="text-xs text-muted">No devices inventoried yet.</span>
              ) : null}
            </div>
          </div>
        </Panel>

        {/* ---------------------------------------------------------- */}
        {/* Active incidents                                           */}
        {/* ---------------------------------------------------------- */}
        <Panel
          title="Active incidents"
          subtitle="Deduplicated faults, newest first."
          className="xl:col-span-2"
          actions={
            <Link href="/incidents" className="btn btn--ghost btn--sm">
              Open queue
              <Icon name="chevron" size={12} />
            </Link>
          }
        >
          {data.activeIncidents.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">
              No active incidents. Nothing is currently failing.
            </p>
          ) : (
            <ul className="space-y-2">
              {data.activeIncidents.slice(0, 8).map((incident) => (
                <li key={incident.id}>
                  <Link
                    href={`/incidents/${incident.id}`}
                    className="glass-inset block px-3 py-2.5 transition hover:border-neon/40"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={incident.severity} />
                      <span className="text-sm font-semibold text-white">{incident.title}</span>
                      {incident.acknowledged ? (
                        <Chip tone="purple">acknowledged</Chip>
                      ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                      <span>open {durationSince(incident.startedAt)}</span>
                      {incident.deviceName ? <span>device: {incident.deviceName}</span> : null}
                      {incident.faultLocation ? (
                        <span>fault likely at: {incident.faultLocation}</span>
                      ) : null}
                      {incident.affected.length > 1 ? (
                        <span>{incident.affected.length} devices affected</span>
                      ) : null}
                    </div>
                    {incident.evidence ? (
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted/90">
                        {incident.evidence}
                      </p>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* ---------------------------------------------------------- */}
        {/* Busiest links                                              */}
        {/* ---------------------------------------------------------- */}
        <Panel
          title="Busiest links"
          subtitle="Measured rates only — a link with no measurement is not listed."
          className="xl:col-span-1"
        >
          {data.busiestLinks.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">
              No traffic has been measured yet.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {data.busiestLinks.map((link) => (
                <li
                  key={link.connectionId}
                  className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-1.5 hover:bg-white/5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm text-white">
                      {link.deviceName ?? "Unknown device"}
                    </div>
                    <div className="truncate text-xs text-muted">{link.portName ?? "unknown port"}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-semibold tabular-nums text-neon">
                      {link.rateLabel}
                    </div>
                    <div className="text-[0.68rem] text-muted">
                      {link.speedBps ? `of ${(link.speedBps / 1e9).toFixed(0)} Gbps` : "speed unknown"}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* ---------------------------------------------------------- */}
        {/* Event feed                                                 */}
        {/* ---------------------------------------------------------- */}
        <Panel
          title="Recent events"
          subtitle="Append-only operational history."
          className="xl:col-span-2"
          actions={
            <Link href="/events" className="btn btn--ghost btn--sm">
              Full history
              <Icon name="chevron" size={12} />
            </Link>
          }
        >
          {data.events.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No events recorded yet.</p>
          ) : (
            <ul className="scroll-thin max-h-[26rem] space-y-1 overflow-y-auto pr-1">
              {data.events.map((event) => (
                <li
                  key={event.id}
                  className="flex items-start gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-white/5"
                >
                  <span
                    className={`status-dot mt-1.5 ${
                      event.severity === "critical"
                        ? "status-dot--off"
                        : event.severity === "major" || event.severity === "minor"
                          ? "status-dot--warn"
                          : "status-dot--idle"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm text-white">{event.title}</span>
                      <span className="text-[0.68rem] text-muted">{timeAgo(event.at)}</span>
                    </div>
                    <div className="truncate text-xs text-muted">
                      {humanise(event.type)} · {event.detail}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
