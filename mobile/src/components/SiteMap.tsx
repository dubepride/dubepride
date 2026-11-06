/**
 * ============================================================================
 *  SiteMap.tsx — 100% Offline Canvas Geofence Radar & Tactical Tracker
 * ============================================================================
 *
 *  Engineered for zero-network environments:
 *    • 100% Self-Contained: Zero external CDNs or leaflet tile downloads.
 *    • High-Precision Geofence Boundary: Renders exact meter radius and an outer
 *      perimeter buffer zone so movement around the site is crystal clear.
 *    • 60fps Silk-Smooth Gliding: `requestAnimationFrame` lerp loop inside HTML5
 *      Canvas interpolates positions continuously — zero flapping or jitter.
 *    • Never Reloads on GPS Fixes: React Native communicates via `injectJavaScript`
 *      (`window.updateFix`), maintaining full DOM and animation continuity.
 *    • Interactive: Touch drag to pan, pinch or buttons to zoom, center-lock.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
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
import type { GeofenceConfig, GeoFenceSite } from "@/lib/types";
import { COLORS, FONT, RADIUS, SPACING } from "@/theme";

export interface SiteMapProps {
  /** Every site the phone may clock in at. */
  sites: readonly GeoFenceSite[];
  /** The employee's own site, drawn as a labelled home ring. */
  home?: GeofenceConfig | null;
  /** The current fix, when known. */
  me?: { latitude: number; longitude: number; accuracy?: number | null } | null;
  /** Map height in px. */
  height?: number;
}

