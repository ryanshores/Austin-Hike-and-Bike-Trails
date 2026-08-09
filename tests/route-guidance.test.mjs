import assert from "node:assert/strict";
import test from "node:test";

import {
  loadRouteGuidance,
  ROUTE_GUIDANCE_MAX_AGE_MS,
  ROUTE_GUIDANCE_STORAGE_KEY,
  saveRouteGuidance,
} from "../app/route-guidance.js";

const now = Date.parse("2026-08-09T00:00:00Z");
const geometry = {
  type: "LineString",
  coordinates: [[-97.75, 30.26], [-97.74, 30.27]],
};
const guidance = {
  safetyPreference: "bike-facility-or-safer",
  endpoints: {
    start: { label: "Republic Square", latitude: 30.2675, longitude: -97.7469 },
    destination: { label: "Mueller Lake Park", latitude: 30.2984, longitude: -97.7058 },
  },
  route: {
    geometry,
    totalMiles: 4.2,
    totalAscentFeet: 120,
    totalDescentFeet: 100,
    mileageBySafetyClass: { 0: 0.2, 1: 1, 2: 1, 3: 2 },
    divergenceCount: 1,
    divergenceMiles: 0.2,
    divergences: [{
      miles: 0.2,
      reason: "not in the Atlas trails list",
      geometry,
      minimumSafetyClass: 0,
    }],
    maneuvers: [{
      type: 10,
      instruction: "Ride north on Guadalupe Street.",
      distanceMiles: 0.4,
      beginShapeIndex: 0,
      endShapeIndex: 1,
      streetNames: ["Guadalupe Street"],
      duration: 180,
    }],
    duration: 900,
  },
};

function memoryStorage(initialValue = null) {
  let value = initialValue;
  return {
    getItem(key) {
      assert.equal(key, ROUTE_GUIDANCE_STORAGE_KEY);
      return value;
    },
    setItem(key, next) {
      assert.equal(key, ROUTE_GUIDANCE_STORAGE_KEY);
      value = next;
    },
    removeItem(key) {
      assert.equal(key, ROUTE_GUIDANCE_STORAGE_KEY);
      value = null;
    },
    value() {
      return value;
    },
  };
}

test("guidance round-trips only allowlisted route data without ETA or duration", () => {
  const storage = memoryStorage();
  saveRouteGuidance(storage, guidance, now);

  assert.doesNotMatch(storage.value(), /duration|arrival|eta/i);
  const loaded = loadRouteGuidance(storage, now + 1000);
  assert.equal(loaded.endpoints.destination.label, "Mueller Lake Park");
  assert.equal(loaded.route.totalMiles, 4.2);
  assert.equal(loaded.route.maneuvers[0].instruction, "Ride north on Guadalupe Street.");
  assert.equal(loaded.safetyPreference, "bike-facility-or-safer");
});

test("guidance rejects unsupported, malformed, and stale payloads", () => {
  const validPayload = saveRouteGuidance(memoryStorage(), guidance, now);
  const cases = [
    { value: "not json", readAt: now },
    { value: JSON.stringify({ version: 2 }), readAt: now },
    {
      value: JSON.stringify({
        ...validPayload,
        endpoints: { start: null, destination: guidance.endpoints.destination },
      }),
      readAt: now,
    },
    {
      value: JSON.stringify(validPayload),
      readAt: now + ROUTE_GUIDANCE_MAX_AGE_MS + 1,
    },
  ];

  for (const { value, readAt } of cases) {
    const storage = memoryStorage(value);
    assert.equal(loadRouteGuidance(storage, readAt), null);
    assert.equal(storage.value(), null);
  }
});
