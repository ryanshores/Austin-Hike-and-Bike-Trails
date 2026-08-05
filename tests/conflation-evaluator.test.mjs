import assert from "node:assert/strict";
import test from "node:test";

import { boundsForLine, evaluateConflation, pointToSegmentMeters } from "../scripts/conflation-evaluator.js";
import { elevationSummary, markdownReport, reportSummary } from "../scripts/conflation-report.js";

const route = { type: "LineString", coordinates: [[-97.7431, 30.2672], [-97.7431, 30.2772]] };
const feature = (facility, coordinates = route.coordinates) => ({ type: "Feature", properties: { BICYCLE_FACILITY: facility }, geometry: { type: "LineString", coordinates } });

test("conflation reports full coverage for aligned City geometry", () => {
  const result = evaluateConflation({ route, cityFeatures: [feature("Urban Trail")], toleranceMeters: 10, sampleSpacingMeters: 25 });
  assert.equal(result.coverageRatio, 1);
  assert.equal(result.unmatchedMiles, 0);
  assert.equal(result.ambiguousMiles, 0);
  assert.ok(result.routeMiles > 0.6);
  assert.equal(result.facilityMiles["Urban Trail"], result.routeMiles);
});

test("conflation keeps unmatched route mileage distinct from City-matched mileage", () => {
  const result = evaluateConflation({ route, cityFeatures: [feature("Bike Lane", [[-97.75, 30.2672], [-97.75, 30.2772]])], toleranceMeters: 10 });
  assert.equal(result.matchedMiles, 0);
  assert.equal(result.ambiguousMiles, 0);
  assert.equal(result.unmatchedMiles, result.routeMiles);
  assert.equal(result.coverageRatio, 0);
});

test("conflation marks contradictory nearby City labels as ambiguous", () => {
  const result = evaluateConflation({ route, cityFeatures: [feature("Urban Trail"), feature("Bike Lane")], toleranceMeters: 10 });
  assert.equal(result.matchedMiles, 0);
  assert.equal(result.unmatchedMiles, 0);
  assert.equal(result.ambiguousMiles, result.routeMiles);
  assert.equal(result.coverageRatio, 0);
});

test("conflation treats differing City safety fields as ambiguous even when the facility name matches", () => {
  const result = evaluateConflation({
    route,
    cityFeatures: [
      feature("Bike Lane"),
      { type: "Feature", properties: { BICYCLE_FACILITY: "Bike Lane", LINE_TYPE: "Off-Street" }, geometry: { type: "LineString", coordinates: route.coordinates } },
    ],
    toleranceMeters: 10,
  });
  assert.equal(result.matchedMiles, 0);
  assert.equal(result.ambiguousMiles, result.routeMiles);
});

test("geometry helpers use meters and expand a route envelope", () => {
  assert.ok(pointToSegmentMeters([-97.743, 30.272], [-97.7431, 30.2672], [-97.7431, 30.2772]) > 5);
  assert.deepEqual(boundsForLine(route, 0.001), { west: -97.7441, south: 30.2662, east: -97.7421, north: 30.2782 });
});

test("elevation verification rejects missing and non-finite profiles", () => {
  assert.deepEqual(elevationSummary({ range_height: [[0, 100], [30, 110.5]] }), { samples: 2, minimumMeters: 100, maximumMeters: 110.5 });
  assert.throws(() => elevationSummary({ range_height: [[0, 100]] }), /no usable elevation profile/);
  assert.throws(() => elevationSummary({ range_height: [[0, 100], [30, null]] }), /non-finite elevation sample/);
});

test("report output retains per-connection failures", () => {
  const report = {
    generatedAt: "2026-08-04T00:00:00.000Z",
    cityDataset: "city-v1",
    routingGraph: "graph-v1",
    valhallaVersion: "3.7.0",
    valhallaImage: "sha256:test",
    osmExtract: { source: "test", date: "2026-08-01", md5: "abc" },
    toleranceMeters: 25,
    sampleSpacingMeters: 20,
    summary: reportSummary([{ id: "crossing", category: "crossing", status: "failed", error: "no route" }]),
    results: [{ id: "crossing", category: "crossing", status: "failed", error: "no route" }],
  };
  assert.match(markdownReport(report), /\| crossing \| crossing \| failed .* no route \|/);
  assert.match(markdownReport(report), /Successful connections: 0\/1/);
});

test("report summary aggregates categories and unambiguous City labels", () => {
  const summary = reportSummary([
    { status: "ok", category: "crossing", routeMiles: 2, matchedMiles: 1, ambiguousMiles: 0.25, unmatchedMiles: 0.75, facilityMiles: { Trail: 1 } },
    { status: "ok", category: "crossing", routeMiles: 1, matchedMiles: 0.25, ambiguousMiles: 0, unmatchedMiles: 0.75, facilityMiles: { Lane: 0.25 } },
  ]);
  assert.equal(summary.totals.coverageRatio, 0.4167);
  assert.equal(summary.categories.crossing.connections, 2);
  assert.deepEqual(summary.facilities, { Trail: 1, Lane: 0.25 });
});
