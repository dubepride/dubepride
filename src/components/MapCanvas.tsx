"use client";

/**
 * ============================================================================
 *  MapCanvas — the shared Leaflet surface (Phase 18)
 * ============================================================================
 *
 *  One small, reusable map used by BOTH new admin and employee surfaces:
 *    • Settings → Branches   (draggable geofence centre + radius circle)
 *    • My Portal             (sites + your live GPS position)
 *
 *  Design notes
 *  ────────────
 *  • SSR-safe: `leaflet` touches `window` at import time, so the library is
 *    imported dynamically INSIDE an effect and never evaluated on the server
 *    (only its TYPES are imported statically — erased at compile time).
 *  • Graceful degradation: when no tile provider is configured the component
 *    draws a self-contained SVG schematic of the fence(s) and marker(s). The
 *    map is a courtesy layer — the geofence verdict is always server-side, so
 *    a missing tile key can never produce a false clock-in.
 *  • Theme-matched pins are Leaflet `divIcon`s (no broken default marker PNGs
 *    under bundlers).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type * as LeafletNS from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  isDemoTiles,
  isMapConfigured,
  mapAttribution,
  tileUrlTemplate,
  TILE_SUBDOMAINS,
  zoomForRadius,
} from "@/lib/maps";

export type MapTone = "neon" | "muted" | "danger" | "user";

export interface MapMarker {
  id: string;
  latitude: number;
  longitude: number;
  label?: string;
  tone?: MapTone;
  /** When true (and interactive) the pin can be dragged; fires onMarkerDrag. */
  draggable?: boolean;
}

export interface MapCircle {
  id: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  tone?: "neon" | "muted";
}

export interface MapCanvasProps {
  /** Fallback centre (used when there is nothing to fit, or fit={false}). */
  center: { latitude: number; longitude: number };
  zoom?: number;
  markers?: MapMarker[];
  circles?: MapCircle[];
  /** Pan/zoom when true; a static diagram when false. */
  interactive?: boolean;
  /** Fit the view to all circles/markers (default true). */
  fit?: boolean;
  /** Pan/zoom to this point whenever it changes (e.g. "centre on me"). */
  focus?: { latitude: number; longitude: number; zoom?: number } | null;
  /** Enables drag-to-position on markers flagged `draggable`. */
  onMarkerDrag?: (id: string, latitude: number, longitude: number) => void;
  /** Enables click-to-position anywhere on the map. */
  onMapClick?: (latitude: number, longitude: number) => void;
  height?: number | string;
  className?: string;
  ariaLabel?: string;
}

const FALLBACK_HEIGHT = 320;

function heightValue(height: number | string | undefined): string {
  if (typeof height === "number") return `${height}px`;
  return height ?? `${FALLBACK_HEIGHT}px`;
}

/* ================================================================== */
/* Schematic fallback (no tile provider configured)                    */
/* ================================================================== */

const METRES_PER_DEG_LAT = 111_320;

