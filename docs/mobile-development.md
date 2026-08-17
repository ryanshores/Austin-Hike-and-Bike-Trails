# Mobile development guide

This guide applies to the Kotlin Multiplatform work tracked in
[#49](https://github.com/ryanshores/Austin-Hike-and-Bike-Trails/issues/49).
The first slice establishes contracts only. It does not add a buildable mobile
project or new Worker endpoints.

## Scope and branch discipline

Keep native work in focused branches from current `main`. Do not mix a mobile
scaffold, native authentication, background recording, map rendering, or
Android UI into one pull request. Feature branches may use an isolated preview;
they must not publish to the public production site.

The recommended delivery order is:

1. Architecture and contract fixtures.
2. KMP scaffold and unsigned iOS Simulator build.
3. Native authentication API and bearer ride access.
4. Shared GPS policy and offline ride recorder.
5. Core Location background recording.
6. SwiftUI/MapKit Ride Mode.
7. Atlas map, planning, and route guidance.
8. Account/history UI, then Android product work.

## Required local tooling for later implementation

- A Mac with a current Xcode installation for iOS compilation, Simulator use,
  and physical-device signing.
- A free Apple Account is sufficient for local device testing; provisioning is
  short-lived. TestFlight and App Store distribution are separate paid-program
  decisions.
- A JDK and Gradle wrapper supplied by the KMP scaffold.
- Node.js `>=22.13.0` for the existing Worker/web checks.

Never commit Apple signing identities, provisioning profiles, Keychain exports,
Cloudflare credentials, or provider URLs/secrets.

## Contracts before implementation

Read the proposed contracts in `mobile/contracts/v1/` before changing a native
client or Worker authentication path. They record the intentionally separate
browser-cookie and native-bearer modes.

When adding runtime mobile authentication:

- Keep browser cookie/session behavior and same-origin mutation protection.
- Use short-lived access tokens and rotating refresh tokens for native clients.
- Store credentials in Keychain, not user defaults or logs.
- Never use a refresh token as an `Authorization` bearer token.
- Keep anonymous native identity server-issued and random.
- Add deterministic tests for rotation, replay, user isolation, browser
  compatibility, and missing/invalid credentials before connecting Ride Mode.

The mobile app calls Atlas Worker APIs only. It does not receive private
routing, geocoding, ArcGIS, sidecar, or Cloudflare Access credentials.

## GPS policy and field verification

The KMP implementation must execute the samples in
`mobile/contracts/v1/gps-policy.json` unchanged. Preserve these safety rules:

- Wait for a usable first fix.
- Keep the last trustworthy fix when later quality weakens.
- Reject stale, coarse, and implausible fixes.
- Advance guidance and persist ride points only from accepted fixes.

Simulator tests are useful for logic but not evidence of background GPS. Before
reviewing background-recording work, perform a physical-iPhone test that
includes a locked screen, permission change, weak-GPS period, temporary loss of
network, restored connectivity, interrupted-ride recovery, and a clean stop.
Use public locations in test notes and diagnostics.

## Validation

The current documentation/fixture slice is validated by the normal repository
checks:

```bash
npm run lint
npm test
```

`npm test` includes `tests/mobile-contract-fixtures.test.mjs`, which checks that
the fixtures are well formed, contain only redacted credentials, preserve the
route no-ETA contract, and match the current JavaScript GPS policy. The KMP
scaffold slice must add equivalent Kotlin fixture tests and an unsigned iOS
Simulator build without removing these checks.
