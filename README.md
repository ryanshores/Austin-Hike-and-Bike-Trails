# Austin Hike & Bike Atlas

A responsive Austin trail atlas with a desktop planning map and a dedicated
full-screen ride experience.

## Bicycle facility edge cache

The browser requests bicycle facilities from the same-origin
`/api/bike-facilities` Worker endpoint. The endpoint expands viewport bounds
outward to deterministic 0.01-degree buckets, retrieves every ArcGIS result
page, and stores only complete successful GeoJSON responses in Cloudflare's
Cache API for five minutes.

Cache keys include the bucketed bounds and the
`austin-bike-facilities-v1` dataset/schema version. Increment that version in
`worker/bike-facilities.js` whenever the upstream dataset interpretation,
selected fields, or normalized response schema changes. This invalidates old
entries without requiring a cache purge.

Failed or invalid upstream responses are never cached, and stale entries are
not served after their TTL. A request with no usable cached response receives a
`502` when ArcGIS is unavailable.

Inspect `X-Cache-Status` and `Server-Timing` to compare a cold request with a
warm request:

```bash
curl -i 'https://YOUR_PREVIEW_HOST/api/bike-facilities?bounds=-97.78,30.24,-97.70,30.31'
curl -i 'https://YOUR_PREVIEW_HOST/api/bike-facilities?bounds=-97.78,30.24,-97.70,30.31'
```

The first response should report `X-Cache-Status: MISS`; the repeated request
should report `HIT`. Cache API entries consume normal Cloudflare cache storage
and request operations—no KV or D1 resources are provisioned by this feature.

## Route and geocoding API configuration

Route planning providers stay behind same-origin Worker endpoints:

- `GET /api/geocode?q=…&limit=…`
- `POST /api/routes`
- `GET /api/routing-health`

Set `GEOCODER_URL` to the base URL of a Nominatim-compatible geocoder and
`ROUTING_URL` to the base URL of a Valhalla-compatible routing service. These
values belong in deployment configuration, not source control. Production
should also bind Cloudflare rate limiters as `GEOCODE_RATE_LIMITER` and
`ROUTE_RATE_LIMITER`. The handlers fail closed when a provider is absent,
enforce an Austin-area service boundary, cap route distance and request sizes,
and never expose an upstream URL to the browser.

Geocoding is a submitted-search flow, not autocomplete. Successful bounded
results are cached for 24 hours. If the public OpenStreetMap Nominatim service
is deliberately selected for a small deployment, its usage policy requires a
maximum of one request per second for the whole application, identifying
requests, attribution, and caching. A self-hosted or contracted provider is
required when traffic outgrows those terms.

Stock Valhalla provides route geometry, maneuvers, and elevation, but not the
City/OSM edge enrichment needed for an Atlas safety claim. Such routes are
conservatively classified as `unknown`; a strict safety preference therefore
shows the route as a divergence. A routing provider may return enriched
`candidates[].edges[]` with City fields and OSM tags, which the Worker passes
through the standalone route-safety classifier before ranking candidates.
Client-visible responses are allowlisted and omit ETA, duration, arrival time,
and speed-derived wording.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

This starter does not use `wrangler.jsonc`.

## Release targets

This repository uses two branches and two independent Sites projects:

- `main` targets the public production site.
- `staging` targets the private staging site.

Project IDs are stored only in the repository's local Git configuration. They
are not committed. The configured checkout hook generates the ignored
`.openai/hosting.json` file whenever branches change.

Before publishing, commit the intended code and run:

```bash
npm test
sh scripts/prepare-site-deployment.sh
```

## Contributing

Use one short-lived branch and one pull request per feature. Pull requests run
lint, build, and test checks and are reviewed using the rules in `AGENTS.md`.
See [Development and Review Workflow](docs/development-workflow.md) for branch,
review, staging, and pull-request preview details.

## Useful Commands

- `npm run dev`: start local development
- `npm test`: build the app and run the route and GPS policy tests
- `npm run db:generate`: generate Drizzle migrations after schema changes
