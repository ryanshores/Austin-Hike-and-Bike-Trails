import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composePath = new URL("../infra/nominatim/compose.yaml", import.meta.url);
const preparePath = new URL("../scripts/prepare-nominatim-host.sh", import.meta.url);
const verifyPath = new URL("../scripts/verify-nominatim-host.sh", import.meta.url);
const wranglerPath = new URL("../wrangler.jsonc", import.meta.url);

test("Nominatim compose configuration pins the image and exposes only localhost", async () => {
  const compose = await readFile(composePath, "utf8");

  assert.match(compose, /mediagis\/nominatim:5\.3@sha256:[0-9a-f]{64}/);
  assert.match(compose, /NOMINATIM_PLATFORM:-linux\/amd64/);
  assert.match(compose, /127\.0\.0\.1:\$\{NOMINATIM_PORT:-8082\}:8080/);
  assert.doesNotMatch(compose, /^\s+-\s+["']?8082:8080/m);
  assert.match(compose, /NOMINATIM_DB_DIR/);
  assert.match(compose, /NOMINATIM_OSM_DIR/);
  assert.doesNotMatch(compose, /atlas-valhalla/);
  assert.match(compose, /PBF_PATH: \/nominatim\/data\/Austin\.osm\.pbf/);
  assert.match(compose, /UPDATE_MODE: none/);
  assert.match(compose, /FREEZE: "true"/);
  assert.doesNotMatch(compose, /NOMINATIM_PASSWORD=[^$]/);
});

test("Nominatim preparation has a disk guard and verification tests an Austin search", async () => {
  const [prepare, verify] = await Promise.all([
    readFile(preparePath, "utf8"),
    readFile(verifyPath, "utf8"),
  ]);

  assert.match(prepare, /20 GiB free/);
  assert.match(prepare, /Austin\.osm\.pbf\.provenance/);
  assert.match(prepare, /Nominatim extract copy differs/);
  assert.match(verify, /127\.0\.0\.1:8082/);
  assert.match(verify, /Austin Central Library/);
  assert.match(verify, /bounded/);
});

test("production and preview Workers use distinct non-secret geocoder URLs", async () => {
  const wrangler = await readFile(wranglerPath, "utf8");

  assert.match(wrangler, /GEOCODER_URL"\s*:\s*"https:\/\/geocoding\.ryanshores\.us"/);
  assert.match(
    wrangler,
    /GEOCODER_URL"\s*:\s*"https:\/\/geocoding-staging\.ryanshores\.us"/,
  );
  assert.doesNotMatch(wrangler, /GEOCODER_ACCESS_CLIENT_(ID|SECRET)"\s*:/);
});
