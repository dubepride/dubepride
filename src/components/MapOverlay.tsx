"use client";

/**
 * ============================================================================
 *  MapOverlay — the app-wide "big picture" map (Phase 18)
 * ============================================================================
 *
 *  A floating map button is mounted in the app chrome (src/components/
 *  AppChrome.tsx) so it is reachable from EVERY page. Opening it shows a
 *  full-screen map of:
 *
 *    • every geofenced site  (green circle = accepts mobile clocking,
 *      grey = biometric-only), and
 *    • the most recent GPS punch locations (green = verified, red = denied).
 *
 *  Data comes from GET /api/map/overview, which is session-gated and
 *  permission-aware: administrators see every site and everyone's punches;
 *  everyone else sees the mobile-capable fences and only their own punches.
 *
 *  This is a display layer only. The bridge re-derives the governing site from
 *  the submitted coordinates on every punch, so nothing shown (or tampered
 *  with) here can move where a punch lands. If tiles fail to load, MapCanvas
 *  falls back gracefully and the distances remain exact.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MapCanvas, { type MapCircle, type MapMarker } from "./MapCanvas";
import { IconLocate, IconMap, IconX } from "./icons";
import type { MapOverviewResponse } from "@/lib/types";

type Status = "idle" | "loading" | "ready" | "error";

/** "2026-10-15 08:41" — compact local timestamp for the footer. */
function shortStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function relative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  return `${Math.round(diff / 86_400_000)} d ago`;
}

export default function MapOverlay({ hidden = false }: { hidden?: boolean }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [data, setData] = useState<MapOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [focus, setFocus] = useState<{ latitude: number; longitude: number; zoom?: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/map/overview", { cache: "no-store" });
      const json = (await res.json()) as MapOverviewResponse & { error?: string };
      if (res.ok && json.ok) {
        setData(json);
        setStatus("ready");
      } else {
        setError(json.error ?? "Could not load the map.");
        setStatus("error");
      }
    } catch {
      setError("Could not reach the bridge to load the map.");
      setStatus("error");
    }
  }, []);

  // Opening the overlay loads the data the first time (and after an error or
  // an explicit refresh). Kept in the handler rather than an effect so we never
  // call setState synchronously inside an effect body.
  const openOverlay = useCallback(() => {
    setOpen(true);
    if (status === "idle" || status === "error") void load();
  }, [status, load]);

  // While open: lock background scroll and close on Escape.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    panelRef.current?.focus();

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const locateMe = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("This browser does not support geolocation.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const point = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        setMe(point);
        setFocus({ ...point, zoom: 16 });
        setLocating(false);
      },
      () => {
        setError("Could not read your location. Check the browser's location permission.");
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 }
    );
  }, []);

  const circles: MapCircle[] = useMemo(
    () =>
      (data?.sites ?? []).map((site) => ({
        id: `site-${site.id}`,
        latitude: site.latitude,
        longitude: site.longitude,
        radiusMeters: site.radiusMeters,
        tone: site.mobile ? "neon" : "muted",
      })),
    [data]
  );

  const markers: MapMarker[] = useMemo(() => {
    const pins: MapMarker[] = (data?.punches ?? []).map((p) => ({
      id: `punch-${p.logId}`,
      latitude: p.latitude,
      longitude: p.longitude,
      label: `${p.employeeName} · ${p.insideGeofence ? "verified" : "denied"} · ${relative(p.timestamp)}`,
      tone: p.insideGeofence ? "neon" : "danger",
    }));
    if (me) pins.push({ id: "me", latitude: me.latitude, longitude: me.longitude, label: "You", tone: "user" });
    return pins;
  }, [data, me]);

  const center = data?.center ?? { latitude: -17.8292, longitude: 31.0522 };

  if (hidden) return null;

  return (
    <>
      {/* Floating launcher — visible on every page. */}
      <button
        type="button"
        className="bb-map-fab"
        onClick={openOverlay}
        aria-label="Open site map"        title="Open site map"
      >
        <IconMap className="h-5 w-5" />
        <span className="bb-map-fab__label">Map</span>
      </button>

      {open ? (
        <div
          className="bb-map-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Site and punch map"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="bb-map-overlay__panel glass" ref={panelRef} tabIndex={-1}>
            <header className="bb-map-overlay__head">
              <div className="min-w-0">
                <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">Site &amp; Punch Map</h2>
                <p className="mt-1 truncate text-[11px] text-muted">
                  {data
                    ? `${data.scope === "org" ? "All sites" : "Your sites"} · ${data.sites.length} site${
                        data.sites.length === 1 ? "" : "s"
                      } · last ${Math.round(data.windowMs / 3_600_000)} h`
                    : "Geofenced sites and recent GPS clock-ins"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={locateMe}
                  disabled={locating}
                  title="Centre the map on my location"
                >
                  <IconLocate className="h-4 w-4" />
                  <span className="hidden sm:inline">{locating ? "Locating…" : "My location"}</span>
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => void load()}
                  disabled={status === "loading"}
                  title="Refresh"
                >
                  {status === "loading" ? "Loading…" : "Refresh"}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--icon"
                  onClick={() => setOpen(false)}
                  aria-label="Close map"
                  title="Close (Esc)"
                >
                  <IconX className="h-4 w-4" />
                </button>
              </div>
            </header>

            <div className="bb-map-overlay__body">
              {status === "loading" && !data ? (
                <div className="bb-map-overlay__placeholder">Loading map…</div>
              ) : status === "error" && !data ? (
                <div className="bb-map-overlay__placeholder text-danger">{error}</div>
              ) : (
                <MapCanvas
                  center={center}
                  markers={markers}
                  circles={circles}
                  focus={focus}
                  height="100%"
                  className="bb-map-overlay__canvas"
                  ariaLabel="Geofenced sites and recent punch locations"
                />
              )}
            </div>

            <footer className="bb-map-overlay__foot">
              <div className="bb-map-legend">
                <span className="bb-map-legend__item">
                  <i className="bb-pin bb-pin--neon" aria-hidden="true" /> Verified punch
                </span>
                <span className="bb-map-legend__item">
                  <i className="bb-pin bb-pin--danger" aria-hidden="true" /> Denied punch
                </span>
                <span className="bb-map-legend__item">
                  <i className="bb-map-legend__ring" aria-hidden="true" /> Mobile site
                </span>
                <span className="bb-map-legend__item">
                  <i className="bb-map-legend__ring bb-map-legend__ring--muted" aria-hidden="true" /> Terminal-only site
                </span>
              </div>
              <p className="bb-map-overlay__meta">
                {data ? `Updated ${shortStamp(data.generatedAt)} · ${data.punches.length} shown` : ""}
              </p>
            </footer>

            {error && data ? (
              <p role="alert" className="bb-map-overlay__stale">
                {error}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
