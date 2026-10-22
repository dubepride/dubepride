"use client";

import { useApi } from "@/components/useApi";
import { downloadCsv } from "@/components/api";
import { ErrorNote, Loading, PageHeader, Panel, StatTile, Grid } from "@/components/ui";
import { humanise } from "@/components/format";

interface ReportsPayload {
  devices: number;
  monitored: number;
  ports: number;
  connections: number;
  downLinks: number;
  incidents: number;
  openIncidents: number;
  events: number;
  states: Record<string, number>;
}

export default function ReportsPage() {
  const { data, error, loading, reload } = useApi<ReportsPayload>("/api/reports");

  if (loading && !data) return <Loading label="Loading reports…" />;
  if (error && !data) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return null;

  const exportReport = async (kind: string): Promise<void> => {
    try {
      await downloadCsv(kind);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <PageHeader title="Reports" description="Export CSV reports generated from stored evidence." />
      <Grid className="mb-4 grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Devices" value={data.devices} hint={`${data.monitored} monitored`} />
        <StatTile label="Ports" value={data.ports} />
        <StatTile label="Connections" value={data.connections} hint={`${data.downLinks} down`} />
        <StatTile label="Incidents" value={data.incidents} hint={`${data.openIncidents} open`} />
      </Grid>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Panel title="Inventory exports">
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => exportReport("devices")}>Devices CSV</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => exportReport("ports")}>Ports CSV</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => exportReport("connections")}>Connections CSV</button>
          </div>
        </Panel>
        <Panel title="Operations exports">
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => exportReport("incidents")}>Incidents CSV</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => exportReport("events")}>Events CSV</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => exportReport("audit")}>Audit CSV</button>
          </div>
        </Panel>
        <Panel title="State breakdown">
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(data.states).map(([k,v]) => (
              <span key={k} className="chip chip--muted">{humanise(k)} · {v}</span>
            ))}
          </div>
        </Panel>
      </div>
    </>
  );
}
