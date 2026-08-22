# Atlas Mobile

This directory is the Kotlin Multiplatform foundation for native Android and
iOS hosts. Product features remain in the web app while the mobile contracts,
authentication design, and native implementation land in focused slices.

## Local checks

From this directory:

```sh
./gradlew :shared:allTests
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -project iosApp/AtlasMobile.xcodeproj -scheme AtlasMobile \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

The GPS contract at `contracts/v1/gps-policy.json` is the golden source for
both browser and shared Kotlin policy tests. From the repository root, run
`node scripts/generate-gps-policy-kotlin.mjs` after an intentional fixture
change; `npm test` verifies that the committed Kotlin fixture is current.

The Xcode project calls a Gradle task to build a static Kotlin framework for
the selected iOS architecture. No Apple signing identity is needed for
Simulator builds.

## Native session storage

The iOS host stores the complete native session as one generic-password
Keychain item. The item uses device-only, after-first-unlock accessibility so
an actively recording ride can refresh its session while the screen is locked,
without synchronizing credentials to another device. The adapter never writes
credentials to user defaults or logs. Each stored session includes its owner;
an installation credential is retained across token rotation only while that
owner remains unchanged.

## Offline ride persistence

The shared module uses SQLDelight with native SQLite drivers on iOS and Android.
`SqliteRideQueue` stores the single active ride and each accepted point in one
transaction before upload is attempted. Point sequences never reset during an
active ride, and an assigned upload batch keeps the same ID across retries and
process restarts. Only explicit batch acknowledgement removes queued points;
requesting completion retains the ride until its queue is empty.

Platform hosts construct the store with `IosRideQueueStoreFactory` or
`AndroidRideQueueStoreFactory`. Upload scheduling and lifecycle work remain
separate adapters and are not implied by the persistence layer.

## Ride upload coordination

`RideUploadCoordinator` creates the server ride idempotently, drains stable
ordered batches, and completes a stopping ride only after its local queue is
empty. A failed request leaves its assigned batch untouched for the next retry.
The coordinator rotates a Keychain-backed native session once after an access
token rejection, persists the new credentials before retrying, and refuses to
sync a ride whose stored owner differs from the current authenticated owner.
Native refresh retries return the same rotation during a bounded 35-second
replay window that covers the client's 30-second request timeout, allowing
anonymous and registered sessions to recover a lost response or failed Keychain
save. If that retry cannot recover an anonymous session, the coordinator
restores the same owner through the reusable Keychain installation credential.
A server rejection of an assigned batch whose points have aged past the upload
window is surfaced as expired without deleting the local points.

Platform lifecycle adapters decide when to call synchronization. They should
call it again after connectivity returns or background execution is granted;
the shared coordinator does not claim that either operating system guarantees
background network execution.

## Ride recovery and account changes

`RideRecoveryCoordinator` lets a host inspect the persisted queue after an app
or OS interruption without doing network work. For the same authenticated owner
it returns the active ride, its recording/stopping state, and the number of
queued points so the host can resume recording or synchronization once it has
an execution opportunity. Offline points remain local until a later successful
upload acknowledgement.

If the persisted ride belongs to a different owner, recovery returns
`IdentityChangeRequired` and leaves the queue unchanged. The host must present
an explicit discard decision; only that confirmed action may call
`discardForIdentityChange`. This prevents a sign-in change from silently
deleting a previous owner's local ride data.
