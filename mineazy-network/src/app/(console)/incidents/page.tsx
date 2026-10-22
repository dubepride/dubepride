"use client";

import Link from "next/link";
import { useApi } from "@/components/useApi";
import { apiPatch } from "@/components/api";
import {
  Chip,
  EmptyState,
  ErrorNote,
  Loading,
  PageHeader,
  Panel,
  SeverityBadge,
} from "@/components/ui";
import { Icon } from "@/components/Icon";
import { durationSince, formatDateTime } from "@/components/format";
import type { Incident } from "@/lib/types";
import { useState } from "react";

interface IncidentsPayload {
  incidents: (Incident & { deviceName: string | null; affectedNames: string[] })[];
  counts: { total: number; open: number; acknowledged: number; resolved: number };
}

export default function IncidentsPage() {
  const { data, error, loading, reload } = useApi<IncidentsPayload>("/api/incidents?state=active", {
    pollMs: 15_000,
  });
  const [acting, setActing] = useState<number | null>(null);

  const act = async (id: number, action: string, body: Record<string, unknown> = {}): Promise<void> => {
    setActing(id);
    try {
      await apiPatch(`/api/incidents/${id}`, { action, ...body });
      reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(null);
    }
  };

  if (loading && !data) return <Loading label="Loading incidents…" />;
  if (error && !data) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return null;

  return (
    <>
      <PageHeader
        title="Incidents"
        description="Deduplicated open incidents with evidence. Acknowledge without resolving; recovery closes incidents only when observed."
        actions={
          <div className="flex flex-wrap gap-2">
            <Chip tone="danger">{data.counts.open} open</Chip>
            <Chip tone="purple">{data.counts.acknowledged} acknowledged</Chip>
            <Chip tone="muted">{data.counts.resolved} resolved</Chip>
          </div>
        }
      />

      {data.incidents.length === 0 ? (
        <Panel>
          <EmptyState title="All clear" description="No open or acknowledged incidents right now." />
        </Panel>
      ) : (
        <div className="space-y-3">
          {data.incidents.map((incident) => (
            <Panel
              key={incident.id}
              title={incident.title}
              subtitle={incident.key}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={incident.severity} />
                  {incident.acknowledged ? <Chip tone="purple">acknowledged</Chip> : <Chip tone="warn">unacknowledged</Chip>}
                </div>
              }
            >
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span>Open {durationSince(incident.startedAt)}</span>
                <span>Started {formatDateTime(incident.startedAt)}</span>
                {incident.deviceName ? <span>Primary device: {incident.deviceName}</span> : null}
                {incident.faultLocation ? <span>Fault likely at: {incident.faultLocation}</span> : null}
                <span>Confidence {(incident.confidence * 100).toFixed(0)}%</span>
              </div>

              {incident.evidence ? (
                <pre className="mb-3 scroll-thin max-h-40 overflow-auto rounded-xl border border-white/10 bg-black/50 p-3 text-xs leading-relaxed whitespace-pre-wrap text-muted">
                  {incident.evidence}
                </pre>
              ) : null}

              {incident.affected.length > 0 ? (
                <div className="mb-3">
                  <div className="mb-1 text-[0.6rem] font-bold tracking-[0.16em] text-muted uppercase">
                    Affected
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {incident.affectedNames.map((name, i) => (
                      <Chip key={i} tone="muted">
                        {name}
                      </Chip>
                    ))}
                  </div>
                </div>
              ) : null}

              {incident.notes ? (
                <div className="mb-3 rounded-xl border border-white/10 bg-black/30 p-3 text-sm text-muted">
                  {incident.notes}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                {!incident.acknowledged ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={acting === incident.id}
                    onClick={() => act(incident.id, "acknowledge")}
                  >
                    {acting === incident.id ? <span className="spinner spinner--light" /> : <Icon name="check" size={13} />}
                    Acknowledge
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={acting === incident.id}
                  onClick={() => {
                    const note = prompt("Add a note to this incident:");
                    if (note) act(incident.id, "note", { note });
                  }}
                >
                  Add note
                </button>
                <button
                  type="button"
                  className="btn btn--neon btn--sm"
                  disabled={acting === incident.id}
                  onClick={() => {
                    const note = prompt("Resolution note (optional):");
                    act(incident.id, "resolve", { note: note ?? "Closed manually by an operator." });
                  }}
                >
                  Resolve
                </button>
                <Link
                  href={`/map?focus=${incident.deviceId}`}
                  className="btn btn--ghost btn--sm ml-auto"
                  title="Open the live map focused on this device and highlight its upstream path"
                >
                  <Icon name="map" size={13} />
                  Show on map
                </Link>
                <Link href={`/devices/${incident.deviceId}`} className="btn btn--ghost btn--sm">
                  View device
                  <Icon name="chevron" size={12} />
                </Link>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
