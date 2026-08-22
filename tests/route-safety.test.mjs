import assert from "node:assert/strict";
import test from "node:test";

import {
  SafetyClass,
  SafetyFinding,
  SafetyPreference,
  classifyRouteEdge,
  meetsSafetyPreference,
  rankRouteCandidates,
  summarizeRoute,
} from "../worker/route-safety.js";

const line = (start, end) => ({
  type: "LineString",
  coordinates: [start, end],
});

function edge(safetyClass, miles, extra = {}) {
  return {
    safetyClass,
    miles,
    finding: SafetyFinding.ATLAS,
    geometry: line([miles, 0], [miles + 0.1, 0]),
    ...extra,
  };
}

test("City safety labels are authoritative over conflicting OSM tags", () => {
  const separated = classifyRouteEdge({
    city: { LINE_TYPE: "Off-Street", BICYCLE_FACILITY: "Urban Trail" },
    osm: { highway: "primary", bicycle: "no" },
  });
  const protectedLane = classifyRouteEdge({
    city: { BICYCLE_FACILITY: "Protected Bike Lane wParking" },
    osm: { highway: "residential" },
  });
  const paintedLane = classifyRouteEdge({
    city: { BICYCLE_FACILITY: "Bike Lane", BIKE_LEVEL_OF_COMFORT: "High Comfort" },
  });
  const road = classifyRouteEdge({ city: { BICYCLE_FACILITY: "Wide Curb Lane" } });

  assert.deepEqual(
    [separated.safetyClass, protectedLane.safetyClass, paintedLane.safetyClass, road.safetyClass],
    [
      SafetyClass.FULLY_SEPARATED,
      SafetyClass.PROTECTED,
      SafetyClass.BIKE_FACILITY,
      SafetyClass.ANY_BICYCLE_LEGAL,
    ],
  );
  assert.equal(separated.finding, SafetyFinding.ATLAS);
  assert.equal(separated.source, "city");
  assert.equal(road.finding, SafetyFinding.KNOWN_LESS_SAFE);
});

test("OSM cycleway, separation, speed, surface, and ordinary-road rules are conservative", () => {
  const fixtures = [
    [{ highway: "cycleway", bicycle: "designated" }, SafetyClass.FULLY_SEPARATED],
    [{ highway: "primary", cycleway: "track" }, SafetyClass.PROTECTED],
    [{ highway: "secondary", cycleway: "lane" }, SafetyClass.BIKE_FACILITY],
    [{ highway: "residential", maxspeed: "20 mph", surface: "asphalt" }, SafetyClass.BIKE_FACILITY],
    [{ highway: "residential", maxspeed: "20 mph", surface: "sand" }, SafetyClass.ANY_BICYCLE_LEGAL],
    [{ highway: "residential", maxspeed: "35 mph", surface: "asphalt" }, SafetyClass.ANY_BICYCLE_LEGAL],
  ];

  for (const [osm, expected] of fixtures) {
    const result = classifyRouteEdge({ osm });
    assert.equal(result.safetyClass, expected);
    assert.equal(result.finding, SafetyFinding.NOT_IN_TRAILS_LIST);
  }
});

test("unknown, unmatched, prohibited, and hiking-only ways remain distinguishable", () => {
  const unknown = classifyRouteEdge();
  const unmatched = classifyRouteEdge({ osm: { highway: "service" } });
  const prohibited = classifyRouteEdge({ osm: { highway: "path", bicycle: "no" } });
  const hikingOnly = classifyRouteEdge({ osm: { highway: "footway" } });
  const bicycleFootway = classifyRouteEdge({ osm: { highway: "footway", bicycle: "designated" } });

  assert.equal(unknown.finding, SafetyFinding.UNKNOWN);
  assert.equal(unmatched.finding, SafetyFinding.NOT_IN_TRAILS_LIST);
  assert.equal(prohibited.finding, SafetyFinding.BICYCLE_PROHIBITED);
  assert.equal(prohibited.safetyClass, null);
  assert.equal(hikingOnly.finding, SafetyFinding.BICYCLE_PROHIBITED);
  assert.equal(bicycleFootway.safetyClass, SafetyClass.ANY_BICYCLE_LEGAL);
});

test("general access restrictions apply unless a bicycle-specific tag permits travel", () => {
  for (const access of ["no", "private", "customers", "delivery"]) {
    const prohibited = classifyRouteEdge({ osm: { highway: "service", access } });
    assert.equal(prohibited.finding, SafetyFinding.BICYCLE_PROHIBITED);
    assert.equal(prohibited.safetyClass, null);

    const bicycleOverride = classifyRouteEdge({
      osm: { highway: "service", access, bicycle: "yes" },
    });
    assert.notEqual(bicycleOverride.finding, SafetyFinding.BICYCLE_PROHIBITED);
    assert.equal(bicycleOverride.safetyClass, SafetyClass.ANY_BICYCLE_LEGAL);
  }
});

test("asymmetric cycleways use the traversed side and default to the weaker side", () => {
  const osm = {
    highway: "secondary",
    "cycleway:left": "track",
    "cycleway:right": "no",
  };

  assert.equal(
    classifyRouteEdge({ osm, travelDirection: "forward" }).safetyClass,
    SafetyClass.ANY_BICYCLE_LEGAL,
  );
  assert.equal(
    classifyRouteEdge({ osm, travelDirection: "backward" }).safetyClass,
    SafetyClass.PROTECTED,
  );
  assert.equal(
    classifyRouteEdge({ osm }).safetyClass,
    SafetyClass.ANY_BICYCLE_LEGAL,
  );
});

