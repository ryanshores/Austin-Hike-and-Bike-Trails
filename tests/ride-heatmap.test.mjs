import assert from "node:assert/strict";
import test from "node:test";

import {
  HEATMAP_RANGES,
  heatmapMarkerStyle,
  heatmapRangeLabel,
  heatmapRequestUrl,
  heatmapZoomBucket,
} from "../app/ride-heatmap.js";

test("heatmap requests remain owner-scoped and viewport-bounded", () => {
  const bounds = {
    getEast: () => -97.73,
    getNorth: () => 30.28,
    getSouth: () => 30.26,
    getWest: () => -97.75,
  };
  const url = new URL(heatmapRequestUrl(bounds, 14.4, "90d"), "https://example.test");

  assert.equal(url.pathname, "/api/heatmap");
  assert.equal(url.searchParams.get("scope"), "mine");
  assert.equal(url.searchParams.get("bounds"), "-97.75,30.26,-97.73,30.28");
  assert.equal(url.searchParams.get("zoom"), "14");
  assert.equal(url.searchParams.get("range"), "90d");
});

test("heatmap rendering uses API-aligned zoom buckets and bounded markers", () => {
  assert.deepEqual([heatmapZoomBucket(12), heatmapZoomBucket(13), heatmapZoomBucket(15)], [5, 6, 7]);
  assert.deepEqual(HEATMAP_RANGES, ["30d", "90d", "365d", "all"]);
  assert.equal(heatmapRangeLabel("all"), "All rides");
  assert.equal(heatmapRangeLabel("unknown"), "Last 90 days");
  assert.deepEqual(heatmapMarkerStyle(0, 100), { fillOpacity: 0.2, opacity: 0.3, radius: 9 });
  assert.deepEqual(heatmapMarkerStyle(100, 100), { fillOpacity: 0.8200000000000001, opacity: 0.8999999999999999, radius: 24 });
});
