const RANGE_LABELS = Object.freeze({
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "365d": "Last year",
  all: "All rides",
});

export const HEATMAP_RANGES = Object.freeze(Object.keys(RANGE_LABELS));

export function heatmapRangeLabel(range) {
  return RANGE_LABELS[range] ?? RANGE_LABELS["90d"];
}

export function heatmapZoomBucket(zoom) {
  if (zoom <= 12) return 5;
  if (zoom <= 14) return 6;
  return 7;
}

export function heatmapRequestUrl(bounds, zoom, range) {
  const parameters = new URLSearchParams({
    bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(","),
    zoom: String(Math.round(zoom)),
    range,
    scope: "mine",
  });
  return `/api/heatmap?${parameters}`;
}

export function heatmapMarkerStyle(distanceMeters, maximumDistanceMeters) {
  const ratio = maximumDistanceMeters > 0
    ? Math.min(1, Math.sqrt(Math.max(0, distanceMeters) / maximumDistanceMeters))
    : 0;
  return {
    fillOpacity: 0.2 + ratio * 0.62,
    opacity: 0.3 + ratio * 0.6,
    radius: 9 + ratio * 15,
  };
}
