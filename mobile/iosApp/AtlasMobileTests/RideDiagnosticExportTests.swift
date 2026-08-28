import XCTest
@testable import AtlasMobile

final class RideDiagnosticExportTests: XCTestCase {
    func testEncodesOnlyPrivacySafeFieldDiagnostics() throws {
        let snapshot = RideDiagnosticExport(
            exportedAt: Date(timeIntervalSince1970: 1_725_000_000),
            appVersion: "0.1 (1)",
            recordingState: "recording",
            locationAuthorization: "always",
            locationPrecision: "full",
            gpsDecision: "use-fix",
            gpsQuality: "good",
            hasTrustworthyPosition: true,
            trustworthyAccuracyMeters: 12.6,
            queuedPointCount: 4,
            activeRideState: "recording",
            identityChangeBlocked: false
        )

        let json = try XCTUnwrap(String(data: snapshot.jsonData(), encoding: .utf8))

        XCTAssertTrue(json.contains("\"schemaVersion\" : 1"))
        XCTAssertTrue(json.contains("\"trustworthyAccuracyMeters\" : 13"))
        XCTAssertTrue(json.contains("\"queuedPointCount\" : 4"))
        XCTAssertFalse(json.localizedCaseInsensitiveContains("token"))
        XCTAssertFalse(json.localizedCaseInsensitiveContains("owner"))
        XCTAssertFalse(json.localizedCaseInsensitiveContains("rideId"))
        XCTAssertFalse(json.localizedCaseInsensitiveContains("latitude"))
        XCTAssertFalse(json.localizedCaseInsensitiveContains("longitude"))
        XCTAssertFalse(json.localizedCaseInsensitiveContains("geometry"))
    }

    func testOmitsAccuracyWithoutATrustworthyPosition() throws {
        let snapshot = RideDiagnosticExport(
            exportedAt: .now,
            appVersion: "0.1 (1)",
            recordingState: "idle",
            locationAuthorization: "not-determined",
            locationPrecision: "unknown",
            gpsDecision: nil,
            gpsQuality: nil,
            hasTrustworthyPosition: false,
            trustworthyAccuracyMeters: nil,
            queuedPointCount: 0,
            activeRideState: nil,
            identityChangeBlocked: false
        )

        let json = try XCTUnwrap(String(data: snapshot.jsonData(), encoding: .utf8))

        XCTAssertFalse(json.contains("trustworthyAccuracyMeters"))
        XCTAssertFalse(json.contains("activeRideState"))
    }
}
