"use client";

import { useApi } from "@/components/useApi";
import { ErrorNote, Loading, PageHeader, Panel } from "@/components/ui";
import { formatDateTime, humanise } from "@/components/format";

interface EventsPayload {
  events: { id: number; at: number; type: string; severity: string; title: string; detail: string; subjectType: string; source: string }[];
}

export default function EventsPage() {
  const { data, error, loading, reload } = useApi<EventsPayload>("/api/events?limit=500", { pollMs: 30_000 });

  if (loading && !data) return <Loading label="Loading event history…" />;
  if (error && !data) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return null;

  return (
    <>
      <PageHeader title="Event History" description="Append-only operational log." />
      <Panel title={`Events (${data.events.length})`}>
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead className="tbl-head">
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Severity</th>
                <th>Title</th>
                <th>Detail</th>
                <th>Subject</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((ev) => (
                <tr key={ev.id} className="tbl-row">
                  <td className="text-xs text-muted whitespace-nowrap">{formatDateTime(ev.at)}</td>
                  <td>{humanise(ev.type)}</td>
                  <td>{humanise(ev.severity)}</td>
                  <td className="text-white">{ev.title}</td>
                  <td className="max-w-[420px] truncate text-muted" title={ev.detail}>{ev.detail}</td>
                  <td className="text-muted">{ev.subjectType}</td>
                  <td className="text-muted">{ev.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
