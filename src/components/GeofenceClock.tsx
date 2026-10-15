"use client";

/**
 * ============================================================================
 *  GeofenceClock — browser geofenced clock-in/out (Phase 18)
 * ============================================================================
 *
 *  My Portal's mobile-first GPS clock. It complements — never replaces — the
 *  biometric terminal and the Remote Clock button:
 *
 *    • Device location is requested ONLY when the worker presses the button
 *      (Phase 3 rule: do not track movement, do not ask when unnecessary).
 *    • The result shown is ALWAYS the server's verdict from
 *      POST /api/my-portal/geopunch — obtaining coordinates never counts as a
 *      successful clock-in.
 *    • Permission denial, GPS unavailability, poor accuracy and geofence
 *      refusals are explained in plain language.
 *    • The map is a courtesy: if tiles cannot load, the distance/accuracy and
 *      the server verdict are unaffected (all computed server-side).
 */

import { useCallback, useEffect, useState } from "react";
import MapCanvas, { type MapCircle, type MapMarker } from "./MapCanvas";
import { haversineMetersRounded } from "@/lib/geofence";
import { zoomForRadius } from "@/lib/maps";
import type { GeoFenceSite, GeoPunchReason, GeoPunchResponse, PunchDirection } from "@/lib/types";
import { IconCheck } from "./icons";

interface Fix {
  latitude: number;
  longitude: number;
  accuracy: number;
}

type Phase = "idle" | "locating" | "posting" | "done" | "error";

/** Plain-language title for a server verdict. */
function verdictLabel(reason: GeoPunchReason | undefined): { text: string; tone: "neon" | "warn" | "danger" } {
  switch (reason) {
    case "CLOCKED_IN":
      return { text: "Clocked IN", tone: "neon" };
    case "CLOCKED_OUT":
      return { text: "Clocked OUT", tone: "neon" };
    case "OUTSIDE_GEOFENCE":
      return { text: "Rejected — outside the geofence", tone: "warn" };
    case "BIOMETRIC_ONLY":
      return { text: "Rejected — terminal required here", tone: "warn" };
    case "LOW_ACCURACY":
      return { text: "Rejected — GPS not accurate enough", tone: "warn" };
    case "GEOFENCE_NOT_CONFIGURED":
      return { text: "Not available yet", tone: "warn" };
    case "RATE_LIMITED":
      return { text: "Too many attempts", tone: "warn" };
    default:
      return { text: "Clocking failed", tone: "danger" };
  }
}

function geoErrorMessage(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return "Location permission was denied. Allow location for this site in your browser, then try again.";
    case err.POSITION_UNAVAILABLE:
      return "Your device could not get a GPS fix. Move somewhere with a clearer view of the sky and retry.";
    case err.TIMEOUT:
      return "Getting your location timed out. Try again.";
    default:
      return "Could not read your location.";
  }
}

/** Nearest mobile site to a fix (client-side, DISPLAY ONLY). */
function nearestSite(sites: GeoFenceSite[], fix: Fix): { site: GeoFenceSite; distance: number } | null {
  let best: { site: GeoFenceSite; distance: number } | null = null;
  for (const site of sites) {
    const distance = haversineMetersRounded(fix.latitude, fix.longitude, site.latitude, site.longitude);
    if (!best || distance < best.distance) best = { site, distance };
  }
  return best;
}

