"use client";

/**
 * FieldTracker — live map of tracked phones inside the organisation's fences.
 *
 *  • Every geo-ready site is drawn (green = accepts mobile clocking, grey =
 *    biometric-only). Picking a site in the rail filters the dots and pans the
 *    map to that fence, so "navigate to any branch" needs no extra page.
 *  • Dots are ANY tracked phone inside the selected fence. Being clocked in is
 *    a badge in the directory + tooltip, never a filter.
 *  • Hovering a dot shows the Mine Eazy employee number first.
 *  • The server decides containment from live Branches/Terminals geometry;
 *    the client only filters the snapshot it is given.
 *
 *  Data comes from GET /api/field-tracker (dedicated `can_view_live_map`).
 *  Polls every 10 s. MapCanvas preserves the user's pan/zoom across polls.
 */

import { useCallback, useMemo, useState } from "react";
import type { FieldTrackerDevice, FieldTrackerResponse } from "@/lib/types";
import {
  formatDistance,
  freshnessLabel,
  markerLines,
  matchesFieldTrackerQuery,
  sortFieldTrackerDevices,
  statusLabel,
} from "@/lib/field-tracker";
import { clockingMethodShort } from "@/lib/geofence";
import { formatPunchTime } from "@/lib/format";
import { usePoll } from "@/lib/use-poll";
import FieldTrackerDirectory from "./FieldTrackerDirectory";
import MapCanvas, { type MapCircle, type MapMarker } from "./MapCanvas";
import { IconLocate, IconSearch } from "./icons";

const POLL_MS = 10_000;
/** Zimbabwe centroid — only used while the snapshot is still loading. */
const FALLBACK_CENTER = { latitude: -19.0154, longitude: 29.1549 };

interface Focus {
  latitude: number;
  longitude: number;
  zoom?: number;
}