test("the four preferences enforce their ordered minimum safety classes", () => {
  const classes = Object.values(SafetyClass);
  const preferences = Object.values(SafetyPreference);

  preferences.forEach((preference, minimum) => {
    classes.forEach((safetyClass) => {
      assert.equal(
        meetsSafetyPreference({ safetyClass }, preference),
        safetyClass >= minimum,
        `${preference} against class ${safetyClass}`,
      );
    });
  });
});

test("adjacent below-threshold edges become one divergence with merged geometry", () => {
  const first = edge(SafetyClass.BIKE_FACILITY, 0.1, {
    reason: "unprotected bike lane",
    geometry: line([0, 0], [1, 0]),
  });
  const second = edge(SafetyClass.ANY_BICYCLE_LEGAL, 0.2, {
    finding: SafetyFinding.NOT_IN_TRAILS_LIST,
    geometry: line([1, 0], [2, 0]),
  });
  const accepted = edge(SafetyClass.PROTECTED, 0.4, {
    ascentFeet: 30,
    descentFeet: 12,
    geometry: line([2, 0], [3, 0]),
  });
  const last = edge(SafetyClass.BIKE_FACILITY, 0.05, {
    reason: "unprotected bike lane",
    geometry: line([3, 0], [4, 0]),
  });

  const summary = summarizeRoute(
    [first, second, accepted, last],
    SafetyPreference.PROTECTED_OR_SEPARATED,
  );

  assert.equal(summary.divergenceCount, 2);
  assert.ok(Math.abs(summary.divergenceMiles - 0.35) < Number.EPSILON * 2);
  assert.equal(summary.divergences[0].edgeCount, 2);
  assert.deepEqual(summary.divergences[0].geometry.coordinates, [[0, 0], [1, 0], [2, 0]]);
  assert.match(summary.divergences[0].reason, /unprotected bike lane/);
  assert.match(summary.divergences[0].reason, /not in the Austin Trails list/);
});

test("distance, climbing, descent, and mileage by class aggregate deterministically", () => {
  const summary = summarizeRoute([
    edge(SafetyClass.FULLY_SEPARATED, 1.2, { ascentFeet: 80, descentFeet: 5 }),
    edge(SafetyClass.PROTECTED, 0.3, { ascentFeet: 15, descentFeet: 40 }),
    edge(SafetyClass.BIKE_FACILITY, 0.5, { ascentFeet: 0, descentFeet: 20 }),
  ], SafetyPreference.ANY_BICYCLE_LEGAL);

  assert.equal(summary.totalMiles, 2);
  assert.equal(summary.totalAscentFeet, 95);
  assert.equal(summary.totalDescentFeet, 65);
  assert.equal(summary.mileageBySafetyClass[SafetyClass.FULLY_SEPARATED], 1.2);
  assert.equal(summary.mileageBySafetyClass[SafetyClass.PROTECTED], 0.3);
  assert.equal(summary.mileageBySafetyClass[SafetyClass.BIKE_FACILITY], 0.5);
});

test("candidate ranking prioritizes fallback, exposure, distance, then climbing", () => {
  const preference = SafetyPreference.PROTECTED_OR_SEPARATED;
  const candidate = (id, edges, trafficExposureCost) => ({ id, edges, trafficExposureCost });
  const safeLong = candidate("safe-long", [
    edge(SafetyClass.PROTECTED, 3, { ascentFeet: 100 }),
  ], 5);
  const unsafeShort = candidate("unsafe-short", [
    edge(SafetyClass.BIKE_FACILITY, 0.1),
    edge(SafetyClass.PROTECTED, 1),
  ], 1);
  const safeExposed = candidate("safe-exposed", [
    edge(SafetyClass.PROTECTED, 2),
  ], 10);
  const safeBest = candidate("safe-best", [
    edge(SafetyClass.PROTECTED, 2),
  ], 3);

  assert.deepEqual(
    rankRouteCandidates([unsafeShort, safeLong, safeExposed, safeBest], preference).map(({ id }) => id),
    ["safe-best", "safe-long", "safe-exposed", "unsafe-short"],
  );
});

test("a prohibited segment loses even when it is shorter and has fewer warnings", () => {
  const prohibited = {
    id: "prohibited",
    edges: [edge(null, 0.05, { finding: SafetyFinding.BICYCLE_PROHIBITED })],
    trafficExposureCost: 0,
  };
  const fallback = {
    id: "fallback",
    edges: [
      edge(SafetyClass.ANY_BICYCLE_LEGAL, 0.1),
      edge(SafetyClass.PROTECTED, 2),
      edge(SafetyClass.ANY_BICYCLE_LEGAL, 0.1),
    ],
    trafficExposureCost: 20,
  };

  assert.equal(
    rankRouteCandidates(
      [prohibited, fallback],
      SafetyPreference.FULLY_SEPARATED,
    )[0].id,
    "fallback",
  );
});

test("candidate ranking recomputes preference-dependent summaries from edges", () => {
  const staleSummary = summarizeRoute(
    [edge(SafetyClass.BIKE_FACILITY, 0.5)],
    SafetyPreference.BIKE_FACILITY_OR_SAFER,
  );
  const staleCandidate = {
    id: "stale",
    edges: [edge(SafetyClass.BIKE_FACILITY, 0.5)],
    summary: staleSummary,
    trafficExposureCost: 0,
  };
  const compliantCandidate = {
    id: "compliant",
    edges: [edge(SafetyClass.PROTECTED, 1)],
    trafficExposureCost: 10,
  };

  assert.deepEqual(
    rankRouteCandidates(
      [staleCandidate, compliantCandidate],
      SafetyPreference.PROTECTED_OR_SEPARATED,
    ).map(({ id }) => id),
    ["compliant", "stale"],
  );
});
