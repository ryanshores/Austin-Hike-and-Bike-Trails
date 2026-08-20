import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composePath = new URL("../infra/valhalla/compose.yaml", import.meta.url);
const preparePath = new URL("../scripts/prepare-valhalla-extract.sh", import.meta.url);
const wranglerPath = new URL("../wrangler.jsonc", import.meta.url);

test("Valhalla compose configuration pins the image and exposes only localhost", async () => {
  const compose = await readFile(composePath, "utf8");

  assert.match(compose, /valhalla-scripted:3\.7\.0@sha256:[0-9a-f]{64}/);
  assert.match(compose, /VALHALLA_PLATFORM:-linux\/amd64/);
  assert.match(compose, /127\.0\.0\.1:8002:8002/);
  assert.doesNotMatch(compose, /^\s+-\s+["']?8002:8002/m);
  assert.match(compose, /VALHALLA_DATA_DIR/);
  assert.match(compose, /atlas-routing-enrichment/);
  assert.match(compose, /entrypoint: \["python3", "\/sidecar\/routing_enrichment_server\.py"\]/);
  assert.match(compose, /127\.0\.0\.1:8003:8003/);
  assert.doesNotMatch(compose, /^\s+-\s+["']?8003:8003/m);
  assert.match(compose, /\/custom_files:ro/);
  assert.match(compose, /routing_enrichment_server\.py:ro/);
  assert.match(compose, /cloudflare\/cloudflared:latest@sha256:[0-9a-f]{64}/);
  assert.match(compose, /network_mode: host/);
  assert.match(compose, /TUNNEL_TOKEN:\?set TUNNEL_TOKEN outside the repository/);
  assert.doesNotMatch(compose, /eyJhIjoi/);
});

test("host verification fails if either private routing port is publicly exposed", async () => {
  const verifier = await readFile(new URL("../scripts/verify-valhalla-host.sh", import.meta.url), "utf8");

  assert.match(verifier, /127\\\.0\\\.0\\\.1:8002\|127\\\.0\\\.0\\\.1:8003/);
  assert.match(verifier, /\(8002\|8003\)/);
  assert.match(verifier, /ROUTING_ENRICHMENT_URL/);
  assert.match(verifier, /VERIFY_ROUTING_ENRICHMENT:-false/);
  assert.match(verifier, /\[\[ "\$verify_routing_enrichment" == "true" \]\]/);
  assert.match(verifier, /\$enrichment_url\/health/);
});

test("Austin extract preparation requires and verifies a pinned checksum", async () => {
  const prepare = await readFile(preparePath, "utf8");

  assert.match(prepare, /EXPECTED_MD5/);
  assert.match(prepare, /md5sum/);
  assert.match(prepare, /checksum mismatch/);
  assert.match(prepare, /Austin\.osm\.pbf\.provenance/);
});

test("host verification requires route edge attribution with stable graph IDs", async () => {
  const verify = await readFile(new URL("../scripts/verify-valhalla-host.sh", import.meta.url), "utf8");

  assert.match(verify, /\/trace_attributes/);
  assert.match(verify, /"shape_match": "edge_walk"/);
  assert.match(verify, /"edge\.id"/);
  assert.match(verify, /"edge\.way_id"/);
  assert.match(verify, /stable graph ID/);
  assert.match(verify, /Route edge attribution/);
});

test("production and preview Workers use distinct non-secret provider and enrichment URLs", async () => {
  const wrangler = await readFile(wranglerPath, "utf8");

  assert.match(wrangler, /ROUTING_URL"\s*:\s*"https:\/\/routing\.ryanshores\.us"/);
  assert.match(
    wrangler,
    /ROUTING_URL"\s*:\s*"https:\/\/routing-staging\.ryanshores\.us"/,
  );
  assert.match(
    wrangler,
    /ROUTING_ENRICHMENT_URL"\s*:\s*"https:\/\/routing-enrichment\.ryanshores\.us"/,
  );
  assert.match(
    wrangler,
    /ROUTING_ENRICHMENT_URL"\s*:\s*"https:\/\/routing-enrichment-staging\.ryanshores\.us"/,
  );
  assert.doesNotMatch(wrangler, /ROUTING_ACCESS_CLIENT_(ID|SECRET)"\s*:/);
  assert.doesNotMatch(wrangler, /ROUTING_ENRICHMENT_ACCESS_CLIENT_(ID|SECRET)"\s*:/);
});
