import AtlasShared
import CoreLocation
import XCTest
@testable import AtlasMobile

@MainActor
final class RideLocationAdapterTests: XCTestCase {
    func testBridgesCoreLocationIntoSharedGpsPolicy() {
        let adapter = RideLocationAdapter(nowMilliseconds: { 10_000 })
        let location = self.location(timestamp: 10)

        adapter.accept(location)

        XCTAssertTrue(adapter.latestDecision?.accepted ?? false)
        XCTAssertEqual(adapter.latestDecision?.acceptedFix?.latitude, 30.2672)
        XCTAssertEqual(adapter.latestDecision?.acceptedFix?.longitude, -97.7431)
        XCTAssertEqual(adapter.latestTrustedHeadingDegrees, 90)
    }

    func testDoesNotAcceptLocationCallbacksUntilRecordingWasExplicitlyStarted() {
        let adapter = RideLocationAdapter(nowMilliseconds: { 10_000 })
        let location = self.location(timestamp: 10)

        adapter.locationManager(CLLocationManager(), didUpdateLocations: [location])

        XCTAssertNil(adapter.latestDecision)
    }

    func testStartingANewRideClearsThePreviousRideGpsState() {
        let adapter = RideLocationAdapter(nowMilliseconds: { 10_000 })
        adapter.accept(location(timestamp: 10))
        XCTAssertNotNil(adapter.latestDecision)

        adapter.startRecording()

        XCTAssertNil(adapter.latestDecision)
    }

    func testUnusableFixRetainsTheLastTrustedMapPosition() {
        let adapter = RideLocationAdapter(nowMilliseconds: { 11_000 })
        adapter.accept(location(timestamp: 10))
        let trusted = adapter.latestTrustedFix

        let unusable = CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: 30.3, longitude: -97.7),
            altitude: 150,
            horizontalAccuracy: 150,
            verticalAccuracy: 8,
            course: 90,
            speed: 4,
            timestamp: Date(timeIntervalSince1970: 11)
        )
        adapter.accept(unusable)

        XCTAssertEqual(adapter.latestDecision?.action.wireValue, "keep-last-fix")
        XCTAssertEqual(adapter.latestTrustedFix?.latitude, trusted?.latitude)
        XCTAssertEqual(adapter.latestTrustedFix?.longitude, trusted?.longitude)
        XCTAssertEqual(adapter.latestTrustedHeadingDegrees, 90)
    }

    func testAcceptedFixWithoutAValidCourseRetainsTheLastTrustedHeading() {
        let adapter = RideLocationAdapter(nowMilliseconds: { 11_000 })
        adapter.accept(location(timestamp: 10, course: 90))

        adapter.accept(location(timestamp: 11, course: -1, courseAccuracy: -1))

        XCTAssertTrue(adapter.latestDecision?.accepted ?? false)
        XCTAssertEqual(adapter.latestTrustedHeadingDegrees, 90)
    }

    func testAcceptedFixWithInvalidCourseAccuracyRetainsTheLastTrustedHeading() {
        let adapter = RideLocationAdapter(nowMilliseconds: { 11_000 })
        adapter.accept(location(timestamp: 10, course: 90))

        adapter.accept(location(timestamp: 11, course: 135, courseAccuracy: -1))

        XCTAssertTrue(adapter.latestDecision?.accepted ?? false)
        XCTAssertEqual(adapter.latestTrustedHeadingDegrees, 90)
    }

    func testStaleRecoveredFixSeedsPolicyWithoutRecenteringTheMap() {
        var now: Int64 = 10_000
        let adapter = RideLocationAdapter(nowMilliseconds: { now })
        adapter.accept(location(timestamp: 10))
        let persisted = adapter.latestTrustedFix
        XCTAssertNotNil(persisted)

        now = 30_000
        adapter.resumeRecording(lastAcceptedFix: persisted)

        XCTAssertNil(adapter.latestTrustedFix)
    }

    func testTransientLocationErrorRetainsTheCurrentTrackingState() {
        let adapter = RideLocationAdapter()
        adapter.startRecording()
        let stateBeforeError = adapter.trackingState

        adapter.locationManager(CLLocationManager(), didFailWithError: CLError(.locationUnknown))

        XCTAssertEqual(adapter.trackingState, stateBeforeError)
    }

    func testBackgroundLifecycleDoesNotStopAnActiveRecorder() {
        let adapter = RideLocationAdapter()

        adapter.applicationDidEnterBackground()

        XCTAssertEqual(adapter.executionState, .background)
        XCTAssertEqual(adapter.trackingState, .idle)

        adapter.applicationWillEnterForeground()

        XCTAssertEqual(adapter.executionState, .foreground)
    }

    func testIdentityMismatchedRecoveredRideCannotBeStopped() {
        let queue = IosRideQueueStoreFactory(databaseName: "ride-coordinator-\(UUID().uuidString).db").create()
        defer { queue.close() }
        let coordinator = RideRecordingCoordinator(queue: queue, nowMilliseconds: { 10_000 })
        _ = queue.beginRide(
            rideId: "ride-000000000001",
            ownerId: "owner-00000000001",
            startedAtMilliseconds: 10_000,
            nowMilliseconds: 10_000
        )

        coordinator.resumeActiveRide(sessionOwnerId: "owner-00000000002")

        XCTAssertNotNil(coordinator.identityBlockedRide)
        XCTAssertNil(coordinator.stopRide())
        XCTAssertEqual(queue.activeRide()?.status.wireValue, "recording")
    }

    private func location(
        timestamp: TimeInterval,
        course: CLLocationDirection = 90,
        courseAccuracy: CLLocationDirectionAccuracy = 12
    ) -> CLLocation {
        CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: 30.2672, longitude: -97.7431),
            altitude: 150,
            horizontalAccuracy: 12,
            verticalAccuracy: 8,
            course: course,
            courseAccuracy: courseAccuracy,
            speed: 4,
            speedAccuracy: 1,
            timestamp: Date(timeIntervalSince1970: timestamp)
        )
    }
}
