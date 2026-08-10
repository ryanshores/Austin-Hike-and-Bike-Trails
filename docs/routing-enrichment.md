# Offline routing-edge enrichment

Issue #9 uses an offline enrichment artifact to join City bicycle-facility
labels to stable directed routing-edge IDs. This is the narrow integration
contract between graph construction and the route provider; it does not require
the browser or Worker to spatially join City and OSM data per request.

Safety remains a preference with controlled fallback:

- A sufficiently covered, unambiguous City match is authoritative.
- Partial or contradictory City data is kept bicycle-legal when OSM permits
  cycling, but is assigned the lowest safety class and marked unknown.
- An edge with no City match uses OSM access and facility tags. Ordinary
  bicycle-legal streets remain routable at the lowest safety class.
- Explicit bicycle prohibitions remain prohibited.

This means the planner can still return a useful route when protected-facility
coverage is incomplete, while clearly reporting the less-safe sections for any
preference stricter than `Any bicycle-legal path`.

## Inputs

The builder consumes two GeoJSON FeatureCollections:

1. The versioned City facilities export with `BICYCLE_FACILITY`, `LINE_TYPE`,
   and `BIKE_LEVEL_OF_COMFORT` properties.
2. A directed-edge export from the pinned Valhalla graph. Each edge must have a
   stable `edgeId` (or `edge_id`/GeoJSON feature ID), a LineString, and an `osm`
   tag object. `osmWayId` and `travelDirection` are retained when supplied.

Valhalla's graph/tile APIs expose edge geometry, OSM way IDs, bicycle access,
cycle-lane, surface, and related attributes. Exporting those edges is a graph
build responsibility; the application repository deliberately does not parse
or mutate Valhalla's private binary tile format.

## Build

```bash
npm run routing:enrich -- \
  --city /path/to/austin-bike-facilities.geojson \
  --routing-edges /path/to/austin-directed-edges.geojson \
  --output /path/to/austin-routing-enrichment.json \
  --city-dataset-version austin-bike-facilities-v1 \
  --osm-extract-source https://download.bbbike.org/osm/bbbike/Austin/Austin.osm.pbf \
  --osm-extract-date 2026-08-01T17:06:55Z \
  --osm-extract-checksum md5:49344e78933b3eab0a84454f0d15d877 \
  --routing-graph-version 1785883953 \
  --valhalla-image ghcr.io/valhalla/valhalla-scripted:3.7.0@sha256:0a58e6f4d167437e0ec0fffa2cbf63582652c7d12bcbc895e581f3c86b7de6a4
```

The reviewed installation policy is a 25 m City match tolerance, 20 m edge
sampling, and 80% minimum unambiguous coverage for City authority. The builder
can accept other values for offline analysis, but `routing:verify-enrichment`
will reject those artifacts: an artifact must not choose the thresholds that
authorize its own City classifications. The output embeds SHA-256 hashes of
both input files plus the pinned Valhalla image, City dataset, OSM extract, and
routing graph versions. It is deterministic for identical inputs and options.

Generated full-dataset artifacts belong outside source control. The provider
can load the result as a sidecar keyed by directed edge ID and return the
allowlisted `city`, `osm`, and classification fields already understood by the
Worker. Direct binary-tile customization can replace the sidecar later without
changing the normalized route response or planner UI.

## Verify before staging installation

The builder writes to a same-directory temporary file and renames it only once
the full JSON artifact is ready. Before installing a refresh on the staging
provider, rebuild and verify against the exact City and directed-edge inputs:

```bash
npm run routing:verify-enrichment -- \
  --enrichment /path/to/austin-routing-enrichment.json \
  --city /path/to/austin-bike-facilities.geojson \
  --routing-edges /path/to/austin-directed-edges.geojson \
  --expected-city-dataset-version austin-bike-facilities-v1 \
  --expected-osm-extract-checksum md5:49344e78933b3eab0a84454f0d15d877 \
  --expected-routing-graph-version 1785883953 \
  --expected-valhalla-image ghcr.io/valhalla/valhalla-scripted:3.7.0@sha256:0a58e6f4d167437e0ec0fffa2cbf63582652c7d12bcbc895e581f3c86b7de6a4
```

The verifier checks both input SHA-256 values, requested manifest pins, and a
complete deterministic rebuild, including every edge and summary count. A
failure means the artifact must not be installed. The Valhalla host sidecar
loader remains a separate provider-integration step; this command makes the
artifact it will consume safe to promote.
