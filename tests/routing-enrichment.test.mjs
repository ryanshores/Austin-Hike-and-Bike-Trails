import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  SafetyClass,
  SafetyFinding,
} from "../worker/route-safety.js";
import {
  buildRoutingEnrichment,
  verifyRoutingEnrichment,
} from "../scripts/routing-enrichment.js";

const execFile = promisify(execFileCallback);

const line = (longitude, south = 30.26, north = 30.262) => ({
  type: "LineString",
  coordinates: [[longitude, south], [longitude, north]],
});

const edge = (id, longitude, osm) => ({
  type: "Feature",
  id,
  properties: { edgeId: id, osmWayId: `way-${id}`, osm },
  geometry: line(longitude),
});

const city = (facility, longitude, geometry = line(longitude)) => ({
  type: "Feature",
  properties: { BICYCLE_FACILITY: facility },
  geometry,
});

const manifest = {
  cityDatasetVersion: "city-test-v1",
  cityDatasetSha256: "city-sha",
  routingEdgesSha256: "edges-sha",
  osmExtractSource: "fixture.osm.pbf",
  osmExtractDate: "2026-08-01",
  osmExtractChecksum: "sha256:osm-test",
  routingGraphVersion: "graph-test-v1",
  valhallaImage: "valhalla@test-digest",
};

test("offline enrichment keeps City authority and bicycle-legal OSM fallback", () => {
  const input = {
    cityCollection: {
      type: "FeatureCollection",
      features: [
        city("Urban Trail", -97.74),
        city("Urban Trail", -97.76),
        city("Bike Lane", -97.76),
        city("Urban Trail", -97.78),
      ],
    },
    routingEdgeCollection: {
      type: "FeatureCollection",
      features: [
        edge("city-trail", -97.74, { highway: "residential" }),
        edge("ordinary-street", -97.75, { highway: "residential", maxspeed: "35 mph" }),
        edge("city-conflict", -97.76, { highway: "residential", cycleway: "lane" }),
        edge("prohibited", -97.77, { highway: "path", bicycle: "no" }),
        edge("city-prohibited", -97.78, { highway: "path", bicycle: "no" }),
      ],
    },
    manifest,
    toleranceMeters: 8,
    sampleSpacingMeters: 15,
    minimumCoverage: 0.8,
  };

  const result = buildRoutingEnrichment(input);
  const byId = Object.fromEntries(result.edges.map((item) => [item.edgeId, item]));

  assert.equal(byId["city-trail"].cityMatch.status, "matched");
  assert.equal(byId["city-trail"].classification.safetyClass, SafetyClass.FULLY_SEPARATED);
  assert.equal(byId["city-trail"].classification.source, "city");

  assert.equal(byId["ordinary-street"].cityMatch.status, "unmatched");
  assert.equal(
    byId["ordinary-street"].classification.safetyClass,
    SafetyClass.ANY_BICYCLE_LEGAL,
  );
  assert.equal(
    byId["ordinary-street"].classification.finding,
    SafetyFinding.NOT_IN_TRAILS_LIST,
  );

  assert.equal(byId["city-conflict"].cityMatch.status, "ambiguous");
  assert.equal(
    byId["city-conflict"].classification.safetyClass,
    SafetyClass.ANY_BICYCLE_LEGAL,
  );
  assert.equal(byId["city-conflict"].classification.finding, SafetyFinding.UNKNOWN);

  assert.equal(byId.prohibited.classification.safetyClass, null);
  assert.equal(byId.prohibited.classification.finding, SafetyFinding.BICYCLE_PROHIBITED);
  assert.equal(byId["city-prohibited"].cityMatch.status, "matched");
  assert.equal(byId["city-prohibited"].classification.safetyClass, null);
  assert.equal(
    byId["city-prohibited"].classification.finding,
    SafetyFinding.BICYCLE_PROHIBITED,
  );
  assert.deepEqual(result.summary.cityMatches, {
    matched: 2,
    partial: 0,
    ambiguous: 1,
    unmatched: 2,
  });
  assert.equal(result.summary.bicycleLegalFallbackEdges, 2);
  assert.equal(result.summary.bicycleProhibitedEdges, 2);
  assert.deepEqual(buildRoutingEnrichment(input), result);
});

test("partial City coverage remains routable without being promoted", () => {
  const result = buildRoutingEnrichment({
    cityCollection: {
      type: "FeatureCollection",
      features: [city("Protected Bike Lane", -97.74, line(-97.74, 30.26, 30.2608))],
    },
    routingEdgeCollection: {
      type: "FeatureCollection",
      features: [edge("partial", -97.74, { highway: "residential", cycleway: "lane" })],
    },
    manifest,
    toleranceMeters: 5,
    sampleSpacingMeters: 10,
    minimumCoverage: 0.8,
  });

  assert.equal(result.edges[0].cityMatch.status, "partial");
  assert.equal(result.edges[0].classification.safetyClass, SafetyClass.ANY_BICYCLE_LEGAL);
  assert.equal(result.edges[0].classification.finding, SafetyFinding.UNKNOWN);
  assert.match(result.edges[0].classification.reason, /bicycle-legal fallback/);
});

