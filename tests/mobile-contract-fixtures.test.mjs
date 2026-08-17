import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FAIR_ACCURACY_METERS,
  GOOD_ACCURACY_METERS,
  isPlausibleLocationChange,
  locationFixAction,
  locationQuality,
  MAX_FIX_AGE_MS,
  MAX_USABLE_ACCURACY_METERS,
} from "../app/location-accuracy.js";

const contractsDirectory = join(dirname(fileURLToPath(import.meta.url)), "../mobile/contracts/v1");

function contract(name) {
  return JSON.parse(readFileSync(join(contractsDirectory, name), "utf8"));
}

function recursivelyFindKey(value, matcher) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => matcher(key) || recursivelyFindKey(child, matcher));
}

test("proposed native authentication fixtures keep browser CSRF protections separate", () => {
  const authentication = contract("authentication.json");

  assert.equal(authentication.version, "mobile-v1");
  assert.equal(authentication.status, "proposed");
  assert.equal(authentication.browserCompatibility.existingAuthBasePath, "/api/auth");
  assert.equal(authentication.browserCompatibility.mustRemainUnchanged, true);
  assert.equal(authentication.browserCompatibility.stateChangingRequestsRequire, "matchingSameOriginHeader");
  assert.equal(authentication.nativeAuthentication.accessToken.storage, "Keychain");
  assert.equal(authentication.nativeAuthentication.refreshToken.rotation, "required");
  assert.equal(authentication.nativeAuthentication.refreshToken.mayAuthenticateResourceRequests, false);
  assert.equal(authentication.nativeAuthentication.installationCredential.mayUseDeviceFingerprint, false);
  assert.deepEqual(authentication.credentialPlaceholders, ["$accessToken", "$refreshToken", "$installationCredential"]);

  for (const endpoint of authentication.endpoints) {
    assert.match(endpoint.path, /^\//u);
    assert.ok(["GET", "POST"].includes(endpoint.method));
    assert.ok([200, 201, 204].includes(endpoint.response.status));
  }
  assert.deepEqual(authentication.endpoints.map((endpoint) => endpoint.operation), [
    "bootstrapAnonymousInstallation",
    "restoreAnonymousInstallation",
    "refresh",
    "registerAnonymousUser",
    "login",
    "currentUser",
    "logout",
  ]);
});

test("mobile ride fixture retains ordered idempotent server-owned semantics", () => {
  const rides = contract("ride-history.json");

  assert.deepEqual(rides.authentication.acceptedModes, ["existingCookieSession", "nativeBearerAccessToken"]);
  assert.equal(rides.authentication.browserCookieMutationsRequireSameOrigin, true);
  assert.equal(rides.authentication.nativeBearerMutationsRequireSameOrigin, false);
  const idPattern = new RegExp(rides.identifiers.pattern, "u");
  assert.match(rides.identifiers.rideId, idPattern);
  assert.match(rides.identifiers.batchId, idPattern);
  assert.deepEqual(rides.operations.map((operation) => operation.method), ["POST", "POST", "POST"]);
  assert.ok(rides.invariants.includes("pointsPersistLocallyBeforeUpload"));
  assert.ok(rides.invariants.includes("batchRetriesAreIdempotent"));
  assert.ok(rides.invariants.includes("serverRemainsAuthoritativeForOwnershipAndValidation"));
});

test("routing fixture preserves the Worker-only and no-ETA client contract", () => {
  const routing = contract("routing.json");

  assert.equal(routing.status, "currentWorkerContract");
  assert.equal(routing.request.path, "/api/routes");
  assert.equal(routing.clientBoundary.callsWorkerOnly, true);
  assert.equal(routing.clientBoundary.mayCallProviderDirectly, false);
  assert.equal(recursivelyFindKey(routing.response, (key) => /eta|duration|arrival|time|speed/iu.test(key)), false);
  assert.equal(routing.response.route.geometry.type, "LineString");
  assert.ok(routing.response.route.divergenceCount >= 0);
});

test("GPS fixture remains aligned with the current browser safety policy", () => {
  const gps = contract("gps-policy.json");

  assert.deepEqual(gps.thresholds, {
    goodAccuracyMeters: GOOD_ACCURACY_METERS,
    fairAccuracyMeters: FAIR_ACCURACY_METERS,
    maxUsableAccuracyMeters: MAX_USABLE_ACCURACY_METERS,
    maxFixAgeMilliseconds: MAX_FIX_AGE_MS,
  });

  for (const sample of gps.samples) {
    assert.equal(locationQuality(sample.accuracyMeters, sample.ageMilliseconds), sample.expectedQuality, sample.name);
    assert.equal(locationFixAction(sample.accuracyMeters, sample.hasUsableFix, sample.ageMilliseconds), sample.expectedAction, sample.name);
  }

  for (const sample of gps.plausibleMovementSamples) {
    assert.equal(
      isPlausibleLocationChange(
        sample.distanceMeters,
        sample.elapsedMilliseconds,
        sample.previousAccuracyMeters,
        sample.nextAccuracyMeters,
      ),
      sample.expected,
    );
  }
});
