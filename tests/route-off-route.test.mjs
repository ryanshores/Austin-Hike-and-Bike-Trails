import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RouteOffRouteAlert } from "../app/route-off-route-alert.js";
import { initialGuidanceProgress, updateGuidanceProgress } from "../app/route-guidance-progress.js";
import {
  guidanceProgressAfterOffRouteCheck,
  initialOffRouteState,
  OFF_ROUTE_CONFIRMATION_SAMPLES,
  rerouteFixIsFresh,
  rerouteRequest,
  updateOffRouteState,
} from "../app/route-off-route.js";

const route = {
  geometry: {
    type: "LineString",
    coordinates: [[-97.75, 30.26], [-97.73, 30.26]],
  },
  totalMiles: 1.2,
  maneuvers: [],
  divergences: [],
};

const nearbyOffRoutePoint = {
  accuracyMeters: 10,
  latitude: 30.2605,
  longitude: -97.74,
};

test("off-route status requires multiple accepted samples near the route corridor", () => {
  let state = initialOffRouteState();
  for (let sample = 1; sample <= OFF_ROUTE_CONFIRMATION_SAMPLES; sample += 1) {
    state = updateOffRouteState(route, state, nearbyOffRoutePoint, 0.6);
    assert.equal(state.status, sample === OFF_ROUTE_CONFIRMATION_SAMPLES ? "off-route" : "checking");
  }
});

test("a trustworthy fix meaningfully far from the route confirms immediately", () => {
  const state = updateOffRouteState(route, initialOffRouteState(), {
    accuracyMeters: 10,
    latitude: 30.2612,
    longitude: -97.74,
  }, 0.6);

  assert.equal(state.status, "off-route");
  assert.ok(state.distanceMeters >= 120);
});

test("rejected fixes cannot declare or clear off-route status", () => {
  const initial = initialOffRouteState();
  const rejectedOutside = updateOffRouteState(route, initial, nearbyOffRoutePoint, 0.6, false);
  const confirmed = updateOffRouteState(route, {
    ...initial,
    status: "off-route",
    consecutiveOffRouteSamples: 3,
  }, {
    accuracyMeters: 10,
    latitude: 30.26,
    longitude: -97.74,
  }, 0.6, false);

  assert.equal(rejectedOutside, initial);
  assert.equal(confirmed.status, "off-route");
  assert.equal(confirmed.consecutiveOnRouteSamples, 0);
});

test("two accepted route matches clear a confirmed off-route state", () => {
  const confirmed = {
    ...initialOffRouteState(),
    status: "off-route",
    consecutiveOffRouteSamples: 3,
  };
  const point = { accuracyMeters: 10, latitude: 30.26, longitude: -97.74 };
  const firstMatch = updateOffRouteState(route, confirmed, point, 0.6);
  const secondMatch = updateOffRouteState(route, firstMatch, point, 0.6);

  assert.equal(firstMatch.status, "off-route");
  assert.equal(secondMatch.status, "on-route");
});

test("off-route matching ignores previously traversed and much-later route legs", () => {
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
    maneuvers: [],
    divergences: [],
  };

  const state = updateOffRouteState(crossingRoute, initialOffRouteState(), {
    accuracyMeters: 10,
    latitude: 30.2601,
    longitude: -97.7501,
  }, 0.25);

  assert.equal(state.status, "off-route");
  assert.ok(state.distanceMeters >= 120);
});

