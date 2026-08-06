import assert from "node:assert/strict";
import test from "node:test";

import {
  formatFeet,
  formatMiles,
  normalizePlannedRoute,
  routeErrorMessage,
  SAFETY_OPTIONS,
} from "../app/route-planner-utils.js";

const geometry = {
  type: "LineString",
  coordinates: [[-97.75, 30.26], [-97.74, 30.27]],
};

test("planner exposes the four ordered safety preferences with bicycle-legal fallback", () => {
  assert.deepEqual(SAFETY_OPTIONS.map((option) => option.value), [
    "any-bicycle-legal",
    "bike-facility-or-safer",
    "protected-or-separated",
    "fully-separated",
  ]);
  assert.match(SAFETY_OPTIONS[0].note, /Regular streets/);
});

test("planner normalizes only route fields needed by the UI", () => {
  const route = normalizePlannedRoute({
    route: {
      geometry,
      totalMiles: 4.26,
      totalAscentFeet: 144.8,
      totalDescentFeet: 125,
      mileageBySafetyClass: { 0: 0.4, 1: 1.2, 2: 0.8, 3: 1.86 },
      divergenceCount: 1,
      divergenceMiles: 0.4,
      divergences: [{
        miles: 0.4,
        reason: "not in the Atlas trails list",
        geometry,
        minimumSafetyClass: 0,
      }],
      maneuvers: [{ instruction: "Hidden from this slice", duration: 20 }],
      duration: 900,
    },
  });

  assert.equal(route.totalMiles, 4.26);
  assert.equal(route.divergences[0].reason, "not in the Atlas trails list");
  assert.equal("duration" in route, false);
  assert.equal("maneuvers" in route, false);
});

test("planner rejects malformed geometry and inconsistent divergence counts", () => {
  assert.throws(() => normalizePlannedRoute({
    route: {
      geometry: { type: "LineString", coordinates: [[-97.75, 30.26]] },
      totalMiles: 1,
      totalAscentFeet: 0,
      totalDescentFeet: 0,
      mileageBySafetyClass: {},
      divergenceCount: 0,
      divergenceMiles: 0,
      divergences: [],
    },
  }), /invalid map geometry/);
  assert.throws(() => normalizePlannedRoute({
    route: {
      geometry,
      totalMiles: 1,
      totalAscentFeet: 0,
      totalDescentFeet: 0,
      mileageBySafetyClass: {},
      divergenceCount: 2,
      divergenceMiles: 0,
      divergences: [],
    },
  }), /invalid safety details/);
});

test("planner formats route measurements without ETA wording", () => {
  assert.equal(formatMiles(4.26), "4.3 mi");
  assert.equal(formatMiles(0.04), "<0.1 mi");
  assert.equal(formatFeet(1234.6), "1,235 ft");
  assert.match(routeErrorMessage(422, { code: "no-reasonable-route" }), /No reasonable bicycle route/);
  assert.match(routeErrorMessage(503, {}), /not available in this environment/);
});
