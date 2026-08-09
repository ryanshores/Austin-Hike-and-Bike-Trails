import assert from "node:assert/strict";
import test from "node:test";

import {
  SafetyClass,
  SafetyFinding,
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
    accessClientId: "staging-access-client",
    accessClientSecret: "staging-access-secret",
    fetchImpl: async (url, options) => {
      const endpoint = new URL(url);
      upstream.push({ endpoint, options });
      if (endpoint.pathname === "/route") {
        const requestBody = JSON.parse(options.body);
        assert.equal(requestBody.costing, "bicycle");
        assert.deepEqual(requestBody.costing_options, {
          bicycle: { bicycle_type: "hybrid", use_roads: 0.1 },
        });
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
  for (const { options } of upstream) {
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers["CF-Access-Client-Id"], "staging-access-client");
    assert.equal(options.headers["CF-Access-Client-Secret"], "staging-access-secret");
  }
  assert.equal(body.route.totalMiles, 2.4);
  assert.ok(Math.abs(body.route.totalAscentFeet - 65.6168) < 0.0001);
  assert.ok(Math.abs(body.route.totalDescentFeet - 32.8084) < 0.0001);
  assert.equal(body.route.divergenceCount, 1);
  assert.equal(body.route.divergenceMiles, 2.4);
  assert.match(body.route.divergences[0].reason, /unknown/);
  assert.equal(body.route.maneuvers[0].instruction, "Ride north on Congress Avenue.");
  assert.equal(body.route.versions.routingGraph, "1784950400");
  assert.equal(recursivelyHasForbiddenKey(body), false);
  assert.equal(JSON.stringify(body).includes("staging-access-secret"), false);
});

test("incomplete routing Access credentials fail closed without contacting the provider", async () => {
  let fetches = 0;
  const handle = createRoutesHandler({
    providerUrl: "https://valhalla.internal",
    accessClientId: "staging-access-client",
    fetchImpl: async () => {
      fetches += 1;
      return Response.json({});
    },
  });

  const response = await handle(routeRequest());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Routing provider access is not configured.",
  });
  assert.equal(fetches, 0);
});

test("routing rejects provider redirects without following Access credentials", async () => {
  const accessClientSecret = "staging-access-secret";
  const handle = createRoutesHandler({
    providerUrl: "https://valhalla.internal",
    accessClientId: "staging-access-client",
    accessClientSecret,
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, "manual");
      assert.equal(options.headers["CF-Access-Client-Secret"], accessClientSecret);
      return new Response(null, {
        status: 302,
        headers: { Location: "https://redirect-target.example" },
      });
    },
  });

  const response = await handle(routeRequest());
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.match(body.error, /provider returned HTTP 302/);
  assert.equal(JSON.stringify(body).includes(accessClientSecret), false);
});

test("stock Valhalla alternates participate in candidate ranking", async () => {
  const primaryShape = encodePolyline6([
    [30.2672, -97.7431],
    [30.285, -97.735],
  ]);
  const alternateShape = encodePolyline6([
    [30.2672, -97.7431],
    [30.28, -97.74],
  ]);
  const handle = createRoutesHandler({
    providerUrl: "https://valhalla.internal",
    fetchImpl: async (url) => {
      if (new URL(url).pathname === "/route") {
        return Response.json({
          routingGraphVersion: "osm-test",
          trip: { summary: { length: 2 }, legs: [{ shape: primaryShape }] },
          alternates: [{
            trip: { summary: { length: 1 }, legs: [{ shape: alternateShape }] },
          }],
        });
      }
      return Response.json({ range_height: [[0, 100], [100, 100]] });
    },
  });

  const response = await handle(routeRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.route.totalMiles, 1);
  assert.deepEqual(body.route.geometry.coordinates, [
    [-97.7431, 30.2672],
    [-97.74, 30.28],
  ]);
});

