import assert from "node:assert/strict";
import test from "node:test";

import {
  BIKE_CACHE_DATASET_VERSION,
  BIKE_CACHE_TTL_SECONDS,
  BIKE_PAGE_SIZE,
  bikeCacheKey,
  createBikeFacilitiesHandler,
  quantizeBounds,
} from "../worker/bike-facilities.js";

function feature(id) {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [[-97.75, 30.25], [-97.74, 30.26]] },
    properties: { OBJECTID: id, BICYCLE_FACILITY: "Bike Lane" },
  };
}

function page(features, exceededTransferLimit = false) {
  return {
    type: "FeatureCollection",
    features,
    properties: { exceededTransferLimit },
  };
}

function memoryCache() {
  const entries = new Map();
  let puts = 0;
  return {
    get puts() {
      return puts;
    },
    async match(request) {
      return entries.get(request.url)?.clone();
    },
    async put(request, response) {
      puts += 1;
      entries.set(request.url, response.clone());
    },
  };
}

test("quantizes outward into stable viewport buckets", () => {
  const first = quantizeBounds({ west: -97.756, south: 30.241, east: -97.731, north: 30.278 });
  const nearby = quantizeBounds({ west: -97.759, south: 30.249, east: -97.732, north: 30.271 });

  assert.deepEqual(first, { west: -97.76, south: 30.24, east: -97.73, north: 30.28 });
  assert.deepEqual(nearby, first);
});

test("cache keys include quantized bounds and the dataset version", () => {
  const bounds = { west: -97.76, south: 30.24, east: -97.73, north: 30.28 };
  const key = new URL(bikeCacheKey("https://trails.example/api/bike-facilities", bounds));

  assert.equal(key.pathname, "/__edge-cache/bike-facilities");
  assert.equal(key.searchParams.get("dataset"), BIKE_CACHE_DATASET_VERSION);
  assert.equal(key.searchParams.get("bounds"), "-97.760000,30.240000,-97.730000,30.280000");
  assert.notEqual(
    bikeCacheKey("https://trails.example/api/bike-facilities", bounds),
    bikeCacheKey("https://trails.example/api/bike-facilities", { ...bounds, east: -97.72 }),
  );
});

test("paginates ArcGIS results and caches only the complete collection", async () => {
  const cache = memoryCache();
  const requests = [];
  const firstPage = Array.from({ length: BIKE_PAGE_SIZE }, (_, index) => feature(index + 1));
  const fetchImpl = async (url) => {
    requests.push(new URL(url));
    return Response.json(requests.length === 1 ? page(firstPage, true) : page([feature(2001)]));
  };
  const handle = createBikeFacilitiesHandler({ cache, fetchImpl });
  const requestUrl = "https://trails.example/api/bike-facilities?bounds=-97.756,30.241,-97.731,30.278";

  const miss = await handle(new Request(requestUrl));
  assert.equal(miss.status, 200);
  assert.equal(miss.headers.get("x-cache-status"), "MISS");
  assert.equal(miss.headers.get("cache-control"), `public, max-age=${BIKE_CACHE_TTL_SECONDS}`);
  assert.match(miss.headers.get("server-timing"), /arcgis;dur=/);
  assert.equal((await miss.json()).features.length, 2001);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].searchParams.get("resultOffset"), "0");
  assert.equal(requests[1].searchParams.get("resultOffset"), String(BIKE_PAGE_SIZE));
  assert.equal(requests[0].searchParams.get("geometry"), "-97.760000,30.240000,-97.730000,30.280000");
  assert.equal(cache.puts, 1);

  const hit = await handle(new Request(requestUrl));
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get("x-cache-status"), "HIT");
  assert.match(hit.headers.get("server-timing"), /cache;desc="HIT"/);
  assert.equal((await hit.json()).features.length, 2001);
  assert.equal(requests.length, 2);
});

test("does not cache failed or invalid ArcGIS responses", async () => {
  for (const fetchImpl of [
    async () => new Response("unavailable", { status: 503 }),
    async () => Response.json({ error: "not GeoJSON" }),
  ]) {
    const cache = memoryCache();
    const handle = createBikeFacilitiesHandler({ cache, fetchImpl });
    const response = await handle(
      new Request("https://trails.example/api/bike-facilities?bounds=-97.8,30.2,-97.7,30.3"),
    );

    assert.equal(response.status, 502);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-cache-status"), "BYPASS");
    assert.equal(cache.puts, 0);
  }
});

test("rejects missing, malformed, and unbounded viewport queries", async () => {
  let fetches = 0;
  const handle = createBikeFacilitiesHandler({
    fetchImpl: async () => {
      fetches += 1;
      return Response.json(page([]));
    },
  });

  for (const suffix of ["", "?bounds=oops", "?bounds=-100,20,-90,30"]) {
    const response = await handle(new Request(`https://trails.example/api/bike-facilities${suffix}`));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(fetches, 0);
});
