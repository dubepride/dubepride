"use client";

import { useApi } from "@/components/useApi";
import { ErrorNote, Loading, PageHeader, Panel } from "@/components/ui";
import { humanise } from "@/components/format";
import type { Location, Site } from "@/lib/types";

interface LocationsPayload {
  sites: Site[];
  locations: (Location & {
    deviceCount: number;
    devices: { id: number; name: string; state: string }[];
  })[];
  unassigned: number;
}

export default function LocationsPage() {
  const { data, error, loading } = useApi<LocationsPayload>("/api/locations");

  if (loading && !data) return <Loading label="Loading locations…" />;
  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return null;

  return (
    <>
      <PageHeader title="Locations" description="Physical layout for placing devices on the map and in reports." />
      <Panel title={`Locations (${data.locations.length}) · ${data.unassigned} unassigned devices`}>
        {data.locations.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No locations created yet.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.locations.map((loc) => (
              <div key={loc.id} className="glass-inset p-3">
                <div className="text-sm font-semibold text-white">{loc.name}</div>
                <div className="text-xs text-muted">{[loc.building, loc.room].filter(Boolean).join(" · ") || "—"}</div>
                <div className="mt-2 text-xs text-muted">{loc.deviceCount} device(s)</div>
                <ul className="mt-1 space-y-0.5">
                  {loc.devices.slice(0, 6).map((d) => (
                    <li key={d.id} className="text-xs text-white">{d.name} <span className="text-muted">({humanise(d.state)})</span></li>
                  ))}
                  {loc.devices.length > 6 ? <li className="text-xs text-muted">+{loc.devices.length - 6} more</li> : null}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}
