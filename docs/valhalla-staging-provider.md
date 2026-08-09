# Private staging Valhalla provider

Issue #26 keeps the initial routing provider within Cloudflare's free offerings
without using Cloudflare Containers. Native Valhalla runs on a persistent
macOS or Linux host; Cloudflare Tunnel and Cloudflare Access provide the
staging-only ingress and service authentication. The Atlas Worker remains the
only browser-facing routing API.

This is not production hosting. The routing host must remain online, and no
provider hostname should be added to production configuration.

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
image changes. The feasibility artifact format is documented in
[`city-osm-conflation-spike.md`](city-osm-conflation-spike.md).

The `127.0.0.1` binding is intentional. Do not bind Valhalla directly to a LAN
or public interface.

## Publish only through Tunnel and Access

1. In Cloudflare Zero Trust, create a remotely managed Tunnel on the routing
   host. Put its token in the ignored `infra/valhalla/host.env` file. The
   Compose service runs the digest-pinned connector with host networking so its
   `127.0.0.1:8002` origin is the host's localhost. Keep the token outside this
   repository. If the host already has a `cloudflared` service, add this route
   to that Tunnel instead of starting a second connector.
2. Add an ingress public hostname such as
   `routing-staging.<your-zone>` whose origin service is
   `http://127.0.0.1:8002`. This hostname must be a Tunnel hostname, not a
   Worker route or custom domain; otherwise the Worker can call itself in a
   loop.
3. Create a Cloudflare Access self-hosted application for that exact hostname.
   Add a `Service Auth` policy that includes only the dedicated Atlas Worker
   service token. Requests not matching an allow or service-auth policy are
   denied by default.
4. Before configuring the Worker, confirm a request to
   `https://routing-staging.<your-zone>/status` without the service-token
   headers is rejected by Access.

## Configure the Worker

In the staging Worker's Cloudflare dashboard variables, set:

- `ROUTING_URL=https://routing-staging.<your-zone>` as plaintext.
- `ROUTING_ACCESS_CLIENT_ID` as an encrypted secret.
- `ROUTING_ACCESS_CLIENT_SECRET` as an encrypted secret.

Never commit the service token, put it in a browser variable, or add it to a
preview URL. The Worker adds the two Cloudflare Access headers to its server-
side `/route`, `/height`, and `/status` requests. If only one secret is set,
the API returns a 503 without sending a provider request. Provider redirects
are rejected rather than followed, so service-token headers cannot be sent to
an unexpected origin.

## Staging verification

With all configuration present, verify from the Atlas preview hostname:

```bash
curl --fail https://<atlas-preview-host>/api/routing-health
```

Then submit an Austin-area route to `POST /api/routes` and verify that its
elevation profile is returned. Confirm in browser developer tools that clients
only call Atlas `/api/routes`; they must not call `routing-staging` directly.

If the Tunnel, Access policy, or local host is unavailable, leave routing
disabled rather than bypassing Access or exposing the local Valhalla port.
