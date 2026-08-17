# Mobile architecture decision: iOS-first Kotlin Multiplatform

Issue: [#49](https://github.com/ryanshores/Austin-Hike-and-Bike-Trails/issues/49)

Status: accepted for implementation planning. The contracts in
`mobile/contracts/v1/` are proposed mobile API contracts; they do not add
runtime endpoints in this slice.

## Context

The browser Atlas already provides route planning, Ride Mode guidance, and
authenticated ride history through Cloudflare Worker endpoints. It cannot
reliably continue GPS recording while Safari is closed or the phone is locked.
The native application needs background location support without bypassing the
existing Worker, private routing/geocoding providers, or conservative GPS
policy.

The browser session model is deliberately web-specific: credentials live in
HttpOnly cookies and state-changing requests require a matching same-origin
`Origin` header. A native client cannot safely be treated as a browser merely
by copying those headers or embedding a secret in the app.

## Decision

Build an iOS-first Kotlin Multiplatform (KMP) application with a shared Kotlin
domain/data module and native platform shells.

| Concern | Shared Kotlin | iOS implementation | Later Android implementation |
| --- | --- | --- | --- |
| API models and client | Yes | URL/session transport adapter | Android transport adapter |
| Authentication state | Yes | Keychain credential store | Android secure credential store |
| GPS acceptance and smoothing policy | Yes | Core Location adapter | Fused Location adapter |
| Ride queue and upload ordering | Yes | SQLite/lifecycle adapter | SQLite/lifecycle adapter |
| Route normalization and guidance | Yes | SwiftUI state bridge | Compose state bridge |
| Map rendering and gesture behavior | No | MapKit | Selected Android map SDK |
| Background execution and permissions | No | Core Location/background modes | Foreground location service |
| UI | No for the first milestone | SwiftUI | Jetpack Compose |

The repository will add `mobile/shared`, `mobile/iosApp`, and
`mobile/androidApp` in the scaffold slice. This documentation-only slice keeps
the existing Node/Next/Worker application as the only runtime application.

## Network and provider boundary

The mobile client calls only the public Atlas origin. It must never call
Valhalla, Nominatim, ArcGIS, the routing-enrichment sidecar, or Cloudflare
Access-protected provider hostnames directly.

```text
iOS app -> Atlas Worker /api/* -> private providers
          \-> D1 ride and account data
```

Route and geocoding responses remain normalized by the Worker. The mobile app
must preserve unknown or incomplete safety information as unknown, retain the
selected safety preference when rerouting, and never surface ETA, arrival, or
duration wording.

## Native authentication boundary

The existing browser endpoints remain cookie-authenticated and retain their
same-origin mutation checks. A later, dedicated Worker slice will introduce a
versioned native API below `/api/mobile/v1/auth/*`.

Native sessions use a short-lived bearer access token and a rotating opaque
refresh token. iOS stores both in Keychain. A randomly generated,
server-issued installation credential establishes or restores an anonymous
native installation; no device fingerprint, advertising identifier, vendor
identifier, or embedded app secret is permitted.

Protected ride endpoints will accept exactly two authentication modes:

1. Existing browser cookie session plus the existing same-origin mutation
   requirement.
2. Verified `Authorization: Bearer <access token>` session for native clients.

The native bearer path must still perform active-session checks, user scoping,
D1-backed rate limiting, body validation, and refresh-token replay protection.
Refresh tokens are accepted only by the versioned refresh endpoint and never as
bearer credentials. A native endpoint must not set browser session cookies,
and no change may weaken browser CSRF/same-origin protections.

Anonymous browser and native installations are separate until a user registers
or signs in. Do not infer a shared identity from device information. A future
account-linking experience must be explicit.

## GPS and ride-recording boundary

The current browser policy is the initial KMP policy baseline:

- A first coarse or stale fix waits for a usable fix and does not move the map.
- A later coarse or stale fix keeps the last trustworthy position.
- Guidance, off-route checks, rerouting, and persistence consume accepted fixes
  only.
- Implausible movement is rejected before it affects displayed state or ride
  history.
- Server-side ride validation remains an independent defense.

The exact baseline samples and thresholds live in
`mobile/contracts/v1/gps-policy.json`. The fixture-validation test intentionally
executes them against `app/location-accuracy.js`; Kotlin must run the same
fixtures once the shared module exists. Threshold changes require a separate
documented behavior change and fixture update.

For iOS, Core Location is responsible for collecting raw locations and for the
background location lifecycle. Shared Kotlin decides whether a raw sample is
accepted. The app starts background recording only after a visible user action,
stops it promptly when a ride ends, and does not promise continuation after a
user force-quit.

## Local persistence and synchronization

The shared recorder owns active-ride state, monotonically increasing sequence
numbers, batch identifiers, and retry decisions. Platform adapters provide
SQLite storage, reachability/lifecycle notification, and secure credential
access.

Points must be committed locally before network upload. Upload batches are
ordered and idempotent. Network loss, token refresh, app backgrounding, and
process termination must leave recoverable local state rather than delete
points. The existing Worker remains authoritative for ownership, order,
plausible movement, and accepted GPS quality.

## Contract fixtures

The proposed mobile contracts are deliberately small and versioned:

- `authentication.json` describes the new native authentication surface and
  the browser compatibility boundary.
- `ride-history.json` describes bearer-authenticated ride creation, batching,
  and completion while retaining the existing payload semantics.
- `routing.json` records the normalized Worker-only planning contract and the
  no-ETA rule.
- `gps-policy.json` supplies cross-language golden samples for the shared
  accepted-fix policy.

Fixtures use placeholders such as `$accessToken`; they contain no usable
credentials, private routes, or provider URLs.

## Consequences

This approach avoids duplicating safety, upload, and API logic while preserving
native control of background execution and platform UX. It does introduce an
explicit authentication API evolution before native ride uploads can ship.

The first executable KMP scaffold must add unsigned iOS Simulator CI in
addition to—not instead of—the existing `npm run lint` and `npm test` checks.
Physical iPhone testing is mandatory for locked-screen recording, permission
changes, weak GPS, offline recovery, and battery impact.
