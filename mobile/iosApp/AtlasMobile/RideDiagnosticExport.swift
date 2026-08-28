import Foundation

/// A field-test snapshot that is useful for debugging Ride Mode without exporting credentials,
/// identifiers, coordinates, or recorded geometry.
struct RideDiagnosticExport: Codable, Equatable {
    static let schemaVersion = 1

    let schemaVersion: Int
    let exportedAt: Date
    let appVersion: String
    let recordingState: String
    let locationAuthorization: String
    let locationPrecision: String
    let gpsDecision: String?
    let gpsQuality: String?
    let hasTrustworthyPosition: Bool
    let trustworthyAccuracyMeters: Int?
    let queuedPointCount: Int64
    let activeRideState: String?
    let identityChangeBlocked: Bool

    init(
        exportedAt: Date,
        appVersion: String,
        recordingState: String,
        locationAuthorization: String,
        locationPrecision: String,
        gpsDecision: String?,
        gpsQuality: String?,
        hasTrustworthyPosition: Bool,
        trustworthyAccuracyMeters: Double?,
        queuedPointCount: Int64,
        activeRideState: String?,
        identityChangeBlocked: Bool
    ) {
        self.schemaVersion = Self.schemaVersion
        self.exportedAt = exportedAt
        self.appVersion = appVersion
        self.recordingState = recordingState
        self.locationAuthorization = locationAuthorization
        self.locationPrecision = locationPrecision
        self.gpsDecision = gpsDecision
        self.gpsQuality = gpsQuality
        self.hasTrustworthyPosition = hasTrustworthyPosition
        self.trustworthyAccuracyMeters = trustworthyAccuracyMeters.map { Int($0.rounded()) }
        self.queuedPointCount = queuedPointCount
        self.activeRideState = activeRideState
        self.identityChangeBlocked = identityChangeBlocked
    }

    func jsonData() throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(self)
    }
}
