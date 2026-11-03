"use client";

/**
 * ============================================================================
 *  ClockingMethodFields — the dynamic "Clocking Method" block (Phase 15)
 * ============================================================================
 *
 *  Shared by the two admin surfaces that configure geofenced mobile clocking:
 *    • Settings → Branches        (site-level method + geofence centre + radius)
 *    • Clocking Devices → Add/Edit (device-level method + geofence centre + radius)
 *
 *  It renders the method selector and reveals the geofence inputs (including
 *  numeric radius, slider, preset buttons, and interactive map editor) when
 *  the chosen method uses GPS ("Geofence" / "Both").
 */

import { useState } from "react";
import { CLOCKING_METHOD_OPTIONS, normalizeClockingMethod } from "@/lib/geofence";
import type { ClockingMethod } from "@/lib/types";
import GeofenceMapEditor from "./GeofenceMapEditor";

const LABEL = "mb-1.5 block text-[10px] font-bold tracking-[0.18em] text-muted uppercase";
const INPUT =
  "w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-muted/60 focus:border-neon/50 focus:bg-white/[0.06]";

const RADIUS_PRESETS = [50, 100, 150, 250, 500, 1000] as const;

/** String-based form state (inputs are strings; converted on submit). */
export interface ClockingFieldsValue {
  clockingMethod: ClockingMethod;
  latitude: string;
  longitude: string;
  geofenceRadiusMeters: string;
}

/** Build the form value from a stored row (nulls → empty strings). */
export function emptyClockingFields(
  method: ClockingMethod = "Biometric",
  latitude?: number | null,
  longitude?: number | null,
  geofenceRadiusMeters?: number | null
): ClockingFieldsValue {
  return {
    clockingMethod: normalizeClockingMethod(method),
    latitude: latitude === null || latitude === undefined ? "" : String(latitude),
    longitude: longitude === null || longitude === undefined ? "" : String(longitude),
    geofenceRadiusMeters:
      geofenceRadiusMeters === null || geofenceRadiusMeters === undefined
        ? ""
        : String(geofenceRadiusMeters),
  };
}