test("off-route samples cannot commit a projection jump to a later parallel leg", () => {
  const parallelRoute = {
    geometry: {
      type: "LineString",
      coordinates: [
        [-97.75, 30.26],
        [-97.74, 30.26],
        [-97.74, 30.28],
        [-97.75, 30.28],
        [-97.75, 30.27],
        [-97.73, 30.27],
      ],
    },
    totalMiles: 5,
    maneuvers: [],
    divergences: [],
  };
  const pointOnLaterLeg = {
    accuracyMeters: 10,
    latitude: 30.27,
    longitude: -97.74,
  };
  let trustedProgress = {
    ...initialGuidanceProgress(parallelRoute),
    progressMiles: 0.3,
    remainingMiles: 4.7,
  };
  let offRoute = initialOffRouteState();

  for (let sample = 0; sample < OFF_ROUTE_CONFIRMATION_SAMPLES; sample += 1) {
    const candidate = updateGuidanceProgress(parallelRoute, trustedProgress, pointOnLaterLeg);
    assert.ok(candidate.progressMiles > trustedProgress.progressMiles + 1);
    offRoute = updateOffRouteState(
      parallelRoute,
      offRoute,
      pointOnLaterLeg,
      trustedProgress.progressMiles,
    );
    const retained = guidanceProgressAfterOffRouteCheck(trustedProgress, candidate, offRoute);
    assert.equal(retained, trustedProgress);
    trustedProgress = retained;
  }

  assert.equal(offRoute.status, "off-route");
  assert.equal(trustedProgress.progressMiles, 0.3);
});

test("a trustworthy on-route fix can recover progress after a long signal gap", () => {
  const longRoute = {
    geometry: {
      type: "LineString",
      coordinates: [[-97.75, 30.26], [-97.65, 30.26]],
    },
    totalMiles: 5,
    maneuvers: [],
    divergences: [],
  };
  const trustedProgress = {
    ...initialGuidanceProgress(longRoute),
    progressMiles: 0.3,
    remainingMiles: 4.7,
  };
  const firstPoint = { accuracyMeters: 10, latitude: 30.26, longitude: -97.744, timestamp: 0 };
  const recoveredPoint = { accuracyMeters: 10, latitude: 30.26, longitude: -97.736, timestamp: 120_000 };
  const initialState = updateOffRouteState(longRoute, initialOffRouteState(), firstPoint, 0.3);
  const recoveredState = updateOffRouteState(longRoute, initialState, recoveredPoint, trustedProgress.progressMiles);
  const candidate = updateGuidanceProgress(longRoute, trustedProgress, recoveredPoint);
  const committed = guidanceProgressAfterOffRouteCheck(trustedProgress, candidate, recoveredState);

  assert.equal(recoveredState.status, "on-route");
  assert.equal(committed, candidate);
  assert.ok(committed.progressMiles > trustedProgress.progressMiles + 0.25);
});

test("rerouting requires a recent trustworthy fix timestamp", () => {
  const now = 100_000;

  assert.equal(rerouteFixIsFresh({ timestamp: now - 15_000 }, now), true);
  assert.equal(rerouteFixIsFresh({ timestamp: now - 15_001 }, now), false);
  assert.equal(rerouteFixIsFresh({ timestamp: now + 1 }, now), false);
  assert.equal(rerouteFixIsFresh({}, now), false);
});

test("reroute requests preserve destination and safety preference", () => {
  const request = rerouteRequest({
    safetyPreference: "protected-or-separated",
    endpoints: {
      start: { label: "Original start", latitude: 30.25, longitude: -97.76 },
      destination: { label: "Destination", latitude: 30.28, longitude: -97.72 },
    },
  }, {
    accuracyMeters: 12,
    latitude: 30.27,
    longitude: -97.74,
  });

  assert.deepEqual(request, {
    start: { latitude: 30.27, longitude: -97.74 },
    destination: { latitude: 30.28, longitude: -97.72 },
    safetyPreference: "protected-or-separated",
  });
});

test("the off-route alert exposes only an explicit reroute action", () => {
  const html = renderToStaticMarkup(RouteOffRouteAlert({
    busy: false,
    fixFresh: true,
    message: "",
    onReroute: () => {},
  }));

  assert.match(html, /role="alert"/);
  assert.match(html, /You appear to have left the highlighted route\./);
  assert.match(html, />Reroute</);
  assert.doesNotMatch(html, /automatically/i);
});

test("the reroute action is disabled while waiting for a fresh fix", () => {
  const html = renderToStaticMarkup(RouteOffRouteAlert({
    busy: false,
    fixFresh: false,
    message: "",
    onReroute: () => {},
  }));

  assert.match(html, /Waiting for a fresh good or fair GPS fix/);
  assert.match(html, /disabled=""/);
  assert.match(html, />Waiting for GPS</);
});
