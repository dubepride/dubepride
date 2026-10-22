"use client";

import Link from "next/link";
import { useApi } from "@/components/useApi";
import { ErrorNote, Loading, PageHeader, Panel, StateBadge } from "@/components/ui";
import { humanise } from "@/components/format";
import type { Device, NetworkPort } from "@/lib/types";

interface SwitchView {
  device: Device;
  ports: NetworkPort[];
  summary: { total: number; active: number; withConnection: number; unresolved: number; down: number };
  connections: number;
}

interface SwitchesPayload {
  switches: SwitchView[];
  count: number;
}

export default function SwitchesPage() {
  const { data, error, loading, reload } = useApi<SwitchesPayload>("/api/switches", { pollMs: 30_000 });

  if (loading && !data) return <Loading label="Loading switches…" />;
  if (error && !data) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return null;

  return (
    <>
      <PageHeader
        title="Switches & Ports"
        description="Switches are first-class objects. See how many ports are up/down and which ones are unresolved."
      />
      {data.switches.length === 0 ? (
        <Panel>
          <p className="py-6 text-center text-sm text-muted">No switches are in the inventory yet.</p>
        </Panel>
      ) : (
        <div className="space-y-4">
          {data.switches.map((sw) => (
            <Panel
              key={sw.device.id}
              title={sw.device.name}
              subtitle={sw.device.hostname || sw.device.mgmtIp || humanise(sw.device.category)}
              actions={<StateBadge state={sw.device.healthState} />}
            >
              <div className="mb-3 flex flex-wrap gap-2 text-xs text-muted">
                <span>{sw.summary.total} ports</span>
                <span>· {sw.summary.active} up</span>
                <span>· {sw.summary.down} down</span>
                <span>· {sw.summary.unresolved} up but unconnected</span>
                <span>· {sw.connections} known links</span>
              </div>
              <div className="scroll-thin overflow-x-auto">
                <table className="w-full min-w-[900px]">
                  <thead className="tbl-head">
                    <tr>
                      <th>Interface</th>
                      <th>Port #</th>
                      <th>Label</th>
                      <th>Admin/Oper</th>
                      <th>Speed</th>
                      <th>VLAN</th>
                      <th>In/Out rate</th>
                      <th>Errors</th>
                      <th>Managed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sw.ports.map((port) => (
                      <tr key={port.id} className="tbl-row tbl-row--clickable">
                        <td>
                          <Link href={`/devices/${sw.device.id}#port-${port.id}`} className="block text-white">
                            {port.ifName}
                          </Link>
                          <div className="text-xs text-muted">{port.description || "—"}</div>
                        </td>
                        <td>{port.portNumber ?? "—"}</td>
                        <td>{port.label || "—"}</td>
                        <td>
                          {port.adminState}/{port.operState}
                        </td>
                        <td>{port.speedBps ? `${Math.round(port.speedBps / 1e6)} Mbps` : "—"}</td>
                        <td>{port.vlan ?? "—"}</td>
                        <td className="tabular-nums">
                          {port.inRateBps !== null || port.outRateBps !== null
                            ? `${Math.round((port.inRateBps ?? 0) / 1000)}k↓ / ${Math.round((port.outRateBps ?? 0) / 1000)}k↑ bps`
                            : "—"}
                        </td>
                        <td>{(port.inErrors ?? 0) + (port.outErrors ?? 0)}</td>
                        <td>{port.managed ? "yes" : "no"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
