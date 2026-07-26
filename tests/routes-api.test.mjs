import assert from "node:assert/strict";
import test from "node:test";

import {
  SafetyClass,
  SafetyPreference,
} from "../worker/route-safety.js";
import {
  ROUTE_MAX_BODY_BYTES,
  createRoutesHandler,
  createRoutingHealthHandler,
  decodePolyline6,
} from "../worker/routes.js";

function encodePolyline6(points) {
  let previousLatitude = 0;
  let previousLongitude = 0;
  const encodeValue = (value) => {
    let encoded = "";
    let shifted = value < 0 ? ~(value << 1) : value << 1;
    while (shifted >= 0x20) {
      encoded += String.fromCharCode((0x20 | (shifted & 0x1f)) + 63);
      shifted >>= 5;
    }
    return encoded + String.fromCharCode(shifted + 63);
  };
  return points
    .map(([latitude, longitude]) => {
      const nextLatitude = Math.round(latitude * 1e6);
      const nextLongitude = Math.round(longitude * 1e6);
      const value =
        encodeValue(nextLatitude - previousLatitude) +
        encodeValue(nextLongitude - previousLongitude);
      previousLatitude = nextLatitude;
      previousLongitude = nextLongitude;
      return value;
    })
    .join("");
}

const start = { latitude: 30.2672, longitude: -97.7431 };
const destination = { latitude: 30.285, longitude: -97.735 };

function routeRequest(overrides = {}) {
  return new Request("https://atlas.example/api/routes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      start,
      destination,
      safetyPreference: SafetyPreference.PROTECTED_OR_SEPARATED,
      ...overrides,
    }),
  });
}

function recursivelyHasForbiddenKey(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) =>
      /(eta|duration|time)/i.test(key) ||
      recursivelyHasForbiddenKey(child),
  );
}

test("polyline6 decoding preserves Valhalla's six-digit coordinate precision", () => {
  const encoded = encodePolyline6([
    [30.2672, -97.7431],
    [30.285, -97.735],
  ]);
  assert.deepEqual(decodePolyline6(encoded), [
    [-97.7431, 30.2672],
    [-97.735, 30.285],
  ]);
});

test("stock Valhalla routes normalize geometry, elevation, and maneuvers without ETA fields", async () => {
  const shape = encodePolyline6([
    [30.2672, -97.7431],
    [30.275, -97.74],
    [30.285, -97.735],
  ]);
  const upstream = [];
  const handle = createRoutesHandler({
    providerUrl: "https://valhalla.internal",
    fetchImpl: async (url, options) => {
      const endpoint = new URL(url);
      upstream.push({ endpoint, options });
      if (endpoint.pathname === "/route") {
        const requestBody = JSON.parse(options.body);
        assert.equal(requestBody.costing, "bicycle");
        assert.equal(requestBody.units, "miles");
        assert.equal(requestBody.alternates, 2);
        return Response.json({
          trip: {
            summary: { length: 2.4, time: 800 },
            legs: [{
              shape,
              maneuvers: [{
                type: 1,
                instruction: "Ride north on Congress Avenue.",
                length: 0.4,
                time: 120,
                begin_shape_index: 0,
                end_shape_index: 1,
                street_names: ["Congress Avenue"],
              }],
            }],
          },
        });
      }
      if (endpoint.pathname === "/height") {
        const elevationRequest = JSON.parse(options.body);
        assert.equal(elevationRequest.encoded_polyline, shape);
        assert.equal(elevationRequest.shape_format, "polyline6");
        return Response.json({
          range_height: [[0, 150], [1000, 170], [2000, 160]],
        });
      }
      if (endpoint.pathname === "/status") {
        return Response.json({
          version: "3.6.3",
          tileset_last_modified: 1_784_950_400,
        });
      }
      throw new Error(`unexpected endpoint ${endpoint.pathname}`);
    },
  });

  const response = await handle(routeRequest());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(upstream.length, 3);
  assert.equal(body.route.totalMiles, 2.4);
  assert.ok(Math.abs(body.route.totalAscentFeet - 65.6168) < 0.0001);
  assert.ok(Math.abs(body.route.totalDescentFeet - 32.8084) < 0.0001);
  assert.equal(body.route.divergenceCount, 1);
  assert.equal(body.route.divergenceMiles, 2.4);
  assert.match(body.route.divergences[0].reason, /unknown/);
  assert.equal(body.route.maneuvers[0].instruction, "Ride north on Congress Avenue.");
  assert.equal(body.route.versions.routingGraph, "1784950400");
  assert.equal(recursivelyHasForbiddenKey(body), false);
});

