/**
 * ============================================================================
 *  maps.ts — map tile configuration for the companion app (Phase 18)
 * ============================================================================
 *
 *  The phone draws its site map inside a WebView running Leaflet. This module
 *  is the single source of truth for WHICH tile server that WebView points at,
 *  mirroring the web app's src/lib/maps.ts so both surfaces stay in step.
 *
 *  Configuration lives in app.json → extra (no rebuild for a URL-only change
 *  is still needed — `apiUrl` already works this way):
 *
 *    geoapifyKey    browser/app Geoapify key (preferred)
 *    mapTileStyle   Geoapify style (default "osm-bright")
 *    mapTileUrl     a full tile template that overrides everything
 *    mapAttribution required attribution HTML for a custom template
 *
 *  DEMO fallback
 *  ─────────────
 *  With no key/template set the map uses the PUBLIC OpenStreetMap standard tile
 *  server so it renders during review. OSM's tile usage policy forbids heavy or
 *  commercial use — it is a demo shortcut, superseded automatically the moment
 *  a real key/template is added. Either way the bridge computes every geofence
 *  verdict server-side, so tiles are a courtesy layer only.
 */

import Constants from "expo-constants";

export const OSM_DEMO_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function extra(): Record<string, unknown> {
  return (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;
}

function extraString(key: string): string {
  const value = extra()[key];
  return typeof value === "string" ? value.trim() : "";
}

/** True when the tiles come from the public OSM demo server. */
export function isDemoTiles(): boolean {
  return !extraString("mapTileUrl") && !extraString("geoapifyKey");
}

/** The Leaflet tile template the WebView should use. */
export function tileUrlTemplate(): string {
  const custom = extraString("mapTileUrl");
  if (custom) return custom;

  const key = extraString("geoapifyKey");
  if (key) {
    const style = extraString("mapTileStyle") || "osm-bright";
    return `https://maps.geoapify.com/v1/tile/${encodeURIComponent(style)}/{z}/{x}/{y}.png?apiKey=${encodeURIComponent(key)}`;
  }

  return OSM_DEMO_TILE_URL;
}

/** Attribution HTML Leaflet renders in the corner. */
export function mapAttribution(): string {
  const custom = extraString("mapAttribution");
  if (custom) return custom;
  if (extraString("geoapifyKey")) {
    return `Powered by <a href="https://www.geoapify.com/">Geoapify</a> · ${OSM_ATTRIBUTION}`;
  }
  return OSM_ATTRIBUTION;
}

/**
 * A pragmatic zoom for a fence of `radiusMeters` — matches the web helper so a
 * phone and a browser show the same site at the same scale.
 */
export function zoomForRadius(radiusMeters: number): number {
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) return 16;
  const z = Math.round(16 - Math.log2(Math.max(1, radiusMeters) / 150));
  return Math.min(18, Math.max(13, z));
}
