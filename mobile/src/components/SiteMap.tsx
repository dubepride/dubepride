/**
 * ============================================================================
 *  SiteMap.tsx — the phone's Leaflet map inside a WebView (Phase 18)
 * ============================================================================
 *
 *  Why a WebView? The app is a hand-written Expo build with no Google Maps key,
 *  and Leaflet is already the map stack used by the web dashboard. Reusing it
 *  keeps ONE tile policy (src/lib/maps.ts here; src/lib/maps.ts on the server)
 *  and means the phone shows exactly the same fences a browser does.
 *
 *  What it draws:
 *    · every registered site the phone may clock in at (neon circles),
 *    · the employee's home site (white ring, labelled), and
 *    · the current GPS fix, when one is known (pulsing neon dot).
 *
 *  This is a courtesy display. The bridge re-derives the governing site from
 *  the coordinates on every punch, so nothing here — not even a tampered fence
 *  radius — can change where a punch lands. If tiles fail to load the map still
 *  shows the fences on a dark background; the distances in the status card are
 *  computed in JS and remain exact.
 */

import React, { useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";

import { isDemoTiles, mapAttribution, tileUrlTemplate, zoomForRadius } from "@/lib/maps";
import type { GeofenceConfig, GeoFenceSite } from "@/lib/types";
import { COLORS, FONT, RADIUS, SPACING } from "@/theme";

export interface SiteMapProps {
  /** Every site the phone may clock in at. */
  sites: readonly GeoFenceSite[];
  /** The employee's own site, drawn as a labelled home ring. */
  home?: GeofenceConfig | null;
  /** The current fix, when known. */
  me?: { latitude: number; longitude: number } | null;
  /** Map height in px. */
  height?: number;
}

/** Everything the Leaflet page needs, serialised into the HTML. */
interface MapPayload {
  tileUrl: string;
  attribution: string;
  demo: boolean;
  sites: { branch: string; latitude: number; longitude: number; radiusMeters: number }[];
  home: { branch: string; latitude: number; longitude: number; radiusMeters: number } | null;
  me: { latitude: number; longitude: number } | null;
  center: { latitude: number; longitude: number };
  zoom: number;
}

/**
 * Embed a JSON payload into a <script> safely: the only dangerous sequences
 * inside a script element are `</script` and HTML comment openers, so a blanket
 * `<` → \u003c escape closes both off (branch names come from the database).
 */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function buildPayload(props: SiteMapProps): MapPayload {
  const sites = (props.sites ?? [])
    .filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude) && s.radiusMeters > 0)
    .map((s) => ({
      branch: s.branch,
      latitude: s.latitude,
      longitude: s.longitude,
      radiusMeters: s.radiusMeters,
    }));

  const homeConfig = props.home;
  const home =
    homeConfig &&
    Number.isFinite(homeConfig.latitude) &&
    Number.isFinite(homeConfig.longitude) &&
    (homeConfig.radiusMeters ?? 0) > 0 &&
    homeConfig.branch
      ? {
          branch: homeConfig.branch,
          latitude: Number(homeConfig.latitude),
          longitude: Number(homeConfig.longitude),
          radiusMeters: Number(homeConfig.radiusMeters),
        }
      : null;

  const me =
    props.me && Number.isFinite(props.me.latitude) && Number.isFinite(props.me.longitude)
      ? { latitude: props.me.latitude, longitude: props.me.longitude }
      : null;

  // Centre on the fix when we have one, else the home site, else the first
  // site; the zoom follows that site's radius.
  const anchor = me
    ? { latitude: me.latitude, longitude: me.longitude, radiusMeters: 150 }
    : home
      ? { latitude: home.latitude, longitude: home.longitude, radiusMeters: home.radiusMeters }
      : sites[0]
        ? { latitude: sites[0].latitude, longitude: sites[0].longitude, radiusMeters: sites[0].radiusMeters }
        : { latitude: -17.8292, longitude: 31.0522, radiusMeters: 1000 };

  return {
    tileUrl: tileUrlTemplate(),
    attribution: mapAttribution(),
    demo: isDemoTiles(),
    sites,
    home,
    me,
    center: { latitude: anchor.latitude, longitude: anchor.longitude },
    zoom: zoomForRadius(anchor.radiusMeters),
  };
}

/**
 * The Leaflet document. Kept as one template literal so the whole map is a
 * single self-contained page: no bundler needed on the device, and the Android
 * WebView loads Leaflet from the CDN the same way a browser would.
 */
