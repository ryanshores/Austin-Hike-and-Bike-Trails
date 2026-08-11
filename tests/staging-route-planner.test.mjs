import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPublicRoute,
  coordinate,
  stagingBaseUrl,
  verifyStagingRoutePlanner,
} from "../scripts/verify-staging-route-planner.mjs";

const route = {
  safetyPreference: "protected-or-separated",
  route: {
    geometry: { type: "LineString", coordinates: [[-97.7431, 30.2672], [-97.7611, 30.2604]] },
    totalMiles: 1.4,
    totalAscentFeet: 25,
    totalDescentFeet: 18,
    mileageBySafetyClass: { 0: 0.2, 2: 1.2 },
    divergenceCount: 1,
    divergenceMiles: 0.2,
    divergences: [{
      miles: 0.2,
      reason: "not in the Atlas trails list",
      geometry: { type: "LineString", coordinates: [[-97.751, 30.265], [-97.755, 30.263]] },
    }],
    maneuvers: [{ instruction: "Ride west.", distanceMiles: 1.4, type: 1, beginShapeIndex: 0, endShapeIndex: 1 }],
    versions: { dataset: "city-v1", routingGraph: "graph-v1" },
  },
};

test("staging probe accepts only an HTTPS origin and coordinate pairs", () => {
  assert.equal(stagingBaseUrl("https://preview.example/").origin, "https://preview.example");
  assert.throws(() => stagingBaseUrl("http://preview.example"), /HTTPS origin/);
  assert.throws(() => stagingBaseUrl("https://preview.example/path"), /must not include a path/);
  assert.deepEqual(coordinate("30.2672,-97.7431", "Start"), {
    latitude: 30.2672,
    longitude: -97.7431,
  });
  assert.throws(() => coordinate("30.2", "Start"), /latitude,longitude/);
});

test("staging probe verifies health and the public route contract without ETA fields", async () => {
  const calls = [];
  const result = await verifyStagingRoutePlanner({
    baseUrl: "https://preview.example/",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: new URL(url), options });
      if (new URL(url).pathname === "/api/routing-health") {
        return Response.json({ status: "ok", provider: "valhalla", version: "3.7.0", routingGraphVersion: "graph-v1" });
      }
      return Response.json(route);
    },
  });

  assert.deepEqual(calls.map(({ url }) => url.pathname), ["/api/routing-health", "/api/routes"]);
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[1].options.redirect, "manual");
  assert.equal(JSON.parse(calls[1].options.body).safetyPreference, "protected-or-separated");
  assert.deepEqual(result.route, {
    totalMiles: 1.4,
    divergenceCount: 1,
    divergenceMiles: 0.2,
    safetyPreference: "protected-or-separated",
  });
});

test("staging probe rejects redirects and planner-invalid maneuver details", async () => {
  await assert.rejects(
    verifyStagingRoutePlanner({
      baseUrl: "https://preview.example/",
      fetchImpl: async () => new Response(null, { status: 307, headers: { Location: "https://production.example" } }),
    }),
    /redirected instead of responding from staging/,
  );
  assert.throws(() => assertPublicRoute({
    ...route,
    route: { ...route.route, maneuvers: [{ instruction: "Ride west." }] },
  }, "protected-or-separated"), /maneuver distanceMiles/);
  assert.throws(() => assertPublicRoute({
    ...route,
    route: { ...route.route, maneuvers: [{ ...route.route.maneuvers[0], endShapeIndex: -1 }] },
  }, "protected-or-separated"), /invalid maneuver endShapeIndex/);
});

test("staging probe rejects forbidden client-facing timing fields", () => {
  assert.throws(() => assertPublicRoute({
    ...route,
    route: { ...route.route, estimatedDuration: 600 },
  }, "protected-or-separated"), /forbidden client field/);
});
