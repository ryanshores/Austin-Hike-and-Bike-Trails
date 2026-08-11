import test from "node:test";
import assert from "node:assert/strict";

import {
  exportDirectedEdges,
  traceShapesForCityCollection,
} from "../scripts/valhalla-directed-edge-export.js";

const cityCollection = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { BICYCLE_FACILITY: "Bike Lane" },
    geometry: {
      type: "LineString",
      coordinates: [[-97.75, 30.25], [-97.7495, 30.25]],
    },
  }],
};

test("directed-edge export traces City lines against the pinned graph and keeps exact IDs", async () => {
  const calls = [];
  const output = await exportDirectedEdges({
    cityCollection,
    routingUrl: "http://127.0.0.1:8002/base/",
    expectedGraphVersion: "1786234669",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (url.pathname === "/base/status") {
        return new Response(JSON.stringify({ tileset_last_modified: 1786234669 }), { status: 200 });
      }
      const request = JSON.parse(options.body);
      assert.equal(request.shape_match, "edge_walk");
      assert.equal(request.costing, "bicycle");
      assert.deepEqual(request.filters.attributes, [
        "edge.id",
        "edge.way_id",
        "edge.forward",
        "edge.begin_shape_index",
        "edge.end_shape_index",
        "shape",
      ]);
      assert.ok(request.shape.length >= 2);
      return new Response(JSON.stringify({
        edges: [{
          id: "2/123/4",
          way_id: 99,
          forward: true,
          begin_shape_index: 0,
          end_shape_index: request.shape.length - 1,
        }],
      }), { status: 200 });
    },
  });

  assert.equal(calls[0].url, "http://127.0.0.1:8002/base/status");
  assert.equal(calls[1].url, "http://127.0.0.1:8002/base/trace_attributes");
  assert.equal(output.routingGraphVersion, "1786234669");
  assert.deepEqual(output.traceSummary, {
    shapes: 1,
    tracedShapes: 1,
    fallbackTracedShapes: 0,
    untracedShapes: 0,
    failures: {},
  });
  assert.equal(output.features.length, 1);
  assert.deepEqual(output.features[0].properties, {
    edgeId: "2/123/4",
    osmWayId: 99,
    travelDirection: "forward",
    osm: {},
  });
  assert.ok(output.features[0].geometry.coordinates.length >= 2);
});

test("directed-edge export rejects a changed graph before tracing City facilities", async () => {
  await assert.rejects(
    exportDirectedEdges({
      cityCollection,
      routingUrl: "http://127.0.0.1:8002",
      expectedGraphVersion: "expected",
      fetchImpl: async () => new Response(JSON.stringify({ tileset_last_modified: "different" }), { status: 200 }),
    }),
    /does not match expected/,
  );
});

test("directed-edge export chunks long City lines with overlapping endpoints", () => {
  const coordinates = Array.from({ length: 101 }, (_, index) => [-97.75 + index / 10_000, 30.25]);
  const shapes = traceShapesForCityCollection({
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } }],
  });
  assert.ok(shapes.length > 1);
  assert.deepEqual(shapes[0].at(-1), shapes[1][0]);
  assert.ok(shapes.every((shape) => shape.length <= 16));
});

test("directed-edge export records client trace failures without emitting unsafe guessed edges", async () => {
  const output = await exportDirectedEdges({
    cityCollection,
    routingUrl: "http://127.0.0.1:8002",
    expectedGraphVersion: "1786234669",
    fetchImpl: async (url) => url.pathname === "/status"
      ? new Response(JSON.stringify({ tileset_last_modified: 1786234669 }), { status: 200 })
      : new Response(JSON.stringify({ error_code: 443 }), { status: 400 }),
  });
  assert.equal(output.features.length, 0);
  assert.deepEqual(output.traceSummary, {
    shapes: 1,
    tracedShapes: 0,
    fallbackTracedShapes: 0,
    untracedShapes: 1,
    failures: { "400:443": 1 },
  });
});

test("directed-edge export uses provider-returned geometry for walk-or-snap fallback", async () => {
  const shapeMatches = [];
  const output = await exportDirectedEdges({
    cityCollection,
    routingUrl: "http://127.0.0.1:8002",
    expectedGraphVersion: "1786234669",
    fetchImpl: async (url, options) => {
      if (url.pathname === "/status") {
        return new Response(JSON.stringify({ tileset_last_modified: 1786234669 }), { status: 200 });
      }
      const request = JSON.parse(options.body);
      shapeMatches.push(request.shape_match);
      if (request.shape_match === "edge_walk") {
        return new Response(JSON.stringify({ error_code: 443 }), { status: 400 });
      }
      return new Response(JSON.stringify({
        shape: "kt{}x@rr}iyDqSxYKN",
        edges: [{ id: "2/123/5", way_id: 100, forward: false, begin_shape_index: 0, end_shape_index: 1 }],
      }), { status: 200 });
    },
  });
  assert.deepEqual(shapeMatches, ["edge_walk", "walk_or_snap"]);
  assert.equal(output.traceSummary.fallbackTracedShapes, 1);
  assert.deepEqual(output.features[0].geometry.coordinates, [
    [-97.697082, 30.390614],
    [-97.697511, 30.390943],
  ]);
  assert.equal(output.features[0].properties.travelDirection, "backward");
});