function buildHtml(payload: MapPayload): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
  html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; background: #0d0d12; }
  .leaflet-container { background: #0d0d12; font: 13px system-ui, sans-serif; }
  .leaflet-control-attribution {
    background: rgba(10,10,10,0.72) !important;
    color: #a0aec0 !important;
    font-size: 9px !important;
  }
  .leaflet-control-attribution a { color: #00e676 !important; }
  .site-label {
    background: rgba(10,10,10,0.82);
    color: #ffffff;
    border: 1px solid rgba(0,230,118,0.5);
    border-radius: 6px;
    padding: 1px 5px;
    font-size: 10px;
    white-space: nowrap;
  }
  .me-dot {
    width: 16px; height: 16px; border-radius: 50%;
    background: #00e676;
    box-shadow: 0 0 0 4px rgba(0,230,118,0.22), 0 0 14px rgba(0,230,118,0.8);
  }
  #tiles-note {
    display: none;
    position: absolute; left: 0; right: 0; bottom: 0; z-index: 500;
    padding: 4px 8px; font-size: 10px; text-align: center;
    color: #c9bce4; background: rgba(10,10,10,0.86);
  }
  #demo-note {
    position: absolute; left: 0; right: 0; bottom: 0; z-index: 400;
    padding: 3px 8px; font-size: 9px; letter-spacing: 0.02em; text-align: center;
    color: #a0aec0; background: rgba(10,10,10,0.8);
  }
</style>
</head>
<body>
<div id="map"></div>
<div id="tiles-note">Map tiles unavailable — fences are still exact. Distances are computed on the bridge.</div>
<div id="demo-note" style="display:${payload.demo ? "block" : "none"}">OpenStreetMap demo tiles</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function () {
  var data = ${safeJson(payload)};

  var map = L.map('map', { zoomControl: true, attributionControl: true, preferCanvas: true })
             .setView([data.center.latitude, data.center.longitude], data.zoom);

  var tiles = L.tileLayer(data.tileUrl, { maxZoom: 20, crossOrigin: true, attribution: data.attribution });
  tiles.on('tileerror', function () { document.getElementById('tiles-note').style.display = 'block'; });
  tiles.addTo(map);

  var group = L.layerGroup().addTo(map);

  data.sites.forEach(function (site) {
    L.circle([site.latitude, site.longitude], {
      radius: site.radiusMeters,
      color: '#00e676', weight: 2, fillColor: '#00e676', fillOpacity: 0.12
    }).addTo(group);
    L.marker([site.latitude, site.longitude], {
      interactive: false,
      icon: L.divIcon({
        className: '',
        html: '<div class="site-label">' + escapeHtml(site.branch) + '</div>',
        iconSize: [0, 0], iconAnchor: [0, 14]
      })
    }).addTo(group);
  });

  if (data.home) {
    L.circle([data.home.latitude, data.home.longitude], {
      radius: data.home.radiusMeters,
      color: '#ffffff', weight: 1, dashArray: '4 4', fillOpacity: 0
    }).addTo(group);
  }

  if (data.me) {
    L.marker([data.me.latitude, data.me.longitude], {
      interactive: false,
      icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] })
    }).addTo(group);
  }

  if (!data.me && !data.home && data.sites.length > 0) {
    map.fitBounds(group.getBounds().pad(0.25), { animate: false });
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
})();
</script>
</body>
</html>`;
}

export function SiteMap({ sites, home, me, height = 260 }: SiteMapProps): React.ReactElement {
  const [failed, setFailed] = useState(false);
  const html = useMemo(() => buildHtml(buildPayload({ sites, home, me })), [sites, home, me]);

  return (
    <View style={[styles.wrap, { height }]}>
      <WebView
        originWhitelist={["*"]}
        source={{ html }}
        style={styles.web}
        javaScriptEnabled
        domStorageEnabled
        setSupportMultipleWindows={false}
        androidLayerType="hardware"
        onError={() => setFailed(true)}
        onHttpError={() => setFailed(true)}
      />
      {failed ? (
        <View style={styles.fallback} pointerEvents="none">
          <Text style={styles.fallbackText}>
            The map could not be displayed. Site fences and distances are unaffected.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: "100%",
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: "#0d0d12",
    overflow: "hidden",
  },
  web: {
    flex: 1,
    backgroundColor: "transparent",
  },
  fallback: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    padding: SPACING.lg,
    backgroundColor: "rgba(13,13,18,0.92)",
  },
  fallbackText: {
    fontSize: FONT.small,
    color: COLORS.textMuted,
    textAlign: "center",
    lineHeight: 19,
  },
});