function toNumberOrNull(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Convert form state into the API payload. When the method is Biometric the
 * geofence fields are omitted entirely so a stored centre is preserved (the
 * DB layer only writes the keys we send).
 */
export function clockingPayload(value: ClockingFieldsValue): {
  clockingMethod: ClockingMethod;
  latitude?: number | null;
  longitude?: number | null;
  geofenceRadiusMeters?: number | null;
} {
  if (value.clockingMethod === "Biometric") return { clockingMethod: "Biometric" };
  return {
    clockingMethod: value.clockingMethod,
    latitude: toNumberOrNull(value.latitude),
    longitude: toNumberOrNull(value.longitude),
    geofenceRadiusMeters: toNumberOrNull(value.geofenceRadiusMeters),
  };
}

export function ClockingMethodFields({
  value,
  onChange,
  idPrefix = "clocking",
  className = "",
  showMap = true,
}: {
  value: ClockingFieldsValue;
  onChange: (patch: Partial<ClockingFieldsValue>) => void;
  idPrefix?: string;
  className?: string;
  /** Render the interactive Leaflet geofence editor under the numeric fields. */
  showMap?: boolean;
}) {
  const needsGeo = value.clockingMethod !== "Biometric";
  const [mapOpen, setMapOpen] = useState(true);
  const currentRadius = toNumberOrNull(value.geofenceRadiusMeters) ?? 150;

  return (
    <div className={className}>
      <span className={LABEL}>Allowed Clocking Methods</span>
      <div
        role="radiogroup"
        aria-label="Allowed clocking methods"
        className="grid gap-2 sm:grid-cols-3"
      >
        {CLOCKING_METHOD_OPTIONS.map((opt) => {
          const active = value.clockingMethod === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange({ clockingMethod: opt.value })}
              className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                active
                  ? "border-neon/50 bg-neon/10 shadow-[0_0_18px_rgba(0,230,118,0.18)]"
                  : "border-white/10 bg-white/[0.03] hover:border-white/25"
              }`}
            >
              <span
                className={`block text-xs font-bold tracking-wide ${active ? "text-neon" : "text-ink"}`}
              >
                {opt.label}
              </span>
              <span className="mt-1 block text-[10px] leading-snug text-muted">{opt.hint}</span>
            </button>
          );
        })}
      </div>

      {needsGeo ? (
        <div className="mt-4 grid gap-4 rounded-xl border border-neon/20 bg-neon/[0.04] p-4 sm:grid-cols-3">
          <div className="sm:col-span-3">
            <p className="text-[11px] text-muted">
              Mobile GPS check-ins are accepted only inside this radius of the stored GPS centre.
              Coordinates are WGS-84 decimal degrees (e.g. Bulawayo&nbsp;
              <span className="font-mono text-ink/80">-20.1725, 28.5752</span>).
            </p>
          </div>
          <div>
            <label className={LABEL} htmlFor={`${idPrefix}-lat`}>
              Latitude
            </label>
            <input
              id={`${idPrefix}-lat`}
              className={`${INPUT} font-mono`}
              value={value.latitude}
              onChange={(e) => onChange({ latitude: e.target.value })}
              placeholder="-20.1725"
              inputMode="decimal"
              autoComplete="off"
            />
          </div>
          <div>
            <label className={LABEL} htmlFor={`${idPrefix}-lng`}>
              Longitude
            </label>
            <input
              id={`${idPrefix}-lng`}
              className={`${INPUT} font-mono`}
              value={value.longitude}
              onChange={(e) => onChange({ longitude: e.target.value })}
              placeholder="28.5752"
              inputMode="decimal"
              autoComplete="off"
            />
          </div>
          <div>
            <label className={LABEL} htmlFor={`${idPrefix}-radius`}>
              Radius (metres)
            </label>
            <input
              id={`${idPrefix}-radius`}
              type="number"
              min="1"
              className={`${INPUT} font-mono`}
              value={value.geofenceRadiusMeters}
              onChange={(e) => onChange({ geofenceRadiusMeters: e.target.value })}
              placeholder="150"
              autoComplete="off"
            />
          </div>

          {/* Interactive Radius Resizer (Slider + Presets) */}
          <div className="rounded-xl border border-white/10 bg-black/25 p-3 sm:col-span-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <label
                htmlFor={`${idPrefix}-radius-slider`}
                className="text-[10px] font-bold tracking-[0.18em] text-muted uppercase"
              >
                Resize Geofence Radius:{" "}
                <span className="font-mono text-neon">{currentRadius} m</span>
              </label>
              <div className="flex flex-wrap items-center gap-1.5">
                {RADIUS_PRESETS.map((preset) => {
                  const isSelected = currentRadius === preset;
                  return (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => onChange({ geofenceRadiusMeters: String(preset) })}
                      className={`rounded-lg border px-2 py-0.5 font-mono text-[10px] font-bold transition ${
                        isSelected
                          ? "border-neon/60 bg-neon/20 text-neon"
                          : "border-white/10 bg-white/[0.04] text-muted hover:border-neon/40 hover:text-ink"
                      }`}
                    >
                      {preset}m
                    </button>
                  );
                })}
              </div>
            </div>
            <input
              id={`${idPrefix}-radius-slider`}
              type="range"
              min={10}
              max={2000}
              step={5}
              value={Math.max(10, Math.min(2000, currentRadius))}
              onChange={(e) => onChange({ geofenceRadiusMeters: e.target.value })}
              className="w-full accent-[#00e676] cursor-pointer"
              aria-label="Resize geofence radius in metres"
            />
          </div>

          {showMap ? (
            <div className="sm:col-span-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[10px] font-bold tracking-[0.18em] text-muted uppercase">
                  Pin the site &amp; resize boundary on the map
                </span>
                <button
                  type="button"
                  className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-bold tracking-[0.14em] text-muted uppercase transition hover:border-neon/40 hover:text-neon"
                  aria-expanded={mapOpen}
                  onClick={() => setMapOpen((open) => !open)}
                >
                  {mapOpen ? "Hide map" : "Show map"}
                </button>
              </div>
              {mapOpen ? (
                <GeofenceMapEditor value={value} onChange={onChange} idPrefix={`${idPrefix}-map`} />
              ) : (
                <p className="text-[11px] text-muted">
                  Map hidden — the latitude, longitude and radius above are still saved exactly as typed.
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Compact chip for tables / list rows. */
export function ClockingMethodBadge({
  method,
  radiusMeters,
}: {
  method: ClockingMethod;
  radiusMeters?: number | null;
}) {
  const mobile = method !== "Biometric";
  const label = method === "Both" ? "Hybrid" : method;
  return (
    <span className={`chip ${mobile ? "chip--neon" : "chip--muted"}`} title={
      mobile
        ? `Biometric + mobile GPS clocking${radiusMeters ? ` · ${radiusMeters} m` : ""}`
        : "Physical fingerprint terminal only"
    }>
      <span className={`status-dot ${mobile ? "status-dot--on" : "status-dot--off"}`} aria-hidden="true" />
      {label}
    </span>
  );
}

/** "−17.82920, 31.05220" for read-only display (null → em dash). */
export function formatCoordinate(latitude: number | null, longitude: number | null): string {
  if (latitude === null || longitude === null) return "—";
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}