function SchematicMap({
  center,
  markers,
  circles,
  height,
  className,
  ariaLabel,
}: Pick<MapCanvasProps, "center" | "markers" | "circles" | "height" | "className" | "ariaLabel">) {
  const view = 200; // viewBox is -100..100
  const pad = 12;

  const { items, maxExtent } = useMemo(() => {
    const mPerDegLng = METRES_PER_DEG_LAT * Math.max(0.05, Math.cos((center.latitude * Math.PI) / 180));
    const project = (lat: number, lng: number) => ({
      x: (lng - center.longitude) * mPerDegLng,
      y: -(lat - center.latitude) * METRES_PER_DEG_LAT,
    });

    const built = [
      ...(circles ?? []).map((c) => {
        const p = project(c.latitude, c.longitude);
        return { kind: "circle" as const, ...p, r: c.radiusMeters, tone: c.tone ?? "neon", label: "" };
      }),
      ...(markers ?? []).map((m) => {
        const p = project(m.latitude, m.longitude);
        return { kind: "marker" as const, ...p, r: 0, tone: m.tone ?? "muted", label: m.label ?? "" };
      }),
    ];
    const extent = built.reduce((acc, it) => Math.max(acc, Math.abs(it.x) + it.r, Math.abs(it.y) + it.r), 1);
    return { items: built, maxExtent: extent };
  }, [center.latitude, center.longitude, markers, circles]);

  const scale = (view / 2 - pad) / maxExtent; // metres → svg units

  return (
    <div
      className={`bb-map bb-map--schematic ${className ?? ""}`}
      style={{ height: heightValue(height) }}
      role="img"
      aria-label={ariaLabel ?? "Geofence schematic"}
    >
      <svg viewBox={`${-view / 2} ${-view / 2} ${view} ${view}`} className="h-full w-full" preserveAspectRatio="xMidYMid meet">
        {/* faint metre grid */}
        <defs>
          <pattern id="bb-grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0 L0 0 0 20" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="0.4" />
          </pattern>
        </defs>
        <rect x={-view / 2} y={-view / 2} width={view} height={view} fill="url(#bb-grid)" />

        {items.map((it, i) =>
          it.kind === "circle" ? (
            <circle
              key={`c${i}`}
              cx={it.x * scale}
              cy={it.y * scale}
              r={Math.max(2, it.r * scale)}
              fill={it.tone === "muted" ? "rgba(160,174,192,0.08)" : "rgba(0,230,118,0.10)"}
              stroke={it.tone === "muted" ? "rgba(160,174,192,0.5)" : "rgba(0,230,118,0.75)"}
              strokeWidth="0.8"
            />
          ) : (
            <g key={`m${i}`}>
              <circle
                cx={it.x * scale}
                cy={it.y * scale}
                r={it.tone === "user" ? 4 : 3}
                fill={it.tone === "user" ? "#00e676" : it.tone === "danger" ? "#ff5252" : "#ffffff"}
                stroke="rgba(0,0,0,0.6)"
                strokeWidth="0.6"
              />
              {it.label ? (
                <text
                  x={it.x * scale}
                  y={it.y * scale - 6}
                  textAnchor="middle"
                  fontSize="5"
                  fill="#ffffff"
                  style={{ paintOrder: "stroke", stroke: "rgba(0,0,0,0.75)", strokeWidth: 1.4 }}
                >
                  {it.label}
                </text>
              ) : null}
            </g>
          )
        )}

        {/* centre crosshair */}
        <circle cx={0} cy={0} r={0.9} fill="rgba(255,255,255,0.55)" />
      </svg>
      <p className="bb-map__note">
        Schematic view — set <code>NEXT_PUBLIC_GEOAPIFY_API_KEY</code> (or allow the
        OSM demo tiles) for map imagery. Distances are exact.
      </p>
    </div>
  );
}

/* ================================================================== */
/* Leaflet map                                                         */
/* ================================================================== */

