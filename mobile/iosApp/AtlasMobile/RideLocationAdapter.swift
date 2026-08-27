import AtlasShared
import CoreLocation
import Foundation

enum RideLocationAuthorizationState: Equatable {
    case notDetermined
    case needsAlwaysAuthorization
    case authorized
    case unavailable
}

enum RideLocationTrackingState: Equatable {
    case idle
    case awaitingAuthorization
    case recording
    case stopped
    case unavailable
}

enum RideLocationPrecisionState: Equatable {
    case precise
    case reduced
    case unavailable
}

enum RideLocationExecutionState: Equatable {
    case foreground
    case background
}

/// iOS-only location boundary for an explicitly started ride.
///
/// The adapter owns Core Location configuration and turns each callback into a
/// shared-policy decision. It deliberately does not persist or upload points;
/// that handoff is the recorder integration slice.
@MainActor
final class RideLocationAdapter: NSObject, @preconcurrency CLLocationManagerDelegate, ObservableObject {
    @Published private(set) var authorizationState: RideLocationAuthorizationState
    @Published private(set) var precisionState: RideLocationPrecisionState
    @Published private(set) var executionState: RideLocationExecutionState = .foreground
    @Published private(set) var trackingState: RideLocationTrackingState = .idle
    @Published private(set) var latestDecision: GpsDecision?
    /// The only position the Ride Mode map may render as the rider's location.
    /// It is retained when later callbacks are coarse, stale, or implausible.
    @Published private(set) var latestTrustedFix: AcceptedLocationFix?
    /// Last valid course from an accepted location; callbacks without a valid course retain it.
    @Published private(set) var latestTrustedHeadingDegrees: CLLocationDirection?
    @Published private(set) var latestPersistenceResult: PersistAcceptedFixResult?

    var onDecision: ((GpsDecision) -> Void)?

    private let locationManager: CLLocationManager
    private let acceptedFixRecorder: AcceptedFixRecorder?
    private let nowMilliseconds: () -> Int64
    private var policyState = GpsPolicyState(lastAcceptedFix: nil)
    private var recordingRequested = false

    init(
        locationManager: CLLocationManager = CLLocationManager(),
        acceptedFixRecorder: AcceptedFixRecorder? = nil,
        nowMilliseconds: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1_000) }
    ) {
        self.locationManager = locationManager
        self.acceptedFixRecorder = acceptedFixRecorder
        self.nowMilliseconds = nowMilliseconds
        authorizationState = Self.authorizationState(for: locationManager.authorizationStatus)
        precisionState = Self.precisionState(for: locationManager)
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        locationManager.distanceFilter = 10
        locationManager.activityType = .fitness
        locationManager.pausesLocationUpdatesAutomatically = true
        locationManager.showsBackgroundLocationIndicator = true
    }

    func startRecording() {
        guard !recordingRequested else { return }
        beginRecording(policyState: GpsPolicyState(lastAcceptedFix: nil))
    }

    func resumeRecording(lastAcceptedFix: AcceptedLocationFix?) {
        guard !recordingRequested else { return }
        beginRecording(policyState: GpsPolicyState(lastAcceptedFix: lastAcceptedFix))
    }

    private func beginRecording(policyState: GpsPolicyState) {
        recordingRequested = true
        self.policyState = policyState
        latestTrustedFix = policyState.lastAcceptedFix.flatMap { isFreshForDisplay($0) ? $0 : nil }
        latestTrustedHeadingDegrees = nil
        latestDecision = nil
        latestPersistenceResult = nil
        switch locationManager.authorizationStatus {
        case .authorizedAlways:
            beginLocationUpdates()
        case .notDetermined, .authorizedWhenInUse:
            trackingState = .awaitingAuthorization
            locationManager.requestAlwaysAuthorization()
        case .denied, .restricted:
            trackingState = .unavailable
        @unknown default:
            trackingState = .unavailable
        }
        authorizationState = Self.authorizationState(for: locationManager.authorizationStatus)
    }

    func stopRecording() {
        recordingRequested = false
        locationManager.stopUpdatingLocation()
        locationManager.allowsBackgroundLocationUpdates = false
        trackingState = .stopped
    }

    /// Keep Core Location active while recording; the background location capability permits this.
    func applicationDidEnterBackground() {
        executionState = .background
    }

    func applicationWillEnterForeground() {
        executionState = .foreground
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        authorizationState = Self.authorizationState(for: manager.authorizationStatus)
        precisionState = Self.precisionState(for: manager)
        guard recordingRequested else { return }
        if manager.authorizationStatus == .authorizedAlways {
            beginLocationUpdates()
        } else if manager.authorizationStatus == .denied || manager.authorizationStatus == .restricted {
            trackingState = .unavailable
        } else {
            trackingState = .awaitingAuthorization
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard recordingRequested else { return }
        for location in locations {
            accept(location)
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if (error as? CLError)?.code == .denied {
            trackingState = .unavailable
        }
    }

    func accept(_ location: CLLocation) {
        let decision = GpsPolicy.shared.evaluate(
            state: policyState,
            fix: RawLocationFix(
                latitude: location.coordinate.latitude,
                longitude: location.coordinate.longitude,
                accuracyMeters: location.horizontalAccuracy,
                timestampMilliseconds: Int64(location.timestamp.timeIntervalSince1970 * 1_000)
            ),
            nowMilliseconds: nowMilliseconds()
        )
        policyState = decision.state
        latestDecision = decision
        if let acceptedFix = decision.acceptedFix {
            latestTrustedFix = acceptedFix
            if location.course.isFinite, location.course >= 0, location.course < 360, location.courseAccuracy >= 0 {
                latestTrustedHeadingDegrees = location.course
            }
        }
        latestPersistenceResult = acceptedFixRecorder?.persist(decision: decision)
        onDecision?(decision)
    }

    private func beginLocationUpdates() {
        locationManager.allowsBackgroundLocationUpdates = true
        locationManager.startUpdatingLocation()
        trackingState = .recording
    }

    /// A persisted fix can seed jump validation after recovery, but must never recenter the map
    /// once it falls outside the shared policy's usable-fix age.
    private func isFreshForDisplay(_ fix: AcceptedLocationFix) -> Bool {
        let ageMilliseconds = nowMilliseconds() - fix.timestampMilliseconds
        return ageMilliseconds >= 0 && GpsPolicy.shared.quality(
            accuracyMeters: fix.accuracyMeters,
            ageMilliseconds: ageMilliseconds
        ).wireValue != "unusable"
    }

    private static func authorizationState(for status: CLAuthorizationStatus) -> RideLocationAuthorizationState {
        switch status {
        case .notDetermined:
            .notDetermined
        case .authorizedAlways:
            .authorized
        case .authorizedWhenInUse:
            .needsAlwaysAuthorization
        case .denied, .restricted:
            .unavailable
        @unknown default:
            .unavailable
        }
    }

    private static func precisionState(for manager: CLLocationManager) -> RideLocationPrecisionState {
        guard manager.authorizationStatus == .authorizedAlways || manager.authorizationStatus == .authorizedWhenInUse else {
            return .unavailable
        }
        return manager.accuracyAuthorization == .fullAccuracy ? .precise : .reduced
    }
}
