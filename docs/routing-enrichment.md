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

After each graph build, run `scripts/verify-valhalla-host.sh` on the provider
host. In addition to route and elevation checks, it sends that exact route
shape through Valhalla's `trace_attributes` action with `edge_walk` and
requires a stable graph edge `id`, route-edge length, and (where available) OSM
`way_id`. This proves the installed provider exposes the identifiers required
by the directed-edge export and sidecar.

The verification gate does **not** export every graph edge or load an artifact.
Those remain separate staging integration steps: the exporter must use the
same pinned graph and directed graph IDs, and the sidecar loader must reject a
manifest whose graph version does not match the running host.

## Export directed City-facility edges

The initial exporter deliberately avoids Valhalla's private binary-tile format.
It densifies every City facility line at 20 m, traces each bounded shape against
the host's exact graph with `trace_attributes`, and writes the returned directed
IDs, geometry, OSM way IDs, and direction as GeoJSON. It checks `/status`
before any trace request and rejects a changed graph version. This covers the
City-authoritative facilities; graph edges outside that export remain unknown
until a future full OSM-tag export is available, so they cannot receive an
unearned safety promotion.

First create a complete City snapshot. This uses the same ordered, paginated
ArcGIS query as the Worker, but takes a deliberate full-Austin envelope rather
than a browser viewport. Save the generated file with the artifact evidence;
it is generated data and must not be committed.

```bash
npm run routing:export-city-facilities -- \
  --bounds -98.10,30.05,-97.55,30.55 \
  --output /path/to/austin-bike-facilities.geojson
```

Run it from the offline build machine after recording the current `/status`
graph version. The Linux provider image intentionally does not include Node;
when the build machine is remote from the host, use a temporary SSH loopback
tunnel and keep Valhalla private:

```bash
ssh -N -L 127.0.0.1:18002:127.0.0.1:8002 ryan-mini
```

Then, in another terminal, run:

```bash
npm run routing:export-directed-edges -- \
  --city /path/to/austin-bike-facilities.geojson \
  --routing-url http://127.0.0.1:18002 \
  --routing-graph-version 1786234669 \
  --concurrency 2 \
  --output /path/to/austin-directed-edges.geojson
```

The output is one record per exact directed graph ID. Re-run the command after
every graph rebuild; never reuse an export whose graph version differs from the
sidecar artifact manifest. Keep concurrency at or below the host's Valhalla
server thread count; the default is four and the exporter caps it at eight.
The command reports untraced City shapes by HTTP/error code. Those shapes are
intentionally omitted rather than guessed; their routes stay unknown until the
underlying graph or City geometry is repaired. When `edge_walk` cannot connect
a short City shape, the exporter uses Valhalla's `walk_or_snap` fallback but
stores the fallback response's returned geometry—not the City input geometry—so
the later 25 m spatial join can reject a distant snap.

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

Generated full-dataset artifacts belong outside source control. The initial
free-tier provider loads them into a graph-versioned SQLite sidecar co-hosted
with Valhalla. At request time, the Worker asks Valhalla's
`trace_attributes` endpoint for the exact graph IDs of a returned route, then
joins only those IDs against the sidecar. A record is valid only for the
provider's reported routing-graph version. Missing, malformed, or unavailable
sidecar data stays unknown instead of promoting a route section; an artifact
record with no City match still retains its OSM fallback classification.
Direct binary-tile customization can replace this sidecar later without
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

## SQLite sidecar build and host contract

Build the JSON artifact with the command above, then load it atomically on the
private Valhalla host:

```bash
python3 scripts/build-routing-enrichment-sqlite.py \
  --artifact /path/to/austin-routing-enrichment.json \
  --output /srv/atlas-valhalla/custom_files/routing-enrichment.sqlite
```

The loader accepts only schema version 1 artifacts built with the recorded
25 m tolerance, 20 m sample spacing, and 80% City-coverage threshold. It
validates every graph version, edge ID, City-match result, OSM tag object, and
classification before atomically replacing the database. It stores the source
artifact SHA-256 and keeps `routing_graph_version, edge_id` as the primary key.

The co-hosted service is `POST /v1/lookup` with this intentionally narrow
request contract:

```json
{
  "routingGraphVersion": "1786234669",
  "edgeIds": ["exact-valhalla-edge-id"]
}
```

It returns records only for the requested graph version and exact IDs, limits a
request to 500 IDs and 64 KiB, and returns no row for unknown or malformed
data. It is bound only to host `127.0.0.1:8003`; the Worker client keeps
missing rows unknown. Do not expose it on the LAN or directly to the browser.
