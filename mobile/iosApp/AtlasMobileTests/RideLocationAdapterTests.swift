import CoreLocation
import XCTest
@testable import AtlasMobile

@MainActor
final class RideLocationAdapterTests: XCTestCase {
    func testBridgesCoreLocationIntoSharedGpsPolicy() {
        let adapter = RideLocationAdapter(nowMilliseconds: { 10_000 })
        let location = CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: 30.2672, longitude: -97.7431),
            altitude: 150,
            horizontalAccuracy: 12,
            verticalAccuracy: 8,
            course: 90,
            speed: 4,
            timestamp: Date(timeIntervalSince1970: 10)
        )

        adapter.accept(location)

        XCTAssertTrue(adapter.latestDecision?.accepted ?? false)
        XCTAssertEqual(adapter.latestDecision?.acceptedFix?.latitude, 30.2672)
        XCTAssertEqual(adapter.latestDecision?.acceptedFix?.longitude, -97.7431)
    }

    func testDoesNotAcceptLocationCallbacksUntilRecordingWasExplicitlyStarted() {
        let adapter = RideLocationAdapter(nowMilliseconds: { 10_000 })
        let location = CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: 30.2672, longitude: -97.7431),
            altitude: 150,
            horizontalAccuracy: 12,
            verticalAccuracy: 8,
            course: 90,
            speed: 4,
            timestamp: Date(timeIntervalSince1970: 10)
        )

        adapter.locationManager(CLLocationManager(), didUpdateLocations: [location])

        XCTAssertNil(adapter.latestDecision)
    }
}