interface RadarPayload {
  sites: { branch: string; latitude: number; longitude: number; radiusMeters: number }[];
  home: { branch: string; latitude: number; longitude: number; radiusMeters: number } | null;
  center: { latitude: number; longitude: number; branch: string; radiusMeters: number };
  initialMe: { latitude: number; longitude: number; accuracy: number | null } | null;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function buildRadarPayload(props: SiteMapProps): RadarPayload {
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
      ? {
          latitude: props.me.latitude,
          longitude: props.me.longitude,
          accuracy: props.me.accuracy ?? null,
        }
      : null;

  const insideSite = me
    ? sites.find(
        (s) => Math.round(haversineMeters(me.latitude, me.longitude, s.latitude, s.longitude)) <= s.radiusMeters
      ) ?? null
    : null;

  const anchor = insideSite
    ? {
        latitude: insideSite.latitude,
        longitude: insideSite.longitude,
        branch: insideSite.branch,
        radiusMeters: insideSite.radiusMeters,
      }
    : home
      ? {
          latitude: home.latitude,
          longitude: home.longitude,
          branch: home.branch,
          radiusMeters: home.radiusMeters,
        }
      : sites[0]
        ? {
            latitude: sites[0].latitude,
            longitude: sites[0].longitude,
            branch: sites[0].branch,
            radiusMeters: sites[0].radiusMeters,
          }
        : me
          ? { latitude: me.latitude, longitude: me.longitude, branch: "Current GPS", radiusMeters: 20 }
          : { latitude: -20.1725, longitude: 28.5752, branch: "Standard Center", radiusMeters: 20 };

  return {
    sites,
    home,
    center: anchor,
    initialMe: me,
  };
}

function buildRadarHtml(payload: RadarPayload): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  * { box-sizing: border-box; user-select: none; -webkit-user-select: none; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #0b0c10; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; }
  #canvas-container { position: absolute; width: 100%; height: 100%; top: 0; left: 0; }
  canvas { display: block; width: 100%; height: 100%; }

  /* Tactical HUD Header */
  .hud-top {
    position: absolute; top: 8px; left: 10px; right: 10px;
    display: flex; justify-content: space-between; align-items: flex-start;
    pointer-events: none; z-index: 10;
  }
  .hud-status-badge {
    background: rgba(14, 17, 23, 0.92);
    border: 1px solid rgba(0, 230, 118, 0.45);
    border-radius: 8px;
    padding: 6px 10px;
    backdrop-filter: blur(4px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  }
  .status-main {
    font-size: 11px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase;
    display: flex; align-items: center; gap: 5px;
  }
  .status-main.inside { color: #00e676; }
  .status-main.buffer { color: #f59e0b; }
  .status-main.outside { color: #ef4444; }
  .status-main.locating { color: #94a3b8; }
  .status-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 8px currentColor;
  }
  .status-sub {
    font-size: 10px; color: #cbd5e1; margin-top: 3px; font-family: monospace;
  }

  .hud-acc-badge {
    background: rgba(14, 17, 23, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 9px;
    font-family: monospace;
    color: #94a3b8;
    letter-spacing: 0.03em;
  }
  .hud-acc-badge span { color: #00e676; font-weight: 700; }

  /* Radar Controls Overlay */
  .controls {
    position: absolute; right: 10px; bottom: 12px;
    display: flex; flex-direction: column; gap: 6px;
    z-index: 10;
  }
  .ctrl-btn {
    width: 34px; height: 34px; border-radius: 8px;
    background: rgba(22, 27, 34, 0.9);
    border: 1px solid rgba(0, 230, 118, 0.4);
    color: #00e676; font-size: 18px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    touch-action: manipulation;
  }
  .ctrl-btn:active { background: #00e676; color: #0b0c10; }

  /* Bottom Legend Info */
  .hud-bottom {
    position: absolute; left: 10px; bottom: 8px;
    font-size: 9px; font-family: monospace; color: #64748b;
    pointer-events: none; z-index: 10;
  }
</style>
</head>
<body>
<div id="canvas-container">
  <canvas id="radar"></canvas>
</div>

<div class="hud-top">
  <div class="hud-status-badge">
    <div class="status-main locating" id="hud-title">
      <div class="status-dot"></div>
      <span id="hud-status-text">INITIALIZING RADAR</span>
    </div>
    <div class="status-sub" id="hud-sub-text">Acquiring smooth fix...</div>
  </div>
  <div class="hud-acc-badge" id="hud-acc">
    GPS: <span id="hud-acc-val">--</span>
  </div>
</div>

<div class="controls">
  <div class="ctrl-btn" id="btn-zoom-in">+</div>
  <div class="ctrl-btn" id="btn-zoom-out">−</div>
  <div class="ctrl-btn" id="btn-recenter" title="Center on Me">◎</div>
</div>

<div class="hud-bottom">
  OFFLINE RADAR · SECURE GEOFENCE BOUNDARY
</div>

<script>
(function () {
  var data = ${safeJson(payload)};
  var canvas = document.getElementById('radar');
  var ctx = canvas.getContext('2d');

  var hudTitle = document.getElementById('hud-title');
  var hudStatusText = document.getElementById('hud-status-text');
  var hudSubText = document.getElementById('hud-sub-text');
  var hudAccVal = document.getElementById('hud-acc-val');

  var dpr = window.devicePixelRatio || 1;
  var width = 0;
  var height = 0;

  // View state: scale in pixels per meter
  var defaultRadius = data.center.radiusMeters || 20;
  var defaultScale = 3.5; 
  var scale = defaultScale;
  var panX = 0;
  var panY = 0;

  // Smooth position lerp
  var curPos = null;    // { x_m, y_m } relative to data.center
  var targetPos = null; // { x_m, y_m, accuracy, lat, lng }
  var pulseTimer = 0;

  var centerLat = data.center.latitude;
  var centerLng = data.center.longitude;
  var latCos = Math.cos(centerLat * Math.PI / 180);

  function projectToMeters(lat, lng) {
    var dx = (lng - centerLng) * (111320 * latCos);
    var dy = (lat - centerLat) * 111320;
    return { x: dx, y: dy };
  }

  function resize() {
    width = canvas.parentElement.clientWidth;
    height = canvas.parentElement.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    var viewDim = Math.min(width, height);
    var desiredCoverageMeters = (defaultRadius + 20) * 2;
    defaultScale = Math.max(1.8, Math.min(8.0, viewDim / Math.max(30, desiredCoverageMeters)));
    if (scale === 3.5) scale = defaultScale;
  }
  window.addEventListener('resize', resize);
  resize();

  window.updateFix = function(lat, lng, accuracy) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    var p = projectToMeters(lat, lng);
    targetPos = {
      x: p.x,
      y: p.y,
      accuracy: accuracy !== null && Number.isFinite(accuracy) ? accuracy : null,
      lat: lat,
      lng: lng,
    };
    if (!curPos) {
      curPos = { x: p.x, y: p.y };
    }
  };

  if (data.initialMe) {
    window.updateFix(data.initialMe.latitude, data.initialMe.longitude, data.initialMe.accuracy);
  }

  function updateHUD(distMeters, inside, inBuffer, accuracy) {
    if (accuracy !== null) {
      hudAccVal.textContent = '±' + Math.round(accuracy) + 'm';
    } else {
      hudAccVal.textContent = 'Active';
    }

    hudTitle.className = 'status-main ' + (inside ? 'inside' : inBuffer ? 'buffer' : 'outside');
    if (inside) {
      hudStatusText.textContent = 'INSIDE GEOFENCE';
      hudSubText.textContent = data.center.branch + ' · ' + distMeters.toFixed(1) + 'm from centre';
    } else if (inBuffer) {
      var outsideM = (distMeters - defaultRadius).toFixed(1);
      hudStatusText.textContent = 'BUFFER ZONE';
      hudSubText.textContent = '+' + outsideM + 'm outside boundary (' + distMeters.toFixed(1) + 'm from centre)';
    } else {
      var outsideM = (distMeters - defaultRadius).toFixed(1);
      hudStatusText.textContent = 'OUTSIDE GEOFENCE';
      hudSubText.textContent = '+' + outsideM + 'm outside boundary (' + distMeters.toFixed(1) + 'm from centre)';
    }
  }

  function render() {
    pulseTimer += 0.035;

    if (targetPos) {
      if (!curPos) {
        curPos = { x: targetPos.x, y: targetPos.y };
      } else {
        curPos.x += (targetPos.x - curPos.x) * 0.16;
        curPos.y += (targetPos.y - curPos.y) * 0.16;
      }
    }

    var cx = width / 2 + panX;
    var cy = height / 2 + panY;

    ctx.fillStyle = '#0b0c10';
    ctx.fillRect(0, 0, width, height);

    drawGrid(cx, cy);
    drawRadarRings(cx, cy);

    data.sites.forEach(function (site) {
      var sp = projectToMeters(site.latitude, site.longitude);
      var scx = cx + sp.x * scale;
      var scy = cy - sp.y * scale;
      var sRadPx = site.radiusMeters * scale;
      var bufferRadPx = (site.radiusMeters + 15) * scale;

      ctx.beginPath();
      ctx.arc(scx, scy, bufferRadPx, 0, Math.PI * 2);
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.35)';
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.arc(scx, scy, sRadPx, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 230, 118, 0.12)';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#00e676';
      ctx.shadowColor = '#00e676';
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.shadowBlur = 0;

      drawCrosshair(scx, scy, 7, '#00e676');

      ctx.font = 'bold 10px monospace';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.fillText(site.branch + ' (' + site.radiusMeters + 'm)', scx, scy - sRadPx - 6);
    });

    drawCompass(cx, cy);

    if (curPos && targetPos) {
      var mx = cx + curPos.x * scale;
      var my = cy - curPos.y * scale;

      var distMeters = Math.sqrt(curPos.x * curPos.x + curPos.y * curPos.y);
      var bufferRadius = defaultRadius + 15;
      var isInside = distMeters <= defaultRadius;
      var isBuffer = !isInside && distMeters <= bufferRadius;

      updateHUD(distMeters, isInside, isBuffer, targetPos.accuracy);

      var dotColor = isInside ? '#00e676' : isBuffer ? '#f59e0b' : '#ef4444';
      var haloColor = isInside ? 'rgba(0, 230, 118, 0.18)' : isBuffer ? 'rgba(245, 158, 11, 0.18)' : 'rgba(239, 68, 68, 0.18)';

      if (targetPos.accuracy && targetPos.accuracy > 0) {
        var accPx = Math.min(180, Math.max(10, targetPos.accuracy * scale));
        ctx.beginPath();
        ctx.arc(mx, my, accPx, 0, Math.PI * 2);
        ctx.fillStyle = haloColor;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = dotColor;
        ctx.setLineDash([2, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      var pulseProgress = (pulseTimer % 1.5) / 1.5;
      var pulseRadius = 8 + pulseProgress * 28;
      ctx.beginPath();
      ctx.arc(mx, my, pulseRadius, 0, Math.PI * 2);
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = dotColor;
      ctx.globalAlpha = 1.0 - pulseProgress;
      ctx.stroke();
      ctx.globalAlpha = 1.0;

      ctx.beginPath();
      ctx.arc(mx, my, 8, 0, Math.PI * 2);
      ctx.fillStyle = dotColor;
      ctx.shadowColor = dotColor;
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.beginPath();
      ctx.arc(mx, my, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(mx, my);
      ctx.lineWidth = 1;
      ctx.strokeStyle = isInside ? 'rgba(0, 230, 118, 0.45)' : 'rgba(245, 158, 11, 0.45)';
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      var labelText = distMeters.toFixed(1) + 'm';
      ctx.font = 'bold 9px monospace';
      ctx.fillStyle = '#0b0c10';
      var textWidth = ctx.measureText(labelText).width;
      var tx = mx + 12;
      var ty = my - 12;
      ctx.fillStyle = 'rgba(14, 17, 23, 0.88)';
      ctx.fillRect(tx - 3, ty - 9, textWidth + 6, 12);
      ctx.fillStyle = dotColor;
      ctx.fillText(labelText, tx, ty);
    }

    requestAnimationFrame(render);
  }

  function drawGrid(cx, cy) {
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    var step = 10 * scale;
    if (step < 15) step *= 2;

    var startX = ((cx % step) + step) % step;
    for (var x = startX; x < width; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    var startY = ((cy % step) + step) % step;
    for (var y = startY; y < height; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  function drawRadarRings(cx, cy) {
    var ringInterval = defaultRadius <= 25 ? 5 : 10;
    var maxDistMeters = Math.max(100, (Math.max(width, height) / scale) * 0.7);

    for (var r = ringInterval; r <= maxDistMeters; r += ringInterval) {
      var rPx = r * scale;
      ctx.beginPath();
      ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = r === defaultRadius ? 'rgba(0, 230, 118, 0.25)' : 'rgba(255, 255, 255, 0.06)';
      ctx.stroke();

      ctx.font = '8px monospace';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
      ctx.textAlign = 'left';
      ctx.fillText(r + 'm', cx + 4, cy - rPx + 9);
    }
  }

  function drawCompass(cx, cy) {
    var arrowLen = Math.min(width, height) * 0.44;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';

    ctx.fillStyle = '#00e676';
    ctx.fillText('N', cx, Math.max(22, cy - arrowLen));
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillText('S', cx, Math.min(height - 18, cy + arrowLen));
    ctx.fillText('E', Math.min(width - 14, cx + arrowLen), cy + 3);
    ctx.fillText('W', Math.max(14, cx - arrowLen), cy + 3);
  }

  function drawCrosshair(x, y, size, color) {
    ctx.beginPath();
    ctx.moveTo(x - size, y); ctx.lineTo(x + size, y);
    ctx.moveTo(x, y - size); ctx.lineTo(x + size, y);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  var touchStartDist = 0;
  var touchStartScale = scale;
  var touchStartX = 0;
  var touchStartY = 0;
  var isDragging = false;

  canvas.addEventListener('touchstart', function(e) {
    if (e.touches.length === 1) {
      isDragging = true;
      touchStartX = e.touches[0].clientX - panX;
      touchStartY = e.touches[0].clientY - panY;
    } else if (e.touches.length === 2) {
      isDragging = false;
      var dx = e.touches[0].clientX - e.touches[1].clientX;
      var dy = e.touches[0].clientY - e.touches[1].clientY;
      touchStartDist = Math.sqrt(dx * dx + dy * dy);
      touchStartScale = scale;
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', function(e) {
    e.preventDefault();
    if (isDragging && e.touches.length === 1) {
      panX = e.touches[0].clientX - touchStartX;
      panY = e.touches[0].clientY - touchStartY;
    } else if (e.touches.length === 2 && touchStartDist > 0) {
      var dx = e.touches[0].clientX - e.touches[1].clientX;
      var dy = e.touches[0].clientY - e.touches[1].clientY;
      var curDist = Math.sqrt(dx * dx + dy * dy);
      var ratio = curDist / touchStartDist;
      scale = Math.max(1.0, Math.min(22.0, touchStartScale * ratio));
    }
  }, { passive: false });

  canvas.addEventListener('touchend', function() {
    isDragging = false;
    touchStartDist = 0;
  });

  document.getElementById('btn-zoom-in').addEventListener('click', function(e) {
    e.stopPropagation();
    scale = Math.min(22.0, scale * 1.3);
  });
  document.getElementById('btn-zoom-out').addEventListener('click', function(e) {
    e.stopPropagation();
    scale = Math.max(1.0, scale / 1.3);
  });
  document.getElementById('btn-recenter').addEventListener('click', function(e) {
    e.stopPropagation();
    panX = 0;
    panY = 0;
    scale = defaultScale;
    if (curPos) {
      panX = -(curPos.x * scale) * 0.5;
      panY = (curPos.y * scale) * 0.5;
    }
  });

  requestAnimationFrame(render);
})();
</script>
</body>
</html>`;
}

export function SiteMap({ sites, home, me, height = 260 }: SiteMapProps): React.ReactElement {
  const [fullscreen, setFullscreen] = useState(false);
  const webViewRef = useRef<WebView>(null);
  const fullWebViewRef = useRef<WebView>(null);

  // Signature of all fence radii & coordinates so Radar updates geometry when admin changes geofence
  const fenceSignature = useMemo(() => {
    const sitesSig = (sites ?? [])
      .map((s) => `${s.branch}:${s.latitude}:${s.longitude}:${s.radiusMeters}`)
      .join("|");
    const homeSig = home
      ? `${home.branch ?? ""}:${home.latitude ?? ""}:${home.longitude ?? ""}:${home.radiusMeters ?? ""}`
      : "none";
    return `${sitesSig}::${homeSig}`;
  }, [sites, home]);

  const html = useMemo(() => buildRadarHtml(buildRadarPayload({ sites, home, me })), [fenceSignature]);

  // Smooth position injection: updates dot coordinates without tearing down the DOM or reloading!
  useEffect(() => {
    if (me && Number.isFinite(me.latitude) && Number.isFinite(me.longitude)) {
      const acc = me.accuracy !== null && me.accuracy !== undefined ? me.accuracy : "null";
      const jsCode = `if (window.updateFix) { window.updateFix(${me.latitude}, ${me.longitude}, ${acc}); } true;`;
      webViewRef.current?.injectJavaScript(jsCode);
      fullWebViewRef.current?.injectJavaScript(jsCode);
    }
  }, [me?.latitude, me?.longitude, me?.accuracy]);

  const mapContent = (isModal = false) => (
    <WebView
      ref={isModal ? fullWebViewRef : webViewRef}
      key={`${fenceSignature}-${isModal ? "full" : "inline"}`}
      originWhitelist={["*"]}
      source={{ html }}
      style={styles.web}
      javaScriptEnabled
      domStorageEnabled
      setSupportMultipleWindows={false}
      androidLayerType="hardware"
      scrollEnabled={false}
    />
  );

  return (
    <>
      <View style={[styles.wrap, { height }]}>
        {mapContent(false)}
        <TouchableOpacity
          style={styles.expandBtn}
          onPress={() => setFullscreen(true)}
          activeOpacity={0.85}
        >
          <Text style={styles.expandText}>Expand Radar</Text>
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
            <Text style={styles.fullscreenTitle}>Tactical Geofence Radar</Text>
            <Pressable style={styles.closeBtn} onPress={() => setFullscreen(false)}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
          <View style={styles.fullscreenBody}>{mapContent(true)}</View>
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
    backgroundColor: "#0b0c10",
    overflow: "hidden",
  },
  web: {
    flex: 1,
    backgroundColor: "transparent",
  },
  expandBtn: {
    position: "absolute",
    bottom: SPACING.sm,
    left: SPACING.sm,
    backgroundColor: "rgba(0, 230, 118, 0.9)",
    borderRadius: RADIUS.sm,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderWidth: 1,
    borderColor: "rgba(0, 230, 118, 0.6)",
    zIndex: 20,
  },
  expandText: {
    fontSize: FONT.tiny,
    fontWeight: "700",
    color: "#0b0c10",
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
    backgroundColor: COLORS.panelDeep,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
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
