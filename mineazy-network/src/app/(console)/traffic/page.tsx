"use client";

import { useApi } from "@/components/useApi";
import { ErrorNote, Loading, PageHeader, Panel } from "@/components/ui";
import { formatBandwidth } from "@/components/format";

interface TrafficPayload {
  hours: number;
  links: {
    connectionId: number;
    state: string;
    deviceName: string | null;
    portName: string | null;
    speedBps: number | null;
    inRateBps: number | null;
    outRateBps: number | null;
    utilisationPct: number | null;
    measured: boolean;
  }[];
  top: { subjectType: string; subjectId: number; name: string; maxRateBps: number | null; samples: number; formattedTotal: string }[];
}

export default function TrafficPage() {
  const { data, error, loading, reload } = useApi<TrafficPayload>("/api/traffic?hours=24", { pollMs: 30_000 });

  if (loading && !data) return <Loading label="Loading traffic…" />;
  if (error && !data) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return null;

  return (
    <>
      <PageHeader title="Traffic" description="Rates derived from counter deltas. Cumulative counters are never shown as speed." />
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Links (current rates)">
          {data.links.filter((l) => l.measured).length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No measured rates yet.</p>
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[700px]">
                <thead className="tbl-head">
                  <tr>
                    <th>Device</th>
                    <th>Port</th>
                    <th>Down</th>
                    <th>Up</th>
                    <th>Utilisation</th>
                    <th>Speed</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {data.links
                    .filter((l) => l.measured)
                    .map((link) => (
                      <tr key={link.connectionId} className="tbl-row">
                        <td className="text-white">{link.deviceName ?? "—"}</td>
                        <td className="text-muted">{link.portName ?? "—"}</td>
                        <td className="tabular-nums text-white">{formatBandwidth(link.inRateBps)}</td>
                        <td className="tabular-nums text-white">{formatBandwidth(link.outRateBps)}</td>
                        <td className="tabular-nums">{link.utilisationPct !== null ? `${link.utilisationPct.toFixed(1)}%` : "—"}</td>
                        <td className="text-muted">{link.speedBps ? `${Math.round(link.speedBps / 1e9)} Gbps` : "—"}</td>
                        <td className="text-muted">{link.state}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        <Panel title="Top subjects (24h peak)">
          {data.top.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No samples recorded yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {data.top.map((t) => (
                <li key={`${t.subjectType}-${t.subjectId}`} className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-1.5">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-white">{t.name}</div>
                    <div className="text-xs text-muted">{t.samples} samples · {t.subjectType}</div>
                  </div>
                  <div className="text-sm font-semibold tabular-nums text-neon">{t.formattedTotal}</div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
