/**
 * ============================================================================
 *  maps.test.ts — tile-provider resolution for the geofence maps
 * ============================================================================
 *
 *  The maps are a courtesy layer, but WHICH tile provider they point at is a
 *  policy decision (OSM's demo server must never be a silent production
 *  dependency). These tests pin that resolution down:
 *
 *    no config          → OpenStreetMap DEMO tiles, provider "osm-demo"
 *    demo disabled      → no tiles at all (schematic fallback), provider "none"
 *    Geoapify key       → keyed tiles, provider "geoapify"
 *    explicit template  → that template wins, provider "custom"
 *
 *  The module reads NEXT_PUBLIC_* at call time, so each test sets the env it
 *  needs and restores it afterwards.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  OSM_DEMO_TILE_URL,
  demoTilesEnabled,
  geoapifyKey,
  isDemoTiles,
  isMapConfigured,
  mapAttribution,
  mapProvider,
  tileUrlTemplate,
  zoomForRadius,
} from "../src/lib/maps.ts";

/** Run `body` with the map-related env vars temporarily overridden. */
function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
  const keys = [
    "NEXT_PUBLIC_GEOAPIFY_API_KEY",
    "NEXT_PUBLIC_MAP_TILE_URL",
    "NEXT_PUBLIC_MAP_TILE_STYLE",
    "NEXT_PUBLIC_MAP_ATTRIBUTION",
    "NEXT_PUBLIC_MAP_DEMO_TILES",
  ] as const;

  const saved = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("defaults to the OSM demo tiles when nothing is configured", () => {
  withEnv({}, () => {
    assert.equal(geoapifyKey(), "");
    assert.equal(demoTilesEnabled(), true);
    assert.equal(mapProvider(), "osm-demo");
    assert.equal(isDemoTiles(), true);
    assert.equal(isMapConfigured(), true);
    assert.equal(tileUrlTemplate(), OSM_DEMO_TILE_URL);
    assert.match(mapAttribution(), /OpenStreetMap/);
  });
});

test("NEXT_PUBLIC_MAP_DEMO_TILES=off disables the fallback entirely", () => {
  withEnv({ NEXT_PUBLIC_MAP_DEMO_TILES: "off" }, () => {
    assert.equal(demoTilesEnabled(), false);
    assert.equal(mapProvider(), "none");
    assert.equal(isDemoTiles(), false);
    assert.equal(isMapConfigured(), false);
    assert.equal(tileUrlTemplate(), null);
  });
});

test("a Geoapify key supersedes the demo tiles", () => {
  withEnv({ NEXT_PUBLIC_GEOAPIFY_API_KEY: "test-key", NEXT_PUBLIC_MAP_TILE_STYLE: "osm-carto" }, () => {
    assert.equal(mapProvider(), "geoapify");
    assert.equal(isDemoTiles(), false);
    const url = tileUrlTemplate();
    assert.ok(url && url.includes("/v1/tile/osm-carto/"));
    assert.ok(url?.includes("apiKey=test-key"));
    assert.match(mapAttribution(), /Geoapify/);
  });
});

test("an explicit tile template wins over everything", () => {
  withEnv(
    {
      NEXT_PUBLIC_MAP_TILE_URL: "https://tiles.example/{z}/{x}/{y}.png?key={apiKey}",
      NEXT_PUBLIC_GEOAPIFY_API_KEY: "ignored",
      NEXT_PUBLIC_MAP_ATTRIBUTION: "© Example",
    },
    () => {
      assert.equal(mapProvider(), "custom");
      assert.equal(tileUrlTemplate(), "https://tiles.example/{z}/{x}/{y}.png?key=ignored");
      assert.equal(mapAttribution(), "© Example");
    }
  );
});

test("zoomForRadius stays inside the friendly band", () => {
  assert.equal(zoomForRadius(0), 16);
  assert.equal(zoomForRadius(NaN), 16);
  assert.ok(zoomForRadius(50) <= 18);
  assert.ok(zoomForRadius(500_000) >= 13);
  // A larger fence must never zoom in more than a smaller one.
  assert.ok(zoomForRadius(1000) <= zoomForRadius(100));
});
