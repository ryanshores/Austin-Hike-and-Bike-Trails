import assert from "node:assert/strict";
import test from "node:test";

import {
  locationFixAction,
  MAX_USABLE_ACCURACY_METERS,
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
