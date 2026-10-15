/**
 * ============================================================================
 *  maps.ts — map tile configuration (Phase 18)
 * ============================================================================
 *
 *  Isomorphic, dependency-free configuration for the Leaflet maps used by:
 *    • Settings → Branches   (the draggable geofence centre + radius editor)
 *    • My Portal             (the browser geofenced clock-in widget)
 *
 *  Why a separate module? The geofence feature must keep working when the map
 *  cannot: distance, the accept/reject verdict and the audit trail are all
 *  computed on the SERVER (src/lib/geofence.ts + src/lib/geo-punch.ts) and
 *  never touch a tile provider. Maps are a courtesy layer. `isMapConfigured()`
 *  lets the UI degrade to a schematic diagram instead of a broken map.
 *
 *  Provider policy
 *  ───────────────
 *  The default provider is Geoapify, driven entirely by environment variables
 *  so no key is ever committed:
 *
 *    NEXT_PUBLIC_GEOAPIFY_API_KEY   browser-restricted Geoapify key
 *    NEXT_PUBLIC_MAP_TILE_STYLE     Geoapify style (default "osm-bright")
 *
 *  A different compliant provider can be dropped in with NO code change by
 *  setting a full tile template instead:
 *
 *    NEXT_PUBLIC_MAP_TILE_URL       e.g. https://tiles.example/{z}/{x}/{y}.png
 *    NEXT_PUBLIC_MAP_ATTRIBUTION    required attribution HTML for that provider
 *
 *  Demo fallback (current default while no key exists)
 *  ──────────────────────────────────────────────────
 *  Until a Geoapify key is provisioned the module falls back to the PUBLIC
 *  OpenStreetMap standard tile server so the maps still render during review
 *  and testing. This is explicitly a DEMO shortcut:
 *
 *    • OSM's tile server is run on donated capacity and its usage policy
 *      (https://operations.osmfoundation.org/policies/tiles/) forbids heavy
 *      or commercial use. It is NOT an unlimited production service.
 *    • Adding NEXT_PUBLIC_GEOAPIFY_API_KEY (or NEXT_PUBLIC_MAP_TILE_URL)
 *      supersedes the demo tiles automatically — no code change needed.
 *    • Set NEXT_PUBLIC_MAP_DEMO_TILES=off to disable the fallback and return
 *      to the offline schematic diagram.
 *
 *  Either way the geofence verdict is computed server-side, so a tile provider
 *  outage can never produce a wrong clock-in — maps are a courtesy layer only.
 */

/** The key the browser sends to Geoapify's tile endpoint. Read at build time. */
export function geoapifyKey(): string {
  return (process.env.NEXT_PUBLIC_GEOAPIFY_API_KEY ?? "").trim();
}

/** A full, explicit tile template that wins over the built-in provider. */
export function customTileUrl(): string {
  return (process.env.NEXT_PUBLIC_MAP_TILE_URL ?? "").trim();
}

/** Geoapify style slug (see their Tile API docs). */
export function geoapifyStyle(): string {
  return (process.env.NEXT_PUBLIC_MAP_TILE_STYLE ?? "").trim() || "osm-bright";
}

/**
 * The public OpenStreetMap standard tile template used as the DEMO fallback.
 * See the header note — this is not for production/commercial load. A real key
 * or an explicit NEXT_PUBLIC_MAP_TILE_URL always wins over it.
 */
export const OSM_DEMO_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

/**
 * True unless the demo fallback is explicitly switched off with
 * NEXT_PUBLIC_MAP_DEMO_TILES=off/0/false. Defaults to ON so maps render out of
 * the box while no Geoapify key exists.
 */
export function demoTilesEnabled(): boolean {
  const raw = (process.env.NEXT_PUBLIC_MAP_DEMO_TILES ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no") return false;
  return true;
}

/** The provider actually in play: a keyed/custom server, or the OSM demo fallback. */
export type MapProvider = "custom" | "geoapify" | "osm-demo" | "none";

export function mapProvider(): MapProvider {
  if (customTileUrl()) return "custom";
  if (geoapifyKey()) return "geoapify";
  if (demoTilesEnabled()) return "osm-demo";
  return "none";
}

/** True when the tiles on screen come from the public OSM demo server. */
export function isDemoTiles(): boolean {
  return mapProvider() === "osm-demo";
}

/**
 * True when MapCanvas should draw real tiles (a key, a custom template, or the
 * OSM demo fallback). False only when nothing is configured AND the demo
 * fallback has been switched off — then the schematic diagram is used.
 */
export function isMapConfigured(): boolean {
  return mapProvider() !== "none";
}

/** Substitute the `{apiKey}` placeholder (explicit templates may need it). */
function applyKey(template: string): string {
  const key = geoapifyKey();
  return template.replace(/\{apiKey\}/g, encodeURIComponent(key));
}

/**
 * The Leaflet tile template, or null when unconfigured. `{z}/{x}/{y}` are
 * substituted by Leaflet; `{s}` (subdomain) is supported too.
 */
export function tileUrlTemplate(): string | null {
  const custom = customTileUrl();
  if (custom) return applyKey(custom);

  const key = geoapifyKey();
  if (key) {
    // Geoapify Tile API: /v1/tile/{style}/{z}/{x}/{y}.png?apiKey=…
    return `https://maps.geoapify.com/v1/tile/${encodeURIComponent(geoapifyStyle())}/{z}/{x}/{y}.png?apiKey=${encodeURIComponent(key)}`;
  }

  // DEMO fallback — public OSM standard tiles (see header note).
  if (demoTilesEnabled()) return OSM_DEMO_TILE_URL;

  return null;
}

/**
 * Attribution HTML Leaflet renders in the corner. Geoapify's terms require
 * crediting both Geoapify and OpenStreetMap; a custom provider must supply its
 * own via NEXT_PUBLIC_MAP_ATTRIBUTION.
 */
export function mapAttribution(): string {
  const custom = (process.env.NEXT_PUBLIC_MAP_ATTRIBUTION ?? "").trim();
  if (custom) return custom;
  if (mapProvider() === "geoapify") {
    return 'Powered by <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">Geoapify</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';
  }
  return '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';
}

/** Subdomains for `{s}` templates; harmless when the template has no `{s}`. */
export const TILE_SUBDOMAINS = "abc";

/**
 * A pragmatic zoom level for a fence of `radiusMeters` — close enough that the
 * whole circle is comfortably visible. Bounds: 13 (large site) … 18 (tight).
 */
export function zoomForRadius(radiusMeters: number): number {
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) return 16;
  // Each zoom level halves the ground scale; ~250 m across at z16 in a typical
  // map pane. Clamp to a friendly band.
  const z = Math.round(16 - Math.log2(Math.max(1, radiusMeters) / 150));
  return Math.min(18, Math.max(13, z));
}

/** Human-readable one-line summary for the settings hint. */
export function mapConfigSummary(): string {
  switch (mapProvider()) {
    case "geoapify":
      return `Geoapify tiles · style “${geoapifyStyle()}”`;
    case "custom":
      return "Custom tile provider";
    case "osm-demo":
      return "OpenStreetMap demo tiles — add a Geoapify key before production";
    default:
      return "No tile provider configured — schematic only";
  }
}
