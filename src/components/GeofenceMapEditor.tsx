"use client";

/**
 * ============================================================================
 *  GeofenceMapEditor — the Leaflet geofence picker & radius resizer
 * ============================================================================
 *
 *  The interactive half of branch/site geofence management. It sits
 *  under the numeric Latitude/Longitude/Radius inputs in `ClockingMethodFields`
 *  so the two admin surfaces that configure mobile clocking (Settings →
 *  Branches and Clocking Devices) get the same map:
 *
 *    • drag the centre pin, or click the map, to set the site centre
 *    • drag the edge pin on the circle rim (or use the slider/input) to resize
 *      the geofence radius in metres
 *    • "Use my location" drops the pin where the admin is standing
 */

import { useMemo, useState } from "react";
import MapCanvas, { type MapCircle, type MapMarker } from "./MapCanvas";
import { haversineMetersRounded } from "@/lib/geofence";
import { zoomForRadius } from "@/lib/maps";
import type { ClockingFieldsValue } from "./ClockingMethodFields";

/** Map default view when a site has no centre yet: Zimbabwe centroid, wide. */
const FALLBACK_CENTER = { latitude: -19.0154, longitude: 29.1549 };
const FALLBACK_ZOOM = 7;
const DEFAULT_RADIUS_PREVIEW = 150;
const METRES_PER_DEG_LAT = 111_320;

const LABEL = "mb-1.5 block text-[10px] font-bold tracking-[0.18em] text-muted uppercase";

function toNumberOrNull(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Browser geolocation error → plain-language copy. */
function geoErrorMessage(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return "Location permission was denied. Allow location for this site, or type the coordinates by hand.";
    case err.POSITION_UNAVAILABLE:
      return "Your device could not get a GPS fix. Move somewhere with a clearer view of the sky and retry.";
    case err.TIMEOUT:
      return "Getting your location timed out. Try again.";
    default:
      return "Could not read your location.";
  }
}

export default function GeofenceMapEditor({
  value,
  onChange,
  idPrefix = "geo",
  className = "",
}: {
  value: ClockingFieldsValue;
  onChange: (patch: Partial<ClockingFieldsValue>) => void;
  idPrefix?: string;
  className?: string;
}) {
  const [device, setDevice] = useState<{ latitude: number; longitude: number; accuracy: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  const latitude = toNumberOrNull(value.latitude);
  const longitude = toNumberOrNull(value.longitude);
  const radius = toNumberOrNull(value.geofenceRadiusMeters);
  const activeRadius = Math.max(1, radius ?? DEFAULT_RADIUS_PREVIEW);
  const hasCentre = latitude !== null && longitude !== null;

  const center = hasCentre
    ? { latitude, longitude }
    : device ?? FALLBACK_CENTER;

  const zoom = useMemo(
    () => (hasCentre ? zoomForRadius(activeRadius) : FALLBACK_ZOOM),
    [hasCentre, activeRadius]
  );

  const markers: MapMarker[] = [];
  if (hasCentre) {
    markers.push({
      id: "site",
      latitude,
      longitude,
      label: `Site centre (${activeRadius} m)`,
      tone: "neon",
      draggable: true,
    });

    // Place a draggable radius handle on the eastern edge of the geofence circle
    const mPerDegLng =
      METRES_PER_DEG_LAT * Math.max(0.05, Math.cos((latitude * Math.PI) / 180));
    const edgeLng = longitude + activeRadius / mPerDegLng;
    markers.push({
      id: "radius-handle",
      latitude,
      longitude: edgeLng,
      label: `Drag edge to resize (${activeRadius} m)`,
      tone: "muted",
      draggable: true,
    });
  }
  if (device) {
    markers.push({ id: "device", latitude: device.latitude, longitude: device.longitude, label: "You", tone: "user" });
  }

  const circles: MapCircle[] = hasCentre
    ? [{ id: "fence", latitude, longitude, radiusMeters: activeRadius, tone: "neon" }]
    : [];

  const distance =
    hasCentre && device ? haversineMetersRounded(device.latitude, device.longitude, latitude, longitude) : null;

  function place(lat: number, lng: number) {
    onChange({
      latitude: lat.toFixed(6),
      longitude: lng.toFixed(6),
      ...(radius === null ? { geofenceRadiusMeters: String(DEFAULT_RADIUS_PREVIEW) } : {}),
    });
  }

  function handleMarkerDrag(id: string, lat: number, lng: number) {
    if (id === "radius-handle" && hasCentre) {
      const nextRadius = Math.max(10, haversineMetersRounded(latitude, longitude, lat, lng));
      onChange({ geofenceRadiusMeters: String(nextRadius) });
      return;
    }
    place(lat, lng);
  }

  function useMyLocation() {
    if (locating) return;
    setGeoError(null);
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoError("This browser does not support geolocation — type the coordinates by hand.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const fix = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
        };
        setDevice(fix);
        place(fix.latitude, fix.longitude);
        setLocating(false);
      },
      (err) => {
        setGeoError(geoErrorMessage(err));
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 5_000 }
    );
  }

  return (
    <div className={`space-y-2 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={LABEL}>Geofence map — drag centre pin to move, or drag rim pin to resize radius</span>
        <div className="flex flex-wrap items-center gap-2">
          {hasCentre ? (
            <button
              type="button"
              className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-bold tracking-[0.14em] text-muted uppercase transition hover:border-danger/40 hover:text-danger"
              onClick={() => {
                onChange({ latitude: "", longitude: "" });
                setGeoError(null);
              }}
            >
              Clear centre
            </button>
          ) : null}
          <button
            type="button"
            className="rounded-lg border border-neon/40 bg-neon/10 px-2.5 py-1 text-[10px] font-bold tracking-[0.14em] text-neon uppercase transition hover:bg-neon/20"
            onClick={useMyLocation}
            disabled={locating}
          >
            {locating ? "Locating…" : "Use my location"}
          </button>
        </div>
      </div>

      <MapCanvas
        center={center}
        zoom={zoom}
        fit={false}
        markers={markers}
        circles={circles}
        interactive
        height={300}
        ariaLabel="Geofence editor map"
        onMapClick={(lat, lng) => place(lat, lng)}
        onMarkerDrag={handleMarkerDrag}
      />

      <p className="text-[11px] text-muted" aria-live="polite">
        {hasCentre ? (
          <>
            Centre <span className="font-mono text-ink/80">{latitude!.toFixed(5)}, {longitude!.toFixed(5)}</span>
            {" · "}
            radius <span className="font-mono text-neon">{activeRadius} m</span>
            {distance !== null ? (
              <>
                {" · "}
                you are <span className="font-mono text-ink/80">{distance} m</span> away
                {device?.accuracy ? ` (±${device.accuracy} m)` : ""}
              </>
            ) : null}
          </>
        ) : (
          "Click the map or press “Use my location” to drop the geofence centre."
        )}
      </p>

      {geoError ? (
        <p role="alert" className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[11px] text-warn">
          {geoError}
        </p>
      ) : null}
      <span id={`${idPrefix}-map-hint`} className="sr-only">
        Map editor for the geofence centre and radius.
      </span>
    </div>
  );
}