export default function GeofenceClock({
  clockedIn,
  onClocked,
}: {
  clockedIn: boolean;
  onClocked?: () => void;
}) {
  const [sites, setSites] = useState<GeoFenceSite[]>([]);
  const [sitesError, setSitesError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [fix, setFix] = useState<Fix | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [result, setResult] = useState<GeoPunchResponse | null>(null);

  const loadSites = useCallback(async () => {
    try {
      const res = await fetch("/api/attendance/geofences", { cache: "no-store" });
      const json = (await res.json()) as { ok?: boolean; sites?: GeoFenceSite[]; error?: string };
      if (res.ok && json.ok && json.sites) {
        setSites(json.sites);
        setSitesError(null);
      } else {
        setSitesError(json.error ?? "Could not load the registered sites.");
      }
    } catch {
      setSitesError("Could not reach the bridge to load the registered sites.");
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void loadSites());
  }, [loadSites]);

  const busy = phase === "locating" || phase === "posting";

  async function clock() {
    if (busy) return;
    setGeoError(null);
    setResult(null);

    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setPhase("error");
      setGeoError("This browser does not support geolocation. Use the biometric terminal or the Remote Clock button.");
      return;
    }

    setPhase("locating");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const got: Fix = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
        };
        setFix(got);
        void submit(got, clockedIn ? "OUT" : "IN");
      },
      (err) => {
        setPhase("error");
        setGeoError(geoErrorMessage(err));
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 }
    );
  }

  async function submit(got: Fix, direction: PunchDirection) {
    setPhase("posting");
    try {
      const res = await fetch("/api/my-portal/geopunch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latitude: got.latitude,
          longitude: got.longitude,
          accuracyMeters: got.accuracy,
          direction,
        }),
      });
      const json = (await res.json()) as GeoPunchResponse & { error?: string };
      setResult(json);
      setPhase("done");
      if (json.ok) onClocked?.();
    } catch {
      setPhase("error");
      setGeoError("The bridge could not be reached to record your clock-in. Your location was not saved.");
    }
  }

  const near = fix ? nearestSite(sites, fix) : null;

  const markers: MapMarker[] = [];
  const circles: MapCircle[] = [];
  if (fix && near) {
    circles.push({
      id: `fence-${near.site.id}`,
      latitude: near.site.latitude,
      longitude: near.site.longitude,
      radiusMeters: near.site.radiusMeters,
      tone: "neon",
    });
    markers.push({
      id: `site-${near.site.id}`,
      latitude: near.site.latitude,
      longitude: near.site.longitude,
      label: near.site.branch,
      tone: "neon",
    });
  }
  if (fix) {
    markers.push({ id: "me", latitude: fix.latitude, longitude: fix.longitude, label: "You", tone: "user" });
  }

  const verdict = result ? verdictLabel(result.reason) : null;
  const btnLabel = busy ? (phase === "locating" ? "Getting location…" : "Clocking…") : clockedIn ? "Clock OUT with GPS" : "Clock IN with GPS";

  return (
    <section className="glass rise relative overflow-hidden">
      <div className="accent-line" aria-hidden="true" />
      <header className="flex items-start justify-between gap-3 border-b border-white/[0.07] px-5 py-4">
        <div>
          <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">Geofenced Clock-in · GPS</h2>
          <p className="mt-1 text-[11px] text-muted">
            Clock in hands-free from your phone browser when you are inside a registered site.
          </p>
        </div>
        <span className="chip chip--neon" title="Server-validated GPS clocking">
          <span className="status-dot status-dot--on" aria-hidden="true" />
          {sites.length} site{sites.length === 1 ? "" : "s"}
        </span>
      </header>

      <div className="space-y-4 px-5 py-5">
        {sitesError ? (
          <p role="alert" className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
            {sitesError}
          </p>
        ) : null}

        {sites.length === 0 && !sitesError ? (
          <p className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-4 text-center text-sm text-muted">
            No site has hands-free mobile clocking configured yet. Ask an administrator to set a branch&apos;s
            coordinates and allow GPS clocking.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className={`btn ${clockedIn ? "btn--ghost" : "btn--neon"}`}
                onClick={() => void clock()}
                disabled={busy || sites.length === 0}
              >
                {btnLabel}
              </button>
              {!fix && !result ? (
                <span className="text-[11px] text-muted">
                  Your location is requested only when you press the button.
                </span>
              ) : null}
            </div>

            {fix ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat label="Nearest site" value={near ? near.site.branch : "—"} />
                <Stat
                  label="Distance"
                  value={near ? `${near.distance} m` : "—"}
                  hint={near ? (near.distance <= near.site.radiusMeters ? "inside the fence" : `fence is ${near.site.radiusMeters} m`) : undefined}
                />
                <Stat label="GPS accuracy" value={`± ${fix.accuracy} m`} />
              </div>
            ) : null}

            {fix ? (
              <MapCanvas
                center={{ latitude: near?.site.latitude ?? fix.latitude, longitude: near?.site.longitude ?? fix.longitude }}
                zoom={zoomForRadius(near?.site.radiusMeters ?? 150)}
                fit={false}
                markers={markers}
                circles={circles}
                interactive
                height={280}
                ariaLabel="Your position relative to the nearest registered site"
              />
            ) : null}
          </>
        )}

        {geoError ? (
          <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {geoError}
          </p>
        ) : null}

        {result && verdict ? (
          <div
            role="status"
            aria-live="polite"
            className={`rounded-xl border px-3 py-3 text-sm ${
              verdict.tone === "neon"
                ? "border-neon/40 bg-neon/10 text-neon"
                : verdict.tone === "warn"
                  ? "border-warn/40 bg-warn/10 text-warn"
                  : "border-danger/40 bg-danger/10 text-danger"
            }`}
          >
            <p className="flex items-center gap-2 font-semibold">
              {result.ok ? <IconCheck className="h-4 w-4" /> : null}
              {verdict.text}
            </p>
            <p className="mt-1 text-[12px] text-ink/90">{result.message}</p>
            {result.punch ? (
              <p className="mt-1 text-[11px] text-muted">
                {result.punch.verifyMethod} · {result.punch.syncStatus === "Failed" ? "logged as an exception" : "pending ERP sync"}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <footer className="border-t border-white/[0.07] px-5 py-3.5">
        <p className="text-[10px] text-muted/80">
          The bridge validates your location on the server — coordinates alone never count as a clock-in.
        </p>
      </footer>
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5">
      <p className="text-[10px] font-bold tracking-[0.18em] text-muted uppercase">{label}</p>
      <p className="mt-1 text-sm font-semibold text-ink">{value}</p>
      {hint ? <p className="mt-0.5 text-[10px] text-muted">{hint}</p> : null}
    </div>
  );
}
