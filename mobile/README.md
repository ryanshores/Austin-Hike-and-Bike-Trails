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

The Xcode project calls a Gradle task to build a static Kotlin framework for
the selected iOS architecture. No Apple signing identity is needed for
Simulator builds.
