import assert from "node:assert/strict";
import test from "node:test";

import { boundsForLine, evaluateConflation, pointToSegmentMeters } from "../scripts/conflation-evaluator.js";

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

test("geometry helpers use meters and expand a route envelope", () => {
  assert.ok(pointToSegmentMeters([-97.743, 30.272], [-97.7431, 30.2672], [-97.7431, 30.2772]) > 5);
  assert.deepEqual(boundsForLine(route, 0.001), { west: -97.7441, south: 30.2662, east: -97.7421, north: 30.2782 });
});