export default function MapCanvas(props: MapCanvasProps) {
  const {
    center,
    zoom,
    markers = [],
    circles = [],
    interactive = true,
    fit = true,
    focus = null,
    onMarkerDrag,
    onMapClick,
    height,
    className = "",
    ariaLabel = "Map",
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletNS.Map | null>(null);
  const layerRef = useRef<LeafletNS.LayerGroup | null>(null);
  const leafletRef = useRef<typeof LeafletNS | null>(null);
  const [tilesFailed, setTilesFailed] = useState(false);
  const [ready, setReady] = useState(false);

  // Keep the latest callbacks without forcing the map to rebuild.
  const dragCb = useRef(onMarkerDrag);
  const clickCb = useRef(onMapClick);
  useEffect(() => {
    dragCb.current = onMarkerDrag;
    clickCb.current = onMapClick;
  });

  const configured = useMemo(() => isMapConfigured(), []);
  const demo = useMemo(() => isDemoTiles(), []);

  // ── Mount / unmount the Leaflet map (once) ──────────────────────────
  useEffect(() => {
    if (!configured) return;
    let cancelled = false;

    (async () => {
      const mod = await import("leaflet");
      const L = ((mod as unknown as { default?: typeof LeafletNS }).default ??
        mod) as typeof LeafletNS;
      if (cancelled || !containerRef.current) return;

      leafletRef.current = L;
      const map = L.map(containerRef.current, {
        center: [center.latitude, center.longitude],
        zoom: zoom ?? 16,
        zoomControl: interactive,
        dragging: interactive,
        scrollWheelZoom: interactive,
        doubleClickZoom: interactive,
        boxZoom: interactive,
        keyboard: interactive,
        touchZoom: interactive,
        attributionControl: true,
        preferCanvas: true,
      });
      mapRef.current = map;

      const template = tileUrlTemplate();
      if (template) {
        const layer = L.tileLayer(template, {
          attribution: mapAttribution(),
          subdomains: TILE_SUBDOMAINS,
          maxZoom: 20,
          crossOrigin: true,
        });
        layer.on("tileerror", () => setTilesFailed(true));
        layer.addTo(map);
      }

      if (interactive && clickCb.current) {
        map.on("click", (e: LeafletNS.LeafletMouseEvent) => {
          clickCb.current?.(e.latlng.lat, e.latlng.lng);
        });
      }

      layerRef.current = L.layerGroup().addTo(map);
      setReady(true);
      // Recompute layout once the container has its final size.
      requestAnimationFrame(() => map.invalidateSize());
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
      setReady(false);
    };
    // Mount once — overlays are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured]);

  // ── (Re)draw overlays whenever the data changes ─────────────────────
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    const group = layerRef.current;
    if (!ready || !L || !map || !group) return;

    group.clearLayers();

    for (const c of circles) {
      const neon = (c.tone ?? "neon") === "neon";
      L.circle([c.latitude, c.longitude], {
        radius: c.radiusMeters,
        color: neon ? "#00e676" : "rgba(160,174,192,0.65)",
        weight: neon ? 2 : 1,
        fillColor: neon ? "#00e676" : "#a0aec0",
        fillOpacity: neon ? 0.12 : 0.06,
      }).addTo(group);
    }

    for (const m of markers) {
      const tone = m.tone ?? "muted";
      const icon = L.divIcon({
        className: "bb-pin-wrap",
        html: `<span class="bb-pin bb-pin--${tone}" title="${escapeHtml(m.label ?? "")}"></span>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });
      const marker = L.marker([m.latitude, m.longitude], {
        icon,
        draggable: Boolean(m.draggable && interactive),
        keyboard: false,
      });
      if (m.label) {
        marker.bindTooltip(escapeHtml(m.label), { direction: "top", offset: [0, -10] });
      }
      if (m.draggable && interactive) {
        marker.on("dragend", () => {
          const ll = marker.getLatLng();
          dragCb.current?.(m.id, ll.lat, ll.lng);
        });
      }
      marker.addTo(group);
    }

    // Viewport
    const bounds: LeafletNS.LatLngExpression[] = [];
    for (const c of circles) {
      // Approximate the circle's bounding box with its cardinal points.
      const dLat = (c.radiusMeters / METRES_PER_DEG_LAT) * 1.15;
      const mPerDegLng = METRES_PER_DEG_LAT * Math.max(0.05, Math.cos((c.latitude * Math.PI) / 180));
      const dLng = (c.radiusMeters / mPerDegLng) * 1.15;
      bounds.push([c.latitude + dLat, c.longitude + dLng], [c.latitude - dLat, c.longitude - dLng]);
    }
    for (const m of markers) bounds.push([m.latitude, m.longitude]);

    if (fit && bounds.length > 0) {
      map.fitBounds(L.latLngBounds(bounds).pad(0.25), { animate: false });
    } else {
      map.setView([center.latitude, center.longitude], zoom ?? zoomForRadius(circles[0]?.radiusMeters ?? 0));
    }
  }, [ready, circles, markers, fit, center.latitude, center.longitude, zoom, interactive]);

  // ── Pan/zoom to an explicit focus point (e.g. "centre on me") ───────
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !focus) return;
    map.setView([focus.latitude, focus.longitude], focus.zoom ?? map.getZoom(), { animate: true });
  }, [ready, focus]);

  if (!configured) {
    return (
      <SchematicMap
        center={center}
        markers={markers}
        circles={circles}
        height={height}
        className={className}
        ariaLabel={ariaLabel}
      />
    );
  }

  return (
    <div className={`bb-map relative ${className}`} style={{ height: heightValue(height) }} aria-label={ariaLabel}>
      <div ref={containerRef} className="h-full w-full rounded-xl" role="application" aria-label={ariaLabel} />
      {tilesFailed ? (
        <p className="bb-map__note bb-map__note--overlay">
          Map tiles unavailable — the geofence centre and radius are still shown. Distances are exact.
        </p>
      ) : demo ? (
        <p className="bb-map__note bb-map__note--overlay">Demo tiles · add a Geoapify key for production</p>
      ) : null}
    </div>
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