test("attributed Valhalla graph edges use the matching D1 sidecar classification", async () => {
  const shape = encodePolyline6([
    [30.2672, -97.7431],
    [30.275, -97.74],
    [30.285, -97.735],
  ]);
  const lookupCalls = [];
  const handle = createRoutesHandler({
    providerUrl: "https://valhalla.internal",
    enrichmentStore: {
      async lookup(request) {
        lookupCalls.push(request);
        return new Map([
          ["1/2/3", {
            osm: { highway: "cycleway" },
            city: { BICYCLE_FACILITY: "Urban Trail" },
            travelDirection: "forward",
            classification: {
              safetyClass: SafetyClass.FULLY_SEPARATED,
              finding: SafetyFinding.ATLAS,
              source: "city",
              reason: "fully separated path",
            },
          }],
          ["1/2/4", {
            osm: { highway: "residential", cycleway: "lane" },
            city: null,
            travelDirection: "forward",
            classification: {
              safetyClass: SafetyClass.BIKE_FACILITY,
              finding: SafetyFinding.NOT_IN_TRAILS_LIST,
              source: "osm",
              reason: "not in the Atlas trails list",
            },
          }],
        ]);
      },
    },
    fetchImpl: async (url, options) => {
      const endpoint = new URL(url);
      if (endpoint.pathname === "/route") {
        return Response.json({
          routingGraphVersion: "graph-v1",
          trip: { summary: { length: 2 }, legs: [{ shape }] },
        });
      }
      if (endpoint.pathname === "/height") {
        return Response.json({ range_height: [[0, 100], [1_000, 100]] });
      }
      if (endpoint.pathname === "/trace_attributes") {
        const body = JSON.parse(options.body);
        assert.equal(body.shape_match, "edge_walk");
        assert.equal(body.costing, "bicycle");
        assert.deepEqual(body.filters, {
          attributes: [
            "edge.id",
            "edge.length",
            "edge.begin_shape_index",
            "edge.end_shape_index",
          ],
          action: "include",
        });
        return Response.json({
          edges: [
            { id: "1/2/3", length: 1, begin_shape_index: 0, end_shape_index: 1 },
            { id: "1/2/4", length: 1, begin_shape_index: 1, end_shape_index: 2 },
          ],
        });
      }
      throw new Error(`unexpected endpoint ${endpoint.pathname}`);
    },
  });

  const response = await handle(routeRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(lookupCalls, [{
    routingGraphVersion: "graph-v1",
    edgeIds: ["1/2/3", "1/2/4"],
  }]);
  assert.equal(body.route.mileageBySafetyClass[SafetyClass.FULLY_SEPARATED], 1);
  assert.equal(body.route.mileageBySafetyClass[SafetyClass.BIKE_FACILITY], 1);
  assert.equal(body.route.divergenceCount, 1);
  assert.equal(body.route.divergenceMiles, 1);
  assert.equal(recursivelyHasForbiddenKey(body), false);
});

test("attribution or sidecar failure remains a conservative unknown route", async () => {
  const shape = encodePolyline6([
    [30.2672, -97.7431],
    [30.285, -97.735],
  ]);
  const handle = createRoutesHandler({
    providerUrl: "https://valhalla.internal",
    enrichmentStore: { async lookup() { throw new Error("D1 temporarily unavailable"); } },
    fetchImpl: async (url) => {
      const endpoint = new URL(url);
      if (endpoint.pathname === "/route") {
        return Response.json({
          routingGraphVersion: "graph-v1",
          trip: { summary: { length: 2 }, legs: [{ shape }] },
        });
      }
      if (endpoint.pathname === "/height") {
        return Response.json({ range_height: [[0, 100], [1_000, 100]] });
      }
      if (endpoint.pathname === "/trace_attributes") {
        return Response.json({
          edges: [{ id: "1/2/3", length: 2, begin_shape_index: 0, end_shape_index: 1 }],
        });
      }
      throw new Error(`unexpected endpoint ${endpoint.pathname}`);
    },
  });

  const response = await handle(routeRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.route.mileageBySafetyClass[SafetyClass.ANY_BICYCLE_LEGAL], 2);
  assert.match(body.route.divergences[0].reason, /unknown/);
});

test("an invalid sidecar classification remains an unknown route edge", async () => {
  const shape = encodePolyline6([
    [30.2672, -97.7431],
    [30.285, -97.735],
  ]);
  const handle = createRoutesHandler({
    providerUrl: "https://valhalla.internal",
    enrichmentStore: {
      async lookup() {
        return new Map([["1/2/3", {
          osm: { highway: "cycleway" },
          city: { BICYCLE_FACILITY: "Urban Trail" },
          travelDirection: "forward",
          classification: {
            safetyClass: 99,
            finding: SafetyFinding.ATLAS,
            source: "city",
            reason: "invalid sidecar value",
          },
        }]]);
      },
    },
    fetchImpl: async (url) => {
      const endpoint = new URL(url);
      if (endpoint.pathname === "/route") {
        return Response.json({
          routingGraphVersion: "graph-v1",
          trip: { summary: { length: 2 }, legs: [{ shape }] },
        });
      }
      if (endpoint.pathname === "/height") {
        return Response.json({ range_height: [[0, 100], [1_000, 100]] });
      }
      if (endpoint.pathname === "/trace_attributes") {
        return Response.json({
          edges: [{ id: "1/2/3", length: 2, begin_shape_index: 0, end_shape_index: 1 }],
        });
      }
      throw new Error(`unexpected endpoint ${endpoint.pathname}`);
    },
  });

  const response = await handle(routeRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.route.mileageBySafetyClass[SafetyClass.ANY_BICYCLE_LEGAL], 2);
  assert.match(body.route.divergences[0].reason, /unknown/);
});

test("safety preferences tune road use without prohibiting bicycle-legal streets", async () => {
  const expectedRoadUse = new Map([
    [SafetyPreference.ANY_BICYCLE_LEGAL, 0.5],
    [SafetyPreference.BIKE_FACILITY_OR_SAFER, 0.25],
    [SafetyPreference.PROTECTED_OR_SEPARATED, 0.1],
    [SafetyPreference.FULLY_SEPARATED, 0],
  ]);
  const geometry = {
    type: "LineString",
    coordinates: [[-97.7431, 30.2672], [-97.735, 30.285]],
  };

  for (const [safetyPreference, useRoads] of expectedRoadUse) {
    let providerBody;
    const handle = createRoutesHandler({
      providerUrl: "https://routing.internal",
      fetchImpl: async (_url, options) => {
        providerBody = JSON.parse(options.body);
        return Response.json({
          routingGraphVersion: "osm-test",
          candidates: [{
            geometry,
            totalAscentFeet: 0,
            totalDescentFeet: 0,
            edges: [{
              geometry,
              miles: 1,
              osm: { highway: "residential" },
            }],
          }],
        });
      },
    });

    const response = await handle(routeRequest({ safetyPreference }));
    assert.equal(response.status, 200);
    assert.deepEqual(providerBody.costing_options, {
      bicycle: { bicycle_type: "hybrid", use_roads: useRoads },
    });
    const body = await response.json();
    assert.equal(body.route.totalMiles, 1);
  }
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

test("offline conservative classifications are preserved by the Worker", async () => {
  const geometry = {
    type: "LineString",
    coordinates: [[-97.7431, 30.2672], [-97.735, 30.285]],
  };
  const handle = createRoutesHandler({
    providerUrl: "https://routing.internal",
    fetchImpl: async () => Response.json({
      routingGraphVersion: "osm-test",
      candidates: [{
        geometry,
        totalAscentFeet: 0,
        totalDescentFeet: 0,
        edges: [{
          geometry,
          miles: 1,
          osm: { highway: "residential", cycleway: "lane" },
          classification: {
            safetyClass: SafetyClass.ANY_BICYCLE_LEGAL,
            finding: SafetyFinding.UNKNOWN,
            source: "city-osm",
            reason: "conflicting City safety data; bicycle-legal fallback",
          },
        }],
      }],
    }),
  });

  const response = await handle(routeRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.route.mileageBySafetyClass[SafetyClass.ANY_BICYCLE_LEGAL], 1);
  assert.equal(body.route.mileageBySafetyClass[SafetyClass.BIKE_FACILITY], 0);
  assert.equal(body.route.divergenceCount, 1);
  assert.equal(body.route.divergenceMiles, 1);
});

test("explicit OSM bicycle prohibitions override provider classifications", async () => {
  const geometry = {
    type: "LineString",
    coordinates: [[-97.7431, 30.2672], [-97.735, 30.285]],
  };
  const handle = createRoutesHandler({
    providerUrl: "https://routing.internal",
    fetchImpl: async () => Response.json({
      routingGraphVersion: "osm-test",
      candidates: [{
        geometry,
        totalAscentFeet: 0,
        totalDescentFeet: 0,
        edges: [{
          geometry,
          miles: 1,
          city: { BICYCLE_FACILITY: "Urban Trail" },
          osm: { highway: "path", bicycle: "no" },
          classification: {
            safetyClass: SafetyClass.FULLY_SEPARATED,
            finding: SafetyFinding.ATLAS,
            source: "city",
            reason: "fully separated path",
          },
        }],
      }],
    }),
  });

  const response = await handle(routeRequest());
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, "no-reasonable-route");
});

test("invalid provider classifications fail closed", async () => {
  const geometry = {
    type: "LineString",
    coordinates: [[-97.7431, 30.2672], [-97.735, 30.285]],
  };
  const handle = createRoutesHandler({
    providerUrl: "https://routing.internal",
    fetchImpl: async () => Response.json({
      routingGraphVersion: "osm-test",
      candidates: [{
        geometry,
        totalAscentFeet: 0,
        totalDescentFeet: 0,
        edges: [{
          geometry,
          miles: 1,
          classification: {
            safetyClass: 99,
            finding: SafetyFinding.UNKNOWN,
            source: "city-osm",
            reason: "invalid class",
          },
        }],
      }],
    }),
  });

  const response = await handle(routeRequest());
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /invalid edge classification/);
});

test("enriched edges retain route elevation and geometry is allowlisted", async () => {
  const providerGeometry = {
    type: "LineString",
    coordinates: [[-97.7431, 30.2672], [-97.735, 30.285]],
    duration: 123,
    internalMetadata: { time: 456 },
  };
  const handle = createRoutesHandler({
    providerUrl: "https://routing.internal",
    fetchImpl: async () => Response.json({
      routingGraphVersion: "osm-test",
      candidates: [{
        geometry: providerGeometry,
        totalAscentFeet: 20,
        totalDescentFeet: 15,
        edges: [{
          geometry: providerGeometry,
          miles: 1.2,
          city: { BICYCLE_FACILITY: "Protected Bike Lane" },
        }, {
          geometry: providerGeometry,
          miles: 0.8,
          city: { BICYCLE_FACILITY: "Protected Bike Lane" },
        }],
      }],
    }),
  });

  const response = await handle(routeRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.route.totalAscentFeet, 20);
  assert.equal(body.route.totalDescentFeet, 15);
  assert.deepEqual(body.route.geometry, {
    type: "LineString",
    coordinates: [[-97.7431, 30.2672], [-97.735, 30.285]],
  });
  assert.equal(recursivelyHasForbiddenKey(body), false);
});

test("enriched edges retain elevation sampled from the route profile", async () => {
  const geometry = {
    type: "LineString",
    coordinates: [[-97.7431, 30.2672], [-97.735, 30.285]],
  };
  const handle = createRoutesHandler({
    providerUrl: "https://routing.internal",
    fetchImpl: async (url) => {
      if (new URL(url).pathname === "/route") {
        return Response.json({
          routingGraphVersion: "osm-test",
          candidates: [{
            geometry,
            totalAscentFeet: null,
            totalDescentFeet: "",
            edges: [{
              geometry,
              miles: 1,
              city: { BICYCLE_FACILITY: "Protected Bike Lane" },
            }],
          }],
        });
      }
      return Response.json({ range_height: [[0, 100], [100, 110], [200, 105]] });
    },
  });

  const response = await handle(routeRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Math.abs(body.route.totalAscentFeet - 32.8084) < 0.0001);
  assert.ok(Math.abs(body.route.totalDescentFeet - 16.4042) < 0.0001);
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
    accessClientId: "staging-access-client",
    accessClientSecret: "staging-access-secret",
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).pathname, "/status");
      assert.equal(options.redirect, "manual");
      assert.equal(options.headers["CF-Access-Client-Id"], "staging-access-client");
      assert.equal(options.headers["CF-Access-Client-Secret"], "staging-access-secret");
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

  const incomplete = createRoutingHealthHandler({
    providerUrl: "https://valhalla.internal",
    accessClientId: "staging-access-client",
    fetchImpl: async () => {
      throw new Error("incomplete credentials must not contact the provider");
    },
  });
  assert.equal(
    (
      await incomplete(
        new Request("https://atlas.example/api/routing-health"),
      )
    ).status,
    503,
  );

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
