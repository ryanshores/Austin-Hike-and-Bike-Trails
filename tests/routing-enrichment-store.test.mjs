import assert from "node:assert/strict";
import test from "node:test";

import {
  createD1RoutingEnrichmentStore,
  routingEnrichmentEnabled,
} from "../worker/routing-enrichment.js";

function row(edgeId) {
  return {
    edge_id: edgeId,
    travel_direction: "forward",
    city_match_json: JSON.stringify({ status: "matched" }),
    city_json: JSON.stringify({ BICYCLE_FACILITY: "Urban Trail" }),
    osm_json: JSON.stringify({ highway: "cycleway" }),
    classification_json: JSON.stringify({
      safetyClass: 3,
      finding: "atlas",
      source: "city",
      reason: "fully separated path",
    }),
  };
}

test("D1 enrichment lookup binds exact graph IDs in bounded batches", async () => {
  const calls = [];
  const store = createD1RoutingEnrichmentStore({
    prepare(query) {
      assert.match(query, /routing_graph_version = \?/);
      assert.doesNotMatch(query, /edge-0/);
      return {
        bind(...values) {
          calls.push({ query, values });
          return { all: async () => ({ results: values.slice(1).map(row) }) };
        },
      };
    },
  });

  const records = await store.lookup({
    routingGraphVersion: "graph-v1",
    edgeIds: Array.from({ length: 201 }, (_, index) => `edge-${index}`),
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].values[0], "graph-v1");
  assert.equal(calls[0].values.length, 100);
  assert.equal(calls[1].values.length, 100);
  assert.equal(calls[2].values.length, 4);
  assert.equal(records.size, 201);
  assert.equal(records.get("edge-200").classification.safetyClass, 3);
});

test("D1 enrichment is disabled until an explicit post-import feature flag is set", () => {
  assert.equal(routingEnrichmentEnabled(undefined), false);
  assert.equal(routingEnrichmentEnabled("false"), false);
  assert.equal(routingEnrichmentEnabled("true"), true);
});

test("D1 enrichment lookup ignores malformed sidecar records", async () => {
  const store = createD1RoutingEnrichmentStore({
    prepare() {
      return {
        bind() {
          return {
            all: async () => ({
              results: [{ edge_id: "broken", city_match_json: "not-json" }],
            }),
          };
        },
      };
    },
  });

  assert.deepEqual(
    await store.lookup({ routingGraphVersion: "graph-v1", edgeIds: ["broken"] }),
    new Map(),
  );
});
