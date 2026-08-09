import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composePath = new URL("../infra/valhalla/compose.yaml", import.meta.url);
const preparePath = new URL("../scripts/prepare-valhalla-extract.sh", import.meta.url);

test("Valhalla compose configuration pins the image and exposes only localhost", async () => {
  const compose = await readFile(composePath, "utf8");

  assert.match(compose, /valhalla-scripted:3\.7\.0@sha256:[0-9a-f]{64}/);
  assert.match(compose, /VALHALLA_PLATFORM:-linux\/amd64/);
  assert.match(compose, /127\.0\.0\.1:8002:8002/);
  assert.doesNotMatch(compose, /^\s+-\s+["']?8002:8002/m);
  assert.match(compose, /VALHALLA_DATA_DIR/);
  assert.match(compose, /cloudflare\/cloudflared:latest@sha256:[0-9a-f]{64}/);
  assert.match(compose, /network_mode: host/);
  assert.match(compose, /TUNNEL_TOKEN:\?set TUNNEL_TOKEN outside the repository/);
  assert.doesNotMatch(compose, /eyJhIjoi/);
});

test("Austin extract preparation requires and verifies a pinned checksum", async () => {
  const prepare = await readFile(preparePath, "utf8");

  assert.match(prepare, /EXPECTED_MD5/);
  assert.match(prepare, /md5sum/);
  assert.match(prepare, /checksum mismatch/);
  assert.match(prepare, /Austin\.osm\.pbf\.provenance/);
});
