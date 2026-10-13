"use client";

/**
 * ============================================================================
 *  ClockingMethodFields — the dynamic "Clocking Method" block (Phase 15)
 * ============================================================================
 *
 *  Shared by the two admin surfaces that configure hands-free geofenced
 *  mobile clocking:
 *    • Settings → Branches        (site-level method + geofence centre)
 *    • Clocking Devices → Add/Edit (device-level method + geofence centre)
 *
 *  It renders the method selector and REVEALS the geofence inputs only when
 *  the chosen method actually uses GPS ("Geofence" / "Both"). Biometric stays
 *  the default so nothing changes for existing sites/devices until an admin
 *  opts in.
 *
 *  Styling reuses the app's design tokens (.glass surfaces, --color-neon
 *  accents, muted labels) so the new fields blend into the existing forms.
 */

import { CLOCKING_METHOD_OPTIONS, normalizeClockingMethod } from "@/lib/geofence";
import type { ClockingMethod } from "@/lib/types";

const LABEL = "mb-1.5 block text-[10px] font-bold tracking-[0.18em] text-muted uppercase";
const INPUT =
  "w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-muted/60 focus:border-neon/50 focus:bg-white/[0.06]";

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
}: {
  value: ClockingFieldsValue;
  onChange: (patch: Partial<ClockingFieldsValue>) => void;
  idPrefix?: string;
  className?: string;
}) {
  const needsGeo = value.clockingMethod !== "Biometric";

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
              Hands-free check-ins are accepted only inside this radius of the stored GPS centre.
              Coordinates are WGS-84 decimal degrees (e.g. Harare CBD&nbsp;
              <span className="font-mono text-ink/80">-17.8292, 31.0522</span>).
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
              placeholder="-17.8292"
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
              placeholder="31.0522"
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
        ? `Biometric + hands-free GPS clocking${radiusMeters ? ` · ${radiusMeters} m` : ""}`
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
