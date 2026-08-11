import assert from "node:assert/strict";
import test from "node:test";

import {
  createD1RoutingEnrichmentStore,
  createSqliteRoutingEnrichmentStore,
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

test("SQLite sidecar lookup uses exact IDs, Access headers, and byte-bounded requests", async () => {
  const calls = [];
  const store = createSqliteRoutingEnrichmentStore({
    sidecarUrl: "https://enrichment.internal/base/",
    accessClientId: "preview-client-id",
    accessClientSecret: "preview-client-secret",
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url: new URL(url), options, body });
      return Response.json({
        routingGraphVersion: body.routingGraphVersion,
        records: body.edgeIds.map((edgeId) => ({
          edgeId,
          travelDirection: "forward",
          cityMatch: { status: "matched" },
          city: { BICYCLE_FACILITY: "Urban Trail" },
          osm: { highway: "cycleway" },
          classification: {
            safetyClass: 3,
            finding: "atlas",
            source: "city",
            reason: "fully separated path",
          },
        })),
      });
    },
  });

  const records = await store.lookup({
    routingGraphVersion: "graph-v1",
    edgeIds: Array.from({ length: 201 }, (_, index) => `edge-${index}`),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, "https://enrichment.internal/base/v1/lookup");
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[0].options.headers["CF-Access-Client-Id"], "preview-client-id");
  assert.equal(calls[0].options.headers["CF-Access-Client-Secret"], "preview-client-secret");
  assert.equal(calls[0].body.edgeIds.length, 201);
  assert.equal(records.size, 201);
  assert.equal(records.get("edge-200").classification.safetyClass, 3);
});

test("SQLite sidecar splits escaped UTF-8 IDs before its serialized body limit", async () => {
  const requestBodies = [];
  const store = createSqliteRoutingEnrichmentStore({
    sidecarUrl: "https://enrichment.internal",
    accessClientId: "client-id",
    accessClientSecret: "client-secret",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requestBodies.push(options.body);
      return Response.json({ routingGraphVersion: body.routingGraphVersion, records: [] });
    },
  });
  const edgeIds = Array.from({ length: 200 }, (_, index) =>
    `${String(index).padStart(3, "0")}${'"'.repeat(253)}`,
  );

  await store.lookup({ routingGraphVersion: "graph-v1", edgeIds });

  assert.ok(requestBodies.length > 1);
  for (const body of requestBodies) {
    assert.ok(new TextEncoder().encode(body).byteLength <= 65_536);
  }
});

test("SQLite sidecar rejects mismatched or malformed responses and requires a complete Access pair", async () => {
  assert.equal(createSqliteRoutingEnrichmentStore({
    sidecarUrl: "https://enrichment.internal",
    accessClientId: "client-id",
  }), null);

  const store = createSqliteRoutingEnrichmentStore({
    sidecarUrl: "https://enrichment.internal",
    accessClientId: "client-id",
    accessClientSecret: "client-secret",
    fetchImpl: async () => Response.json({
      routingGraphVersion: "different-graph",
      records: [],
    }),
  });

  await assert.rejects(
    store.lookup({ routingGraphVersion: "graph-v1", edgeIds: ["edge-1"] }),
    /invalid lookup response/,
  );
});
