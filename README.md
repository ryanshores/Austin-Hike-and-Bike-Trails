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
values belong in deployment configuration, not source control. When the routing
provider is protected by Cloudflare Access, also configure the encrypted
`ROUTING_ACCESS_CLIENT_ID` and `ROUTING_ACCESS_CLIENT_SECRET` secrets. Both
must be present or the route and routing-health endpoints fail closed. Production
binds Cloudflare rate limiters as `GEOCODE_RATE_LIMITER` (30 requests/minute)
and `ROUTE_RATE_LIMITER` (15 requests/minute). Preview uses separate
namespaces so it cannot consume production capacity. The handlers enforce an
Austin-area service boundary, cap route distance and request sizes, and never
expose an upstream URL or credentials to the browser. These limits are a
protective backstop rather than precise quota accounting: Cloudflare applies
them locally and eventually consistently, and normal route or geocoder error
responses remain recoverable.

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

The deterministic offline edge-manifest workflow is documented in
[`docs/routing-enrichment.md`](docs/routing-enrichment.md). It preserves
ordinary bicycle-legal streets as fallback routes while treating City matches
as authoritative only when coverage is unambiguous. When the private SQLite
sidecar has a validated installed artifact, configure its non-secret
`ROUTING_ENRICHMENT_URL` plus encrypted
`ROUTING_ENRICHMENT_ACCESS_CLIENT_ID` and
`ROUTING_ENRICHMENT_ACCESS_CLIENT_SECRET` values. Set
`ROUTING_ENRICHMENT_ENABLED=true` only after the sidecar's Access boundary and
health check have been verified; missing or invalid records remain unknown.

Each `/api/routes` request also emits one structured Workers Log event with
`event: "route_request"`, an outcome, HTTP status, rounded handler duration,
and (after validation) the selected safety preference. These metrics
intentionally exclude endpoints, route geometry, provider URLs, and credentials.
Use Workers Logs or a Logpush destination to monitor success, no-route,
rate-limited, and provider-unavailable outcomes.

The selected safety preference also tunes Valhalla bicycle `use_roads` from a
balanced value down to zero for the strictest preference. Valhalla treats that
as avoidance rather than a prohibition, so regular bicycle-legal streets can
still complete a route when facility coverage is incomplete.
## Route history authentication

The Worker exposes same-origin endpoints under `/api/auth/` for anonymous
identity bootstrap, registration, login, token refresh, logout, and the current
user. Authentication fails closed until all of these deployment bindings are
available:

- D1 database binding: `DB`
- Worker secret: `JWT_SECRET` (at least 32 characters)
- Worker secret: `PASSWORD_PEPPER` (at least 32 characters)

Keep both secrets in the deployment control plane; never commit them or place
them in public environment variables. Apply the checked-in Drizzle migrations
to the bound D1 database before enabling the endpoints. The same database
stores short-lived, peppered per-IP auth rate-limit counters so limits apply
across Worker isolates.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run build
npm run dev
```

## Cloudflare Workers configuration

`wrangler.jsonc` is the source of truth for the `austin-trails` Worker and its
D1 `DB` binding. It deliberately uses `keep_vars: true` while provider URLs
and secrets are managed in the Cloudflare dashboard, so a deploy does not
remove dashboard-managed values.

Add production values in **Workers & Pages → austin-trails → Settings →
Variables and Secrets**:

- plaintext variables: `GEOCODER_URL`, `ROUTING_URL`
- encrypted secrets: `JWT_SECRET`, `PASSWORD_PEPPER`,
  `ROUTING_ACCESS_CLIENT_ID`, `ROUTING_ACCESS_CLIENT_SECRET`,
  `GEOCODER_ACCESS_CLIENT_ID`, `GEOCODER_ACCESS_CLIENT_SECRET` (when the
  corresponding provider uses Cloudflare Access)

`DB` is a D1 binding, not an environment variable. The configured database is
named `database`; apply its checked-in migrations before enabling auth:

```bash
npm run db:migrate:remote
```

Pull-request previews use the isolated `austin-trails-preview` database. Apply
the same migrations there before enabling preview auth or ride-history testing:

```bash
npm run db:migrate:preview
```

For local development, copy `.dev.vars.example` to `.dev.vars` and provide
local-only secret values. Leave provider URLs unset until their services are
available. Local D1 simulation is the default; do not point ordinary local
development at the production database.

Before a production release, run:

```bash
npm run lint
npm test
npm run check:worker
```

Use `npm run deploy` only for an explicit production release from `main`.
The command refuses to deploy from any other branch. For a preview upload, use
`CLOUDFLARE_ENV=preview npm run build` followed by
`npx wrangler versions upload --env preview`.

## Contributing

Use one short-lived branch and one pull request per feature. Pull requests run
lint, build, and test checks and are reviewed using the rules in `AGENTS.md`.
See [Development and Review Workflow](docs/development-workflow.md) for branch,
review, staging, and pull-request preview details.

## Useful Commands

- `npm run dev`: start local development
- `npm test`: build the app and run the route and GPS policy tests
- `npm run check:worker`: build and validate the generated Worker configuration
- `npm run check:preview-worker`: validate the isolated preview Worker configuration
- `npm run build:preview`: build with the isolated preview environment
- `npm run db:generate`: generate Drizzle migrations after schema changes
- `npm run db:migrate:preview`: apply migrations to the isolated preview D1 database
- `npm run db:migrate:remote`: apply checked-in migrations to the configured D1 database
