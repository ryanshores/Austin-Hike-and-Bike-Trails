import assert from "node:assert/strict";
import test from "node:test";

import {
  guidanceQualityCanAdvance,
  initialGuidanceProgress,
  MAX_PROGRESS_ADVANCE_MILES,
  prepareGuidanceRoute,
  updateGuidanceProgress,
} from "../app/route-guidance-progress.js";

const route = {
  geometry: {
    type: "LineString",
    coordinates: [
      [-97.75, 30.26],
      [-97.745, 30.26],
      [-97.74, 30.26],
      [-97.735, 30.26],
      [-97.73, 30.26],
    ],
  },
  totalMiles: 1.2,
  maneuvers: [
    { instruction: "Ride east.", distanceMiles: 0.6, beginShapeIndex: 0, endShapeIndex: 2 },
    { instruction: "Continue toward the park.", distanceMiles: 0.6, beginShapeIndex: 2, endShapeIndex: 4 },
  ],
  divergences: [{
    miles: 0.3,
    reason: "unprotected bike lane",
    minimumSafetyClass: 1,
    geometry: { type: "LineString", coordinates: [[-97.735, 30.26], [-97.73, 30.26]] },
  }],
};

test("accepted route points update remaining distance without moving progress backward", () => {
  const initial = initialGuidanceProgress(route);
  const halfway = updateGuidanceProgress(route, initial, { latitude: 30.26, longitude: -97.74 });
  const noisyBackward = updateGuidanceProgress(route, halfway, { latitude: 30.26, longitude: -97.741 });

  assert.ok(Math.abs(halfway.progressMiles - 0.6) < 0.01);
  assert.ok(Math.abs(halfway.remainingMiles - 0.6) < 0.01);
  assert.equal(noisyBackward.progressMiles, halfway.progressMiles);
  assert.equal(noisyBackward.remainingMiles, halfway.remainingMiles);
});

test("route measurements and divergence ranges are prepared once per route", () => {
  const first = prepareGuidanceRoute(route);
  const second = prepareGuidanceRoute(route);

  assert.equal(second, first);
  assert.equal(second.cumulativeMeters, first.cumulativeMeters);
  assert.equal(second.divergenceRanges, first.divergenceRanges);
});

test("maneuvers advance only after their route threshold is passed", () => {
  const initial = initialGuidanceProgress(route);
  const atThreshold = updateGuidanceProgress(route, initial, { latitude: 30.26, longitude: -97.74 });
  const passed = updateGuidanceProgress(route, atThreshold, { latitude: 30.26, longitude: -97.7397 });

  assert.equal(atThreshold.maneuverIndex, 0);
  assert.equal(passed.maneuverIndex, 1);
  assert.ok(passed.maneuverDistanceMiles < route.maneuvers[1].distanceMiles);
});

test("maneuvers without shape indices advance from cumulative maneuver miles", () => {
  const indexFreeRoute = {
    ...route,
    maneuvers: route.maneuvers.map((maneuver) => ({
      instruction: maneuver.instruction,
      distanceMiles: maneuver.distanceMiles,
    })),
  };
  const initial = initialGuidanceProgress(indexFreeRoute);
  const beforeThreshold = updateGuidanceProgress(indexFreeRoute, initial, { latitude: 30.26, longitude: -97.7401 });
  const passed = updateGuidanceProgress(indexFreeRoute, beforeThreshold, { latitude: 30.26, longitude: -97.7397 });

  assert.equal(beforeThreshold.maneuverIndex, 0);
  assert.ok(beforeThreshold.maneuverDistanceMiles < 0.02);
  assert.equal(passed.maneuverIndex, 1);
  assert.ok(passed.maneuverDistanceMiles < indexFreeRoute.maneuvers[1].distanceMiles);
});