test("enriched candidates are ranked by safety before distance", async () => {
  const geometry = {
    type: "LineString",
    coordinates: [[-97.7431, 30.2672], [-97.735, 30.285]],
  };
  const candidate = (miles, city, trafficExposureCost) => ({
    geometry,
    totalAscentFeet: 20,
    totalDescentFeet: 15,
    trafficExposureCost,
    edges: [{
      geometry,
      miles,
      city,
      ascentFeet: 20,
      descentFeet: 15,
    }],
    maneuvers: [{ instruction: `Ride ${miles} miles.`, distanceMiles: miles }],
  });
  const handle = createRoutesHandler({
    providerUrl: "https://routing.internal",
    fetchImpl: async (url) => {
      assert.equal(new URL(url).pathname, "/route");
      return Response.json({
        candidates: [
          candidate(1, { BICYCLE_FACILITY: "Bike Lane" }, 1),
          candidate(1.4, { BICYCLE_FACILITY: "Protected Bike Lane" }, 4),
        ],
        datasetVersion: "city-2026-07-25",
        routingGraphVersion: "osm-2026-07-25",
      });
    },
  });

  const response = await handle(routeRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.route.totalMiles, 1.4);
  assert.equal(body.route.divergenceCount, 0);
  assert.equal(body.route.mileageBySafetyClass[SafetyClass.PROTECTED], 1.4);
  assert.equal(body.route.versions.dataset, "city-2026-07-25");
});

test("routes reject prohibited-only candidates with a clear failure state", async () => {
  const geometry = {
    type: "LineString",
    coordinates: [[-97.7431, 30.2672], [-97.735, 30.285]],
  };
  const handle = createRoutesHandler({
    providerUrl: "https://routing.internal",
    fetchImpl: async () =>
      Response.json({
        routingGraphVersion: "osm-test",
        candidates: [{
          geometry,
          totalAscentFeet: 0,
          totalDescentFeet: 0,
          edges: [{
            geometry,
            miles: 1,
            osm: { highway: "footway", bicycle: "no" },
          }],
        }],
      }),
  });

  const response = await handle(routeRequest());
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, "no-reasonable-route");
});

test("route validation enforces body size, safety preference, bounds, distance, and limits", async () => {
  let fetches = 0;
  const handle = createRoutesHandler({
    providerUrl: "https://routing.internal",
    fetchImpl: async () => {
      fetches += 1;
      return Response.json({});
    },
  });

  for (const request of [
    routeRequest({ safetyPreference: "fastest" }),
    routeRequest({ start: { latitude: 32.7767, longitude: -96.797 } }),
    routeRequest({
      start: { latitude: 29.72, longitude: -98.3 },
      destination: { latitude: 30.82, longitude: -97.08 },
    }),
    new Request("https://atlas.example/api/routes", {
      method: "POST",
      headers: { "Content-Length": String(ROUTE_MAX_BODY_BYTES + 1) },
      body: "{}",
    }),
  ]) {
    const response = await handle(request);
    assert.ok([400, 413].includes(response.status));
  }
  assert.equal(fetches, 0);

  const limited = createRoutesHandler({
    providerUrl: "https://routing.internal",
    rateLimiter: { async limit() { return { success: false }; } },
  });
  assert.equal((await limited(routeRequest())).status, 429);
});

test("routing health exposes operational versions without provider internals", async () => {
  const healthy = createRoutingHealthHandler({
    providerUrl: "https://valhalla.internal",
    fetchImpl: async (url) => {
      assert.equal(new URL(url).pathname, "/status");
      return Response.json({
        version: "3.6.3",
        has_tiles: true,
        tileset_last_modified: 1_784_950_400,
        bbox: { type: "Polygon", coordinates: [] },
      });
    },
  });
  const response = await healthy(
    new Request("https://atlas.example/api/routing-health"),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    provider: "valhalla",
    version: "3.6.3",
    routingGraphVersion: "1784950400",
  });

  const unconfigured = createRoutingHealthHandler();
  assert.equal(
    (
      await unconfigured(
        new Request("https://atlas.example/api/routing-health"),
      )
    ).status,
    503,
  );
});
