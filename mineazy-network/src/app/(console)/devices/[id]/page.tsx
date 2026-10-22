"use client";

import { useParams } from "next/navigation";
import { Suspense } from "react";
import { useApi } from "@/components/useApi";
import { ErrorNote, KeyValue, Loading, PageHeader, Panel, StateBadge } from "@/components/ui";
import { humanise, timeAgo } from "@/components/format";
import type { Device, NetworkPort, Connection, Incident, TrafficSample } from "@/lib/types";
import type { TraceResult } from "@/lib/topology";

interface DeviceDetail {
  device: Device;
  ports: NetworkPort[];
  connections: Connection[];
  incidents: Incident[];
  trace: TraceResult | null;
  traffic: TrafficSample[];
  latestSample: TrafficSample | null;
}

export default function DeviceDetailPage() {
  // The device id is only known at runtime, so the part of the screen that
  // reads it is streamed in behind a Suspense boundary.
  return (
    <Suspense fallback={<Loading label="Loading device…" />}>
      <DeviceDetail />
    </Suspense>
  );
}

function DeviceDetail() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const { data, error, loading } = useApi<DeviceDetail>(id ? `/api/devices/${id}` : null);

  if (loading && !data) return <Loading label="Loading device…" />;
  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return null;

  const d = data.device;

  return (
    <>
      <PageHeader
        title={d.name}
        description={d.healthReason || ""}
        actions={<StateBadge state={d.healthState} title={d.healthReason} />}
      />
      <div className="grid gap-4 xl:grid-cols-3">
        <Panel title="Identity" className="xl:col-span-2">
          <KeyValue
            columns={2}
            items={[
              { label: "Hostname", value: d.hostname || "—" },
              { label: "Category", value: humanise(d.category) },
              { label: "Manufacturer/Model", value: [d.manufacturer, d.model].filter(Boolean).join(" / ") || "—" },
              { label: "Serial", value: d.serial || "—" },
              { label: "Management IP", value: d.mgmtIp || "—" },
              { label: "MAC", value: d.mac || "—" },
              { label: "OS", value: d.os || "—" },
              { label: "Criticality", value: humanise(d.criticality) },
              { label: "Monitoring", value: d.monitoringEnabled ? `${humanise(d.monitorMethod)} / ${d.pollIntervalSeconds}s` : "Disabled" },
              { label: "Source", value: `${humanise(d.discoverySource)} (${d.classificationConfidence})` },
              { label: "Simulated", value: d.simulated ? "Yes" : "No" },
              { label: "First seen", value: d.firstDiscoveredAt ? timeAgo(d.firstDiscoveredAt) : "—" },
              { label: "Last seen", value: d.lastSeenAt ? timeAgo(d.lastSeenAt) : "—" },
            ]}
          />
          {d.notes ? <p className="mt-3 text-sm text-muted">{d.notes}</p> : null}
        </Panel>
        <Panel title="Upstream path">
          {data.trace?.path ? (
            <p className="text-sm text-white">{data.trace.path}</p>
          ) : (
            <p className="text-sm text-muted">No trace available.</p>
          )}
        </Panel>
      </div>
      <div className="mt-4">
        <Panel title={`Ports (${data.ports.length})`}>
          {data.ports.length === 0 ? (
            <p className="text-sm text-muted">No ports recorded.</p>
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[800px]">
                <thead className="tbl-head">
                  <tr>
                    <th>Interface</th>
                    <th>Label</th>
                    <th>Admin/Oper</th>
                    <th>Speed</th>
                    <th>In/Out rate</th>
                    <th>Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ports.map((p) => (
                    <tr key={p.id} className="tbl-row">
                      <td className="text-white">{p.ifName}</td>
                      <td className="text-muted">{p.label || "—"}</td>
                      <td>{p.adminState}/{p.operState}</td>
                      <td>{p.speedBps ? `${Math.round(p.speedBps/1e6)} Mbps` : "—"}</td>
                      <td className="tabular-nums">{p.inRateBps !== null || p.outRateBps !== null ? `${Math.round((p.inRateBps??0)/1000)}k↓/${Math.round((p.outRateBps??0)/1000)}k↑` : "—"}</td>
                      <td>{(p.inErrors??0)+(p.outErrors??0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