test("lower-safety warnings appear before entry, remain active within, and clear after passing", () => {
  const initial = initialGuidanceProgress(route);
  const approaching = updateGuidanceProgress(route, initial, { latitude: 30.26, longitude: -97.7385 });
  const active = updateGuidanceProgress(route, approaching, { latitude: 30.26, longitude: -97.734 });
  const passed = updateGuidanceProgress(route, active, { latitude: 30.26, longitude: -97.73 });

  assert.equal(approaching.safetyWarning?.reason, "unprotected bike lane");
  assert.equal(approaching.safetyWarning?.active, false);
  assert.equal(active.safetyWarning?.active, true);
  assert.equal(passed.safetyWarning, null);
});

test("guidance changes only when the caller supplies an accepted point", () => {
  const initial = initialGuidanceProgress(route);
  const rejected = updateGuidanceProgress(
    route,
    initial,
    { latitude: 30.26, longitude: -97.735 },
    false,
  );

  assert.equal(rejected, initial);
});

test("poor fixes cannot advance precise guidance", () => {
  assert.equal(guidanceQualityCanAdvance("good"), true);
  assert.equal(guidanceQualityCanAdvance("fair"), true);
  assert.equal(guidanceQualityCanAdvance("poor"), false);
  assert.equal(guidanceQualityCanAdvance("unusable"), false);
});

test("precise fixes outside the route corridor retain the last guidance state", () => {
  const initial = initialGuidanceProgress(route);
  const offRoute = updateGuidanceProgress(route, initial, {
    accuracyMeters: 8,
    latitude: 30.261,
    longitude: -97.74,
  });

  assert.equal(offRoute, initial);
});

test("nearby later route legs cannot skip guidance at a self-crossing", () => {
  const crossingRoute = {
    geometry: {
      type: "LineString",
      coordinates: [
        [-97.75, 30.26],
        [-97.74, 30.26],
        [-97.74, 30.27],
        [-97.7501, 30.2601],
        [-97.73, 30.26],
      ],
    },
    totalMiles: 3,
    maneuvers: [
      { instruction: "Ride east.", distanceMiles: 0.8 },
      { instruction: "Turn north.", distanceMiles: 0.8 },
      { instruction: "Turn toward the crossing.", distanceMiles: 0.8 },
      { instruction: "Continue east.", distanceMiles: 0.6 },
    ],
    divergences: [],
  };
  const initial = initialGuidanceProgress(crossingRoute);
  const ambiguousFix = updateGuidanceProgress(crossingRoute, initial, {
    latitude: 30.2601,
    longitude: -97.7501,
  });

  assert.ok(ambiguousFix.progressMiles <= MAX_PROGRESS_ADVANCE_MILES + Number.EPSILON);
  assert.equal(ambiguousFix.maneuverIndex, 0);
});

test("overlapping divergence geometry matches the correct route traversal", () => {
  const overlappingRoute = {
    geometry: {
      type: "LineString",
      coordinates: [
        [-97.75, 30.26],
        [-97.74, 30.26],
        [-97.73, 30.26],
        [-97.74, 30.26],
        [-97.74, 30.27],
      ],
    },
    totalMiles: 3,
    maneuvers: [],
    divergences: [{
      miles: 0.8,
      reason: "lower-safety later leg",
      geometry: {
        type: "LineString",
        coordinates: [[-97.74, 30.26], [-97.74, 30.27]],
      },
    }],
  };
  const initial = initialGuidanceProgress(overlappingRoute);
  const firstVisit = updateGuidanceProgress(overlappingRoute, initial, {
    latitude: 30.26,
    longitude: -97.74,
  });
  const laterVisit = updateGuidanceProgress(
    overlappingRoute,
    { ...initial, progressMiles: 2.15, remainingMiles: 0.85 },
    { latitude: 30.2601, longitude: -97.74 },
  );

  assert.equal(firstVisit.safetyWarning, null);
  assert.equal(laterVisit.safetyWarning?.reason, "lower-safety later leg");
  assert.equal(laterVisit.safetyWarning?.active, true);
});
