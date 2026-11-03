/**
 * ============================================================================
 *  SiteMap.tsx — the phone's Leaflet map inside a WebView
 * ============================================================================
 *
 *  What it draws:
 *    · every registered site the phone may clock in at (neon circles + radius),
 *    · the employee's home site (white ring, labelled), and
 *    · the current GPS fix, when one is known (pulsing neon dot).
 *
 *  Whenever any site's radius or coordinates are edited in the web admin,
 *  `fenceSignature` updates and the WebView immediately redraws the resized
 *  geofence boundaries.
 */

import React, { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { WebView } from "react-native-webview";

import { haversineMeters } from "@/lib/geo";
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

  // If the employee is physically inside a site, centre on that site's fence;
  // otherwise centre on their home site or the first configured site so the
  // geofence circles and their radii are always visible on screen.
  const insideSite = me
    ? sites.find(
        (s) => Math.round(haversineMeters(me.latitude, me.longitude, s.latitude, s.longitude)) <= s.radiusMeters
      ) ?? null
    : null;

  const anchor = insideSite
    ? {
        latitude: insideSite.latitude,
        longitude: insideSite.longitude,
        radiusMeters: insideSite.radiusMeters,
      }
    : home
      ? { latitude: home.latitude, longitude: home.longitude, radiusMeters: home.radiusMeters }
      : sites[0]
        ? {
            latitude: sites[0].latitude,
            longitude: sites[0].longitude,
            radiusMeters: sites[0].radiusMeters,
          }
        : me
          ? { latitude: me.latitude, longitude: me.longitude, radiusMeters: 150 }
          : { latitude: -20.1725, longitude: 28.5752, radiusMeters: 500 };

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
    background: rgba(10,10,10,0.88);
    color: #ffffff;
    border: 1px solid rgba(0,230,118,0.55);
    border-radius: 6px;
    padding: 2px 6px;
    font-size: 10px;
    font-weight: 700;
    white-space: nowrap;
  }
  .site-label span {
    color: #00e676;
    font-family: monospace;
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
      color: '#00e676', weight: 2, fillColor: '#00e676', fillOpacity: 0.14
    }).addTo(group);
    L.marker([site.latitude, site.longitude], {
      interactive: false,
      icon: L.divIcon({
        className: '',
        html: '<div class="site-label">' + escapeHtml(site.branch) + ' <span>(' + site.radiusMeters + 'm)</span></div>',
        iconSize: [0, 0], iconAnchor: [0, 14]
      })
    }).addTo(group);
  });

  if (data.home) {
    L.circle([data.home.latitude, data.home.longitude], {
      radius: data.home.radiusMeters,
      color: '#ffffff', weight: 1.5, dashArray: '4 4', fillOpacity: 0
    }).addTo(group);
  }

  if (data.me) {
    L.marker([data.me.latitude, data.me.longitude], {
      interactive: false,
      icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] })
    }).addTo(group);
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
  const [fullscreen, setFullscreen] = useState(false);

  // Signature of all fence radii & coordinates so WebView always remounts on any geofence edit
  const fenceSignature = useMemo(() => {
    const sitesSig = (sites ?? [])
      .map((s) => `${s.branch}:${s.latitude}:${s.longitude}:${s.radiusMeters}`)
      .join("|");
    const homeSig = home
      ? `${home.branch ?? ""}:${home.latitude ?? ""}:${home.longitude ?? ""}:${home.radiusMeters ?? ""}`
      : "none";
    return `${sitesSig}::${homeSig}`;
  }, [sites, home]);

  const html = useMemo(() => buildHtml(buildPayload({ sites, home, me })), [sites, home, me]);

  const mapContent = (
    <>
      <WebView
        key={fenceSignature}
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
    </>
  );

  return (
    <>
      <View style={[styles.wrap, { height }]}>
        {mapContent}
        <TouchableOpacity
          style={styles.expandBtn}
          onPress={() => setFullscreen(true)}
          activeOpacity={0.85}
        >
          <Text style={styles.expandText}>Open full map</Text>
        </TouchableOpacity>
      </View>

      <Modal
        visible={fullscreen}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setFullscreen(false)}
      >
        <View style={styles.fullscreenWrap}>
          <View style={styles.fullscreenHeader}>
            <Text style={styles.fullscreenTitle}>Site Map</Text>
            <Pressable style={styles.closeBtn} onPress={() => setFullscreen(false)}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
          <View style={styles.fullscreenBody}>{mapContent}</View>
        </View>
      </Modal>
    </>
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
  expandBtn: {
    position: "absolute",
    bottom: SPACING.sm,
    right: SPACING.sm,
    backgroundColor: "rgba(0,230,118,0.9)",
    borderRadius: RADIUS.sm,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderWidth: 1,
    borderColor: "rgba(0,230,118,0.6)",
  },
  expandText: {
    fontSize: FONT.tiny,
    fontWeight: "700",
    color: "#000",
    letterSpacing: 0.5,
  },
  fullscreenWrap: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  fullscreenHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    backgroundColor: "rgba(10,10,10,0.95)",
  },
  fullscreenTitle: {
    fontSize: FONT.body,
    fontWeight: "700",
    color: COLORS.white,
  },
  closeBtn: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    backgroundColor: "rgba(45,27,78,0.8)",
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.accent,
  },
  closeText: {
    fontSize: FONT.tiny,
    fontWeight: "700",
    color: COLORS.white,
  },
  fullscreenBody: {
    flex: 1,
  },
});
