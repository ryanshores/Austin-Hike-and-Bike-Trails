import assert from "node:assert/strict";
import test from "node:test";

import {
  GEOCODE_CACHE_TTL_SECONDS,
  createGeocodeHandler,
} from "../worker/geocode.js";

function memoryCache() {
  const entries = new Map();
  return {
    get keys() {
      return [...entries.keys()];
    },
    async match(request) {
      return entries.get(request.url)?.clone();
    },
    async put(request, response) {
      entries.set(request.url, response.clone());
    },
  };
}

test("geocoding is Austin-bounded, normalized, cached, and provider-isolated", async () => {
  const cache = memoryCache();
  const upstreamRequests = [];
  const handle = createGeocodeHandler({
    providerUrl: "https://geocoder.internal",
    cache,
    fetchImpl: async (url, options) => {
      upstreamRequests.push({ url: new URL(url), options });
      return Response.json([
        {
          place_id: 42,
          display_name: "Central Library, Austin, Texas",
          lat: "30.265",
          lon: "-97.751",
          boundingbox: ["30.264", "30.266", "-97.752", "-97.750"],
          category: "amenity",
          type: "library",
        },
        {
          place_id: 99,
          display_name: "Dallas, Texas",
          lat: "32.7767",
          lon: "-96.7970",
        },
      ]);
    },
  });
  const request = new Request(
    "https://atlas.example/api/geocode?q=Central%20Library&limit=3",
  );

  const first = await handle(request);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-cache-status"), "MISS");
  assert.equal(
    first.headers.get("cache-control"),
    `public, max-age=${GEOCODE_CACHE_TTL_SECONDS}`,
  );
  const body = await first.json();
  assert.equal(body.results.length, 1);
  assert.deepEqual(body.results[0], {
    id: "42",
    label: "Central Library, Austin, Texas",
    latitude: 30.265,
    longitude: -97.751,
    bounds: { west: -97.752, south: 30.264, east: -97.75, north: 30.266 },
    category: "amenity",
    type: "library",
  });
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].url.origin, "https://geocoder.internal");
  assert.equal(upstreamRequests[0].url.pathname, "/search");
  assert.equal(upstreamRequests[0].url.searchParams.get("bounded"), "1");
  assert.equal(
    upstreamRequests[0].url.searchParams.get("viewbox"),
    "-98.35,30.85,-97.05,29.7",
  );
  assert.equal(upstreamRequests[0].url.searchParams.get("limit"), "3");
  assert.match(upstreamRequests[0].options.headers["User-Agent"], /Austin-Hike-Bike-Atlas/);
  assert.equal(cache.keys.some((key) => key.includes("Central")), false);

  const cached = await handle(request);
  assert.equal(cached.headers.get("x-cache-status"), "HIT");
  assert.equal(upstreamRequests.length, 1);
});

test("geocoding validates query size and result limits without contacting a provider", async () => {
  let fetches = 0;
  const handle = createGeocodeHandler({
    providerUrl: "https://geocoder.internal",
    fetchImpl: async () => {
      fetches += 1;
      return Response.json([]);
    },
  });

  for (const suffix of [
    "",
    "?q=a",
    `?q=${"x".repeat(121)}`,
    "?q=library&limit=0",
    "?q=library&limit=6",
    "?q=library&limit=1.5",
  ]) {
    const response = await handle(
      new Request(`https://atlas.example/api/geocode${suffix}`),
    );
    assert.equal(response.status, 400);
  }
  assert.equal(fetches, 0);
});

test("geocoding fails closed when unconfigured and honors the request limiter", async () => {
  const unconfigured = createGeocodeHandler();
  assert.equal(
    (
      await unconfigured(
        new Request("https://atlas.example/api/geocode?q=library"),
      )
    ).status,
    503,
  );

  const limited = createGeocodeHandler({
    providerUrl: "https://geocoder.internal",
    rateLimiter: { async limit() { return { success: false }; } },
  });
  const response = await limited(
    new Request("https://atlas.example/api/geocode?q=library"),
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("public Nominatim uses one application-wide limiter key", async () => {
  const publicKeys = [];
  const publicNominatim = createGeocodeHandler({
    providerUrl: "https://nominatim.openstreetmap.org",
    rateLimiter: {
      async limit({ key }) {
        publicKeys.push(key);
        return { success: false };
      },
    },
  });

  await publicNominatim(new Request("https://atlas.example/api/geocode?q=library", {
    headers: { "cf-connecting-ip": "203.0.113.1" },
  }));
  await publicNominatim(new Request("https://atlas.example/api/geocode?q=trail", {
    headers: { "cf-connecting-ip": "203.0.113.2" },
  }));
  assert.deepEqual(publicKeys, [
    "public-nominatim-application",
    "public-nominatim-application",
  ]);

  const privateKeys = [];
  const privateGeocoder = createGeocodeHandler({
    providerUrl: "https://geocoder.internal",
    rateLimiter: {
      async limit({ key }) {
        privateKeys.push(key);
        return { success: false };
      },
    },
  });
  await privateGeocoder(new Request("https://atlas.example/api/geocode?q=library", {
    headers: { "cf-connecting-ip": "203.0.113.3" },
  }));
  assert.deepEqual(privateKeys, ["203.0.113.3"]);
});

test("cached public Nominatim searches do not consume the shared limiter", async () => {
  const cache = memoryCache();
  const request = new Request("https://atlas.example/api/geocode?q=library");
  const populateCache = createGeocodeHandler({
    providerUrl: "https://nominatim.openstreetmap.org",
    cache,
    fetchImpl: async () => Response.json([]),
  });
  assert.equal((await populateCache(request)).headers.get("x-cache-status"), "MISS");

  let limiterCalls = 0;
  const limited = createGeocodeHandler({
    providerUrl: "https://nominatim.openstreetmap.org",
    cache,
    rateLimiter: {
      async limit() {
        limiterCalls += 1;
        return { success: false };
      },
    },
  });
  const cached = await limited(request);
  assert.equal(cached.status, 200);
  assert.equal(cached.headers.get("x-cache-status"), "HIT");
  assert.equal(limiterCalls, 0);

  const miss = await limited(
    new Request("https://atlas.example/api/geocode?q=trail"),
  );
  assert.equal(miss.status, 429);
  assert.equal(limiterCalls, 1);
});
