# Private Austin geocoder

Atlas submits place searches only through `GET /api/geocode`. A self-hosted,
Austin-only Nominatim instance supplies that endpoint behind Cloudflare Tunnel
and Access; browsers never receive its hostname or service token.

This provider copies and checks the verified `Austin.osm.pbf` held by the
Valhalla host, because the Nominatim image takes ownership of its import
directory. It deliberately has no replication feed and freezes its database
after import.
Refresh the extract as an explicit maintenance operation, after confirming the
host has enough free disk for a fresh import.

## Host setup

The target is the existing Linux host. Nominatim stores its PostgreSQL database
and its checked extract copy outside the repository:

```bash
sudo install -d -o "$USER" -g "$USER" /home/ryan/services/atlas-nominatim/postgres
cp infra/nominatim/host.env.example /home/ryan/services/atlas-nominatim/host.env
# Replace NOMINATIM_PASSWORD with a long random value in the ignored host.env.

scripts/prepare-nominatim-host.sh \
  /home/ryan/services/atlas-nominatim/postgres \
  /home/ryan/services/atlas-valhalla/custom_files

docker compose \
  --env-file /home/ryan/services/atlas-nominatim/host.env \
  --file infra/nominatim/compose.yaml \
  up --detach
```

The host currently has a conservative 8 GiB RAM budget, so the stack defaults
to two import threads, a 5 GiB container limit, and limited PostgreSQL memory.
The preflight refuses to begin with less than 20 GiB free. The initial import
can take hours; inspect it without restarting the container:

```bash
docker compose \
  --env-file /home/ryan/services/atlas-nominatim/host.env \
  --file infra/nominatim/compose.yaml \
  logs --follow nominatim
```

After import, verify local-only binding plus a real Austin query:

```bash
scripts/verify-nominatim-host.sh
```

Nominatim is intentionally bound only to `127.0.0.1:8082`. Do not publish its
port on the LAN or Internet.

## Tunnel and Access

Add two routes to the existing remotely managed Tunnel, both pointing to
`http://127.0.0.1:8082`:

- `geocoding-staging.ryanshores.us` for preview
- `geocoding.ryanshores.us` for production

Create a separate Cloudflare Access self-hosted application and service token
for each hostname. Each app needs a `Service Auth` policy containing only its
environment's token. Before configuring Workers, confirm an unauthenticated
request to either hostname returns HTTP 403.

## Worker configuration

`wrangler.jsonc` holds only the public-to-Worker provider URLs:

- production: `GEOCODER_URL=https://geocoding.ryanshores.us`
- preview: `GEOCODER_URL=https://geocoding-staging.ryanshores.us`

Set the matching encrypted Worker secrets in the Cloudflare dashboard:

- `GEOCODER_ACCESS_CLIENT_ID`
- `GEOCODER_ACCESS_CLIENT_SECRET`

The Worker adds those headers only on its server-side geocoder request. A
partial credential pair fails closed with HTTP 503, and redirects are rejected
so credentials cannot be forwarded elsewhere.

Verify each environment through Atlas rather than directly through the
provider:

```bash
curl --fail 'https://<atlas-preview-host>/api/geocode?q=Austin%20Central%20Library'
curl --fail 'https://<atlas-production-host>/api/geocode?q=Austin%20Central%20Library'
```

Successful responses contain Austin-bounded results and OSM attribution. In
browser developer tools, confirm clients call only `/api/geocode` and never a
`geocoding*.ryanshores.us` hostname.