test("enrichment rejects edges without a stable graph identifier", () => {
  assert.throws(() => buildRoutingEnrichment({
    cityCollection: { type: "FeatureCollection", features: [] },
    routingEdgeCollection: {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: line(-97.74) }],
    },
    manifest,
  }), /stable edgeId/);
});

test("enrichment requires pinned City, OSM, graph, and Valhalla inputs", () => {
  assert.throws(() => buildRoutingEnrichment({
    cityCollection: { type: "FeatureCollection", features: [] },
    routingEdgeCollection: { type: "FeatureCollection", features: [] },
    manifest: { ...manifest, osmExtractChecksum: "" },
  }), /requires osmExtractChecksum/);
});

test("verification rejects artifacts that do not exactly rebuild from pinned inputs", () => {
  const cityCollection = {
    type: "FeatureCollection",
    features: [city("Urban Trail", -97.74)],
  };
  const routingEdgeCollection = {
    type: "FeatureCollection",
    features: [edge("city-trail", -97.74, { highway: "residential" })],
  };
  const enrichment = buildRoutingEnrichment({ cityCollection, routingEdgeCollection, manifest });
  const verification = {
    enrichment,
    cityCollection,
    routingEdgeCollection,
    cityDatasetSha256: manifest.cityDatasetSha256,
    routingEdgesSha256: manifest.routingEdgesSha256,
    expectedManifest: { routingGraphVersion: manifest.routingGraphVersion },
  };

  assert.deepEqual(verifyRoutingEnrichment(verification).summary, enrichment.summary);
  assert.throws(() => verifyRoutingEnrichment({
    ...verification,
    enrichment: {
      ...enrichment,
      summary: { ...enrichment.summary, edges: 99 },
    },
  }), /does not exactly match/);
  assert.throws(() => verifyRoutingEnrichment({
    ...verification,
    expectedManifest: { routingGraphVersion: "wrong-graph" },
  }), /does not match the expected value/);
});

test("verification rejects artifacts built with unapproved City-classification thresholds", () => {
  const cityCollection = {
    type: "FeatureCollection",
    features: [city("Urban Trail", -97.74)],
  };
  const routingEdgeCollection = {
    type: "FeatureCollection",
    features: [edge("city-trail", -97.74, { highway: "residential" })],
  };
  const enrichment = buildRoutingEnrichment({
    cityCollection,
    routingEdgeCollection,
    manifest,
    toleranceMeters: 25,
    sampleSpacingMeters: 20,
    minimumCoverage: 0.01,
  });

  assert.throws(() => verifyRoutingEnrichment({
    enrichment,
    cityCollection,
    routingEdgeCollection,
    cityDatasetSha256: manifest.cityDatasetSha256,
    routingEdgesSha256: manifest.routingEdgesSha256,
  }), /minimumCoverage does not match the approved verification policy/);
});

test("builder atomically writes an artifact the verifier accepts from file inputs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-enrichment-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cityPath = join(directory, "city.geojson");
  const edgePath = join(directory, "edges.geojson");
  const outputPath = join(directory, "enrichment.json");
  await writeFile(cityPath, JSON.stringify({
    type: "FeatureCollection",
    features: [city("Urban Trail", -97.74)],
  }));
  await writeFile(edgePath, JSON.stringify({
    type: "FeatureCollection",
    features: [edge("city-trail", -97.74, { highway: "residential" })],
  }));

  const buildArguments = [
    "scripts/build-routing-enrichment.mjs",
    "--city", cityPath,
    "--routing-edges", edgePath,
    "--output", outputPath,
    "--city-dataset-version", manifest.cityDatasetVersion,
    "--osm-extract-source", manifest.osmExtractSource,
    "--osm-extract-date", manifest.osmExtractDate,
    "--osm-extract-checksum", manifest.osmExtractChecksum,
    "--routing-graph-version", manifest.routingGraphVersion,
    "--valhalla-image", manifest.valhallaImage,
  ];
  await execFile(process.execPath, buildArguments);
  const files = await readdir(directory);
  assert.deepEqual(files.sort(), ["city.geojson", "edges.geojson", "enrichment.json"]);

  const { stdout } = await execFile(process.execPath, [
    "scripts/verify-routing-enrichment.mjs",
    "--enrichment", outputPath,
    "--city", cityPath,
    "--routing-edges", edgePath,
    "--expected-routing-graph-version", manifest.routingGraphVersion,
    "--expected-valhalla-image", manifest.valhallaImage,
  ]);
  assert.deepEqual(JSON.parse(stdout), {
    verified: true,
    summary: JSON.parse(await readFile(outputPath)).summary,
  });
});
