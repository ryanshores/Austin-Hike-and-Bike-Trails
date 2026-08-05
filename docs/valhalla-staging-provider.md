# Private staging Valhalla provider

Issue #26 keeps the initial routing provider within Cloudflare's free offerings
without using Cloudflare Containers. Native Valhalla runs on a persistent
macOS or Linux host; Cloudflare Tunnel and Cloudflare Access provide the
staging-only ingress and service authentication. The Atlas Worker remains the
only browser-facing routing API.

This is not production hosting. The routing host must remain online, and no
provider hostname should be added to production configuration.

## Build and run the Austin graph

The following commands use Apple Container on macOS. Docker or a native
Valhalla install is also acceptable if it keeps the same properties: a pinned
image/version, persistent graph files, and localhost-only service binding.

```bash
mkdir -p /private/tmp/atlas-valhalla/custom_files
curl -fL \
  --output /private/tmp/atlas-valhalla/custom_files/Austin.osm.pbf \
  https://download.bbbike.org/osm/bbbike/Austin/Austin.osm.pbf

container system start
container run -d --name atlas-valhalla --cpus 6 --memory 12g \
  -p 127.0.0.1:8002:8002 \
  -v /private/tmp/atlas-valhalla/custom_files:/custom_files \
  -e build_elevation=True -e build_admins=True -e build_time_zones=True \
  -e build_tar=True -e server_threads=6 \
  ghcr.io/valhalla/valhalla-scripted:3.7.0@sha256:0a58e6f4d167437e0ec0fffa2cbf63582652c7d12bcbc895e581f3c86b7de6a4

curl --fail http://127.0.0.1:8002/status
```

The first start builds graph artifacts in `custom_files`; later starts reuse
them. Record the OSM extract checksum and the `/status` graph version whenever
the extract or image changes. The feasibility artifact format is documented in
[`city-osm-conflation-spike.md`](city-osm-conflation-spike.md).

The `127.0.0.1` binding is intentional. Do not bind Valhalla directly to a LAN
or public interface.

## Publish only through Tunnel and Access

1. In Cloudflare Zero Trust, create a remotely managed Tunnel on the routing
   host. Run the dashboard-provided `cloudflared` connector command as a
   persistent service; keep its token outside this repository.
2. Add an ingress public hostname such as
   `routing-staging.<your-zone>` whose origin service is
   `http://127.0.0.1:8002`. This hostname must be a Tunnel hostname, not a
   Worker route or custom domain; otherwise the Worker can call itself in a
   loop.
3. Create a Cloudflare Access self-hosted application for that exact hostname.
   The default policy must deny requests. Add a service-token policy for the
   Atlas Worker and create a dedicated service token.
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
the API returns a 503 without sending a provider request.

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
