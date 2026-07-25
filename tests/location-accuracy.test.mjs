import assert from "node:assert/strict";
import test from "node:test";

import {
  FAIR_ACCURACY_METERS,
  isPlausibleLocationChange,
  locationFixAction,
  locationQuality,
  MAX_USABLE_ACCURACY_METERS,
  smoothingWeight,
} from "../app/location-accuracy.js";

test("waits when the first location fix is coarse", () => {
  assert.equal(locationFixAction(4000, false), "wait-for-accurate-fix");
});

test("accepts a later accurate fix without restarting tracking", () => {
  assert.equal(locationFixAction(MAX_USABLE_ACCURACY_METERS, false), "use-fix");
});

test("keeps the last accurate position when a later fix is coarse", () => {
  assert.equal(locationFixAction(4000, true), "keep-last-fix");
});

test("rejects invalid accuracy values", () => {
  assert.equal(locationFixAction(Number.NaN, false), "wait-for-accurate-fix");
  assert.equal(locationFixAction(Number.POSITIVE_INFINITY, true), "keep-last-fix");
});

test("classifies GPS quality for the ride indicator", () => {
  assert.equal(locationQuality(12), "good");
  assert.equal(locationQuality(FAIR_ACCURACY_METERS), "fair");
  assert.equal(locationQuality(MAX_USABLE_ACCURACY_METERS), "poor");
  assert.equal(locationQuality(MAX_USABLE_ACCURACY_METERS + 1), "unusable");
  assert.equal(locationQuality(10, 16_000), "unusable");
});

test("rejects physically implausible GPS jumps", () => {
  assert.equal(isPlausibleLocationChange(45, 2_000, 10, 12), true);
  assert.equal(isPlausibleLocationChange(1_000, 2_000, 10, 12), false);
});

test("trusts accurate fixes more heavily when smoothing", () => {
  assert.ok(smoothingWeight(10) > smoothingWeight(65));
  assert.ok(smoothingWeight(65) > smoothingWeight(90));
});
