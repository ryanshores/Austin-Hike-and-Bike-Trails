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

/// iOS-only location boundary for an explicitly started ride.
///
/// The adapter owns Core Location configuration and turns each callback into a
/// shared-policy decision. It deliberately does not persist or upload points;
/// that handoff is the recorder integration slice.
@MainActor
final class RideLocationAdapter: NSObject, @preconcurrency CLLocationManagerDelegate, ObservableObject {
    @Published private(set) var authorizationState: RideLocationAuthorizationState
    @Published private(set) var trackingState: RideLocationTrackingState = .idle
    @Published private(set) var latestDecision: GpsDecision?

    var onDecision: ((GpsDecision) -> Void)?

    private let locationManager: CLLocationManager
    private let nowMilliseconds: () -> Int64
    private var policyState = GpsPolicyState(lastAcceptedFix: nil)
    private var recordingRequested = false

    init(
        locationManager: CLLocationManager = CLLocationManager(),
        nowMilliseconds: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1_000) }
    ) {
        self.locationManager = locationManager
        self.nowMilliseconds = nowMilliseconds
        authorizationState = Self.authorizationState(for: locationManager.authorizationStatus)
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        locationManager.distanceFilter = 10
        locationManager.activityType = .fitness
        locationManager.pausesLocationUpdatesAutomatically = true
        locationManager.showsBackgroundLocationIndicator = true
    }

    func startRecording() {
        recordingRequested = true
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

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        authorizationState = Self.authorizationState(for: manager.authorizationStatus)
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
        trackingState = .unavailable
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
        onDecision?(decision)
    }

    private func beginLocationUpdates() {
        locationManager.allowsBackgroundLocationUpdates = true
        locationManager.startUpdatingLocation()
        trackingState = .recording
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
}
