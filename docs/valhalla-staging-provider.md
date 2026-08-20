# Private Valhalla provider

Issue #26 keeps the initial routing provider within Cloudflare's free offerings
without using Cloudflare Containers. Native Valhalla runs on a persistent
macOS or Linux host; Cloudflare Tunnel and Cloudflare Access provide separate
staging and production ingress with service authentication. The Atlas Worker
remains the only browser-facing routing API.

Both environments currently depend on the same self-hosted graph and physical
host. This is suitable for the initial production rollout but is not highly
available: routing becomes unavailable whenever the host, home connection, or
Tunnel is offline. The Atlas application must continue to fail closed without
falling back to a public provider endpoint.

## Build and run the Austin graph on Linux

The checked-in Compose service uses the pinned multi-architecture Valhalla
image and explicitly selects AMD64 for the Linux host. It persists graph files
outside the repository and publishes port 8002 only on localhost. The default
two build threads are intentionally conservative for an 8 GiB host.
Do not increase the count until the initial graph build succeeds while memory
pressure is monitored.

```bash
sudo install -d -o "$USER" -g "$USER" /srv/atlas-valhalla/custom_files
cp infra/valhalla/host.env.example infra/valhalla/host.env

# Copy the current Austin.osm.pbf MD5 from BBBike's CHECKSUM.txt. The script
# refuses a changed extract instead of silently building a different graph.
scripts/prepare-valhalla-extract.sh \
  /srv/atlas-valhalla/custom_files \
  EXPECTED_32_CHARACTER_MD5

docker compose \
  --env-file infra/valhalla/host.env \
  --file infra/valhalla/compose.yaml \
  up --detach
docker compose \
  --env-file infra/valhalla/host.env \
  --file infra/valhalla/compose.yaml \
  logs --follow valhalla
scripts/verify-valhalla-host.sh
```

The source checksum is deliberately supplied at deployment time because
BBBike's stable URL is updated in place. Keep the generated provenance file
beside the graph. The first start builds graph and elevation artifacts; later
starts reuse them. Record the `/status` graph version whenever the extract or
image changes. The verification script also confirms a routed shape returns
stable Valhalla graph edge IDs through `trace_attributes`; keep that output
with the graph build evidence before producing a City enrichment sidecar. The
feasibility artifact format is documented in
[`city-osm-conflation-spike.md`](city-osm-conflation-spike.md).

The `127.0.0.1` binding is intentional. Do not bind Valhalla directly to a LAN
or public interface.

## Load and expose the routing-enrichment sidecar

The same Compose file runs `atlas-routing-enrichment` from the pinned Valhalla
image's Python 3 runtime. It reads only
`/srv/atlas-valhalla/custom_files/routing-enrichment.sqlite`, binds host port
8003 to `127.0.0.1`, and has no browser-facing route. Build the SQLite file
offline with `scripts/build-routing-enrichment-sqlite.py` as documented in
[`routing-enrichment.md`](routing-enrichment.md), then bring the service up:

```bash
docker compose \
  --env-file infra/valhalla/host.env \
  --file infra/valhalla/compose.yaml \
  up --detach routing-enrichment

# Run this additional check only after routing-enrichment.sqlite is installed.
VERIFY_ROUTING_ENRICHMENT=true scripts/verify-valhalla-host.sh
```

Create separate Tunnel hostnames and separate Cloudflare Access applications
and service tokens for the sidecar, for example
`routing-enrichment-staging.<your-zone>` and
`routing-enrichment.<your-zone>`, each forwarding to
`http://127.0.0.1:8003`. Do not reuse either Valhalla service token or the
provider hostname. Before enabling the Worker client, verify anonymous
requests to both sidecar hostnames receive Access denial and
`http://127.0.0.1:8003/health` is healthy on the host.

## Publish only through Tunnel and Access

1. In Cloudflare Zero Trust, create a remotely managed Tunnel on the routing
   host. Put its token in the ignored `infra/valhalla/host.env` file. The
   Compose service runs the digest-pinned connector with host networking so its
   `127.0.0.1:8002` origin is the host's localhost. Keep the token outside this
   repository. If the host already has a `cloudflared` service, add this route
   to that Tunnel instead of starting a second connector.
2. Add two published application routes to `http://127.0.0.1:8002`:
   `routing-staging.<your-zone>` for previews and `routing.<your-zone>` for
   production. These must be Tunnel hostnames, not Worker routes or custom
   domains; otherwise a Worker can call itself in a loop.
3. Create a separate Cloudflare Access self-hosted application and dedicated
   service token for each hostname. Each application must have a `Service Auth`
   policy that includes only its environment's token. Requests not matching a
   service-auth policy are denied by default. Never reuse the preview token in
   production.
4. Before configuring either Worker, confirm requests to both provider
   hostnames without their service-token headers are rejected by Access.

## Configure the Worker

The non-secret provider URLs are committed in `wrangler.jsonc`:

- production: `ROUTING_URL=https://routing.ryanshores.us`
- preview: `ROUTING_URL=https://routing-staging.ryanshores.us`
- production: `ROUTING_ENRICHMENT_URL=https://routing-enrichment.ryanshores.us`
- preview: `ROUTING_ENRICHMENT_URL=https://routing-enrichment-staging.ryanshores.us`

Set the following as encrypted secrets on each Worker, using its dedicated
Access token:

- `ROUTING_ACCESS_CLIENT_ID` as an encrypted secret.
- `ROUTING_ACCESS_CLIENT_SECRET` as an encrypted secret.

For the SQLite sidecar, configure the environment-specific non-secret
`ROUTING_ENRICHMENT_URL` and a distinct encrypted Access pair:

- `ROUTING_ENRICHMENT_ACCESS_CLIENT_ID`
- `ROUTING_ENRICHMENT_ACCESS_CLIENT_SECRET`

The sidecar is disabled by default. Set
`ROUTING_ENRICHMENT_ENABLED=true` only after the matching SQLite artifact is
installed and the sidecar's Tunnel and Access policy have been verified. The
Worker requests only exact graph-versioned edge IDs; missing, mismatched, or
unavailable sidecar data remains unknown rather than making a route safer.

Never commit the service token, put it in a browser variable, or add it to a
preview URL. The Worker adds the two Cloudflare Access headers to its server-
side `/route`, `/height`, and `/status` requests. If only one secret is set,
the API returns a 503 without sending a provider request. Provider redirects
are rejected rather than followed, so service-token headers cannot be sent to
an unexpected origin.

## Environment verification

With all configuration present, verify both Atlas environments:

```bash
curl --fail https://<atlas-preview-host>/api/routing-health
curl --fail https://<atlas-production-host>/api/routing-health
```

Then run the same-origin Atlas acceptance probe and complete the browser/device
checklist in [`staging-route-field-tests.md`](staging-route-field-tests.md).
It verifies the normalized route contract (including elevation), while the
checklist covers input, mobile guidance, and browser network boundaries.

If the Tunnel, Access policy, or local host is unavailable, leave routing
disabled rather than bypassing Access or exposing the local Valhalla port.