export default function FieldTracker() {
  const { data, error, loading, refresh } = usePoll<FieldTrackerResponse>(
    "/api/field-tracker",
    POLL_MS
  );

  const [branch, setBranch] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);

  const sites = useMemo(
    () =>
      [...(data?.sites ?? [])].sort(
        (a, b) => b.tracked - a.tracked || a.branch.localeCompare(b.branch)
      ),
    [data]
  );
  const counts = data?.counts;
  // Snapshot clock, not render time — also avoids `Date.now()` during prerender.
  const now = data?.generatedAt ?? 0;

  const visible = useMemo(() => {
    const text = query.trim();
    return sortFieldTrackerDevices(
      (data?.devices ?? []).filter((device) => {
        if (branch && (device.branch ?? "").toLowerCase() !== branch.toLowerCase()) {
          return false;
        }
        return matchesFieldTrackerQuery(device, text);
      })
    );
  }, [data, branch, query]);

  const allDevices = data?.devices ?? [];
  const selected = useMemo(
    () => allDevices.find((device) => device.employeeId === selectedId) ?? null,
    [allDevices, selectedId]
  );

  const center = useMemo(() => {
    if (sites.length === 0) return FALLBACK_CENTER;
    const sum = sites.reduce(
      (acc, site) => ({
        latitude: acc.latitude + site.latitude,
        longitude: acc.longitude + site.longitude,
      }),
      { latitude: 0, longitude: 0 }
    );
    return {
      latitude: sum.latitude / sites.length,
      longitude: sum.longitude / sites.length,
    };
  }, [sites]);

  const circles: MapCircle[] = useMemo(
    () =>
      sites.map((site) => ({
        id: `site-${site.id}`,
        latitude: site.latitude,
        longitude: site.longitude,
        radiusMeters: site.radiusMeters,
        tone: site.mobile ? "neon" : "muted",
      })),
    [sites]
  );

  const markers: MapMarker[] = useMemo(
    () =>
      visible.map((device) => {
        const lines = markerLines(device, now);
        return {
          id: `emp-${device.employeeId}`,
          latitude: device.latitude,
          longitude: device.longitude,
          label: lines[0],
          lines: lines.slice(1),
          tone:
            device.status === "live"
              ? "neon"
              : device.insideFence
                ? "muted"
                : "danger",
          selected: device.employeeId === selectedId,
        } satisfies MapMarker;
      }),
    [visible, now, selectedId]
  );

  const pickDevice = useCallback((device: FieldTrackerDevice) => {
    setSelectedId(device.employeeId);
    setFocus({ latitude: device.latitude, longitude: device.longitude, zoom: 18 });
  }, []);

  const onMarkerClick = useCallback(
    (id: string) => {
      const employeeId = Number(id.replace(/^emp-/, ""));
      const device = allDevices.find((row) => row.employeeId === employeeId);
      if (device) pickDevice(device);
    },
    [allDevices, pickDevice]
  );

  const onCircleClick = useCallback(
    (id: string) => {
      const siteId = Number(id.replace(/^site-/, ""));
      const site = sites.find((row) => row.id === siteId);
      if (!site) return;
      const next = branch?.toLowerCase() === site.branch.toLowerCase() ? null : site.branch;
      setBranch(next);
      if (next) {
        setFocus({ latitude: site.latitude, longitude: site.longitude, zoom: 17 });
      } else {
        setFocus({ ...center, zoom: 7 });
      }
    },
    [branch, center, sites]
  );

  const pickBranch = useCallback(
    (name: string | null) => {
      setBranch((current) =>
        current?.toLowerCase() === name?.toLowerCase() ? null : name
      );
      if (name) {
        const site = sites.find((row) => row.branch.toLowerCase() === name.toLowerCase());
        if (site) {
          setFocus({ latitude: site.latitude, longitude: site.longitude, zoom: 17 });
          return;
        }
      }
      setFocus({ ...center, zoom: 7 });
    },
    [center, sites]
  );

  const locateMe = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setFocus({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          zoom: 17,
        }),
      () => undefined,
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 }
    );
  }, []);

  return (
    <div className="space-y-6">
      {/* Page header -------------------------------------------------- */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Field Tracker</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Live phone locations inside every geofence. Hover a dot for the
            employee number, or pick a branch to zoom into its sites.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip chip--neon">{counts?.tracked ?? 0} TRACKED</span>
          <span className="chip chip--muted">{counts?.live ?? 0} LIVE</span>
          {counts && counts.stale > 0 ? (
            <span className="chip chip--warn">{counts.stale} STALE</span>
          ) : null}
          <span className="chip chip--muted">{counts?.fences ?? 0} FENCES</span>
        </div>
      </div>

      {error && !data ? (
        <p className="rise rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Field Tracker unavailable — {error}. Retrying…
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[250px_minmax(0,1fr)]">
        {/* Branch rail ------------------------------------------------ */}
        <aside className="glass flex flex-col overflow-hidden">
          <div className="accent-line" aria-hidden="true" />
          <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
            <span className="text-[10px] font-bold tracking-[0.22em] text-muted uppercase">
              Branches
            </span>
            <span className="font-mono text-[10px] text-muted tabular-nums">
              {sites.length}
            </span>
          </div>
          <div className="scroll-thin max-h-[520px] overflow-y-auto p-2">
            <button
              type="button"
              onClick={() => pickBranch(null)}
              aria-pressed={branch === null}
              className={`mb-1 flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                branch === null
                  ? "border-neon/40 bg-neon/10 text-neon"
                  : "border-transparent text-muted hover:bg-white/[0.05] hover:text-ink"
              }`}
            >
              <span className="font-semibold">All branches</span>
              <span className="font-mono text-[10px] tabular-nums">
                {counts?.tracked ?? 0}
              </span>
            </button>

            {sites.map((site) => {
              const active = branch?.toLowerCase() === site.branch.toLowerCase();
              return (
                <button
                  key={site.id}
                  type="button"
                  onClick={() =>
                    pickBranch(active ? null : site.branch)
                  }
                  aria-pressed={active}
                  title={`${site.branch} · ${clockingMethodShort(site.method)}`}
                  className={`mb-1 flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${
                    active
                      ? "border-neon/40 bg-neon/10"
                      : "border-transparent hover:bg-white/[0.05]"
                  }`}
                >
                  <span
                    className={`h-2 w-2 flex-none rounded-full ${
                      site.mobile ? "bg-neon" : "bg-white/50"
                    }`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-xs font-semibold ${
                        active ? "text-neon" : "text-ink"
                      }`}
                    >
                      {site.branch}
                    </span>
                    <span className="block text-[10px] text-muted">
                      {clockingMethodShort(site.method)}
                      {site.clockedIn > 0 ? ` · ${site.clockedIn} in` : ""}
                    </span>
                  </span>
                  <span className="flex-none font-mono text-[11px] text-muted tabular-nums">
                    {site.tracked}
                  </span>
                </button>
              );
            })}

            {sites.length === 0 && !loading ? (
              <p className="px-3 py-6 text-center text-[11px] text-muted">
                No branch has a geofence configured yet.
              </p>
            ) : null}
          </div>
        </aside>

        {/* Map -------------------------------------------------------- */}
        <section className="glass relative overflow-hidden">
          <div className="accent-line" aria-hidden="true" />

          <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-4 py-3">
            <IconSearch className="h-4 w-4 flex-none text-neon" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search employee number or name"
              aria-label="Search employee number or name"
              className="min-w-40 flex-1 bg-transparent text-sm text-ink placeholder:text-muted/70 focus:outline-none"
            />
            <button
              type="button"
              onClick={locateMe}
              className="btn btn--ghost btn--sm"
              title="Centre the map on my location"
            >
              <IconLocate className="h-4 w-4" />
              <span className="hidden sm:inline">My location</span>
            </button>
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              className="btn btn--ghost btn--sm"
              title="Refresh now"
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>

          {loading && !data ? (
            <div className="grid h-[520px] place-items-center text-sm text-muted">
              Loading tracked phones…
            </div>
          ) : (
            <MapCanvas
              center={center}
              circles={circles}
              markers={markers}
              focus={focus}
              onMarkerClick={onMarkerClick}
              onCircleClick={onCircleClick}
              height="min(62vh, 560px)"
              className="rounded-none border-0"
              ariaLabel="Live tracked phone locations"
            />
          )}

          {selected ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/[0.07] bg-neon/[0.04] px-4 py-2.5 text-[11px]">
              <span className="font-mono text-sm font-extrabold text-neon">
                {selected.employeeNumber}
              </span>
              <span className="font-semibold text-ink">{selected.fullName}</span>
              <span className="text-muted">
                {selected.branch ?? "Outside every fence"} ·{" "}
                {freshnessLabel(selected, now)} · {statusLabel(selected.status)}
              </span>
              <span className="text-muted">
                {selected.clockedIn
                  ? `Clocked in${
                      selected.clockedInAt ? ` at ${formatPunchTime(selected.clockedInAt)}` : ""
                    }`
                  : "Not clocked in"}
              </span>
              {selected.distanceMeters != null ? (
                <span className="font-mono text-muted/80 tabular-nums">
                  {formatDistance(selected.distanceMeters)} from centre
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="ml-auto text-[10px] font-bold tracking-wider text-muted uppercase hover:text-ink"
              >
                Clear
              </button>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-4 border-t border-white/[0.06] px-4 py-2.5">
            <span className="bb-map-legend__item">
              <i className="bb-pin bb-pin--neon" aria-hidden="true" /> Live fix
            </span>
            <span className="bb-map-legend__item">
              <i className="bb-pin bb-pin--muted" aria-hidden="true" /> Last known
            </span>
            <span className="bb-map-legend__item">
              <i className="bb-map-legend__ring" aria-hidden="true" /> Mobile fence
            </span>
            <span className="bb-map-legend__item">
              <i className="bb-map-legend__ring bb-map-legend__ring--muted" aria-hidden="true" />{" "}
              Biometric-only fence
            </span>
            {data ? (
              <span className="ml-auto font-mono text-[10px] text-muted tabular-nums">
                {visible.length} shown · updated{" "}
                {new Date(data.generatedAt).toLocaleTimeString("en-GB", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
            ) : null}
          </div>
        </section>
      </div>

      {/* Directory ---------------------------------------------------- */}
      <section className="glass overflow-hidden">
        <div className="accent-line" aria-hidden="true" />
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3 sm:px-5">
          <div>
            <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">
              Tracked directory
            </h2>
            <p className="mt-1 text-[11px] text-muted">
              Employee number first. Click a row to spotlight its dot.
            </p>
          </div>
          <span className="chip chip--neon">{visible.length} SHOWN</span>
        </div>

        <FieldTrackerDirectory
          devices={visible}
          selectedId={selectedId}
          onSelect={pickDevice}
          now={now}
          emptyMessage={
            allDevices.length === 0
              ? "No phones are reporting a location right now. They appear here while staff are signed into the mobile app inside a fence."
              : branch
                ? `No tracked phone is inside ${branch} right now.`
                : "No employee matches this view."
          }
        />
      </section>
    </div>
  );
}
