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
credentials to user defaults or logs.
