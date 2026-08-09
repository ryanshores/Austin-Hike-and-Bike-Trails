import assert from "node:assert/strict";
import test from "node:test";

import {
  initialGuidanceProgress,
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

test("maneuvers advance only after their route threshold is passed", () => {
  const initial = initialGuidanceProgress(route);
  const atThreshold = updateGuidanceProgress(route, initial, { latitude: 30.26, longitude: -97.74 });
  const passed = updateGuidanceProgress(route, atThreshold, { latitude: 30.26, longitude: -97.7397 });

  assert.equal(atThreshold.maneuverIndex, 0);
  assert.equal(passed.maneuverIndex, 1);
  assert.ok(passed.maneuverDistanceMiles < route.maneuvers[1].distanceMiles);
});

test("lower-safety warnings appear before entry, remain active within, and clear after passing", () => {
  const initial = initialGuidanceProgress(route);
  const approaching = updateGuidanceProgress(route, initial, { latitude: 30.26, longitude: -97.7385 });
  const active = updateGuidanceProgress(route, approaching, { latitude: 30.26, longitude: -97.734 });
  const passed = updateGuidanceProgress(route, active, { latitude: 30.26, longitude: -97.7295 });

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
