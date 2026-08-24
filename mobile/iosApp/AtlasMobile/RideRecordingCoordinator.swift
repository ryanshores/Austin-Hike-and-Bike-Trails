import AtlasShared
import CoreLocation
import Foundation

/// Coordinates the platform location boundary with the shared active-ride queue.
///
/// A future authenticated Ride Mode host supplies the server-compatible ride and owner IDs after
/// a visible start action. This coordinator intentionally does not fabricate an identity or claim
/// that iOS can continue location delivery after a force quit.
@MainActor
final class RideRecordingCoordinator: ObservableObject {
    let locationAdapter: RideLocationAdapter

    @Published private(set) var activeRide: ActiveRide?
    @Published private(set) var queuedPointCount: Int64
    @Published private(set) var identityChangeRide: ActiveRide?

    private let queue: SqliteRideQueue
    private let recoveryCoordinator: RideRecoveryCoordinator

    init(
        queue: SqliteRideQueue,
        locationManager: CLLocationManager = CLLocationManager(),
        nowMilliseconds: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1_000) }
    ) {
        self.queue = queue
        recoveryCoordinator = RideRecoveryCoordinator(queue: queue)
        locationAdapter = RideLocationAdapter(
            locationManager: locationManager,
            acceptedFixRecorder: AcceptedFixRecorder(queue: queue),
            nowMilliseconds: nowMilliseconds
        )
        activeRide = queue.activeRide()
        queuedPointCount = queue.queuedPointCount()
        locationAdapter.onDecision = { [weak self] _ in
            self?.refreshQueueState()
        }
    }

    convenience init() {
        self.init(queue: IosRideQueueStoreFactory(databaseName: "atlas-rides.db").create())
    }

    @discardableResult
    func startRide(
        rideId: String,
        ownerId: String,
        startedAtMilliseconds: Int64,
        nowMilliseconds: Int64
    ) -> BeginRideResult {
        defer { refreshQueueState() }
        let existing = queue.activeRide()
        let result = queue.beginRide(
            rideId: rideId,
            ownerId: ownerId,
            startedAtMilliseconds: startedAtMilliseconds,
            nowMilliseconds: nowMilliseconds
        )
        guard let active = queue.activeRide(), active.ownerId == ownerId, active.status.wireValue == "recording" else {
            return result
        }
        if existing == nil {
            locationAdapter.startRecording()
        } else if existing?.rideId == rideId && existing?.ownerId == ownerId {
            locationAdapter.resumeRecording(lastAcceptedFix: acceptedFix(from: active))
        }
        return result
    }

    @discardableResult
    func stopRide() -> ActiveRide? {
        guard queue.activeRide() != nil else { return nil }
        locationAdapter.stopRecording()
        let ride = queue.requestCompletion()
        refreshQueueState()
        return ride
    }

    func recoverRide(sessionOwnerId: String) -> RideRecoveryState {
        let state = recoveryCoordinator.recover(sessionOwnerId: sessionOwnerId)
        refreshQueueState()
        return state
    }

    /// Resume a persisted recording only when it belongs to the verified current session.
    func resumeActiveRide(sessionOwnerId: String) {
        guard let active = queue.activeRide() else { return }
        guard active.ownerId == sessionOwnerId else {
            identityChangeRide = active
            return
        }
        guard active.status.wireValue == "recording" else { return }
        locationAdapter.resumeRecording(lastAcceptedFix: acceptedFix(from: active))
        refreshQueueState()
    }

    /// Call only after the host has shown an explicit identity-change discard decision.
    func discardRecoveredRideForIdentityChange(
        rideId: String,
        previousOwnerId: String,
        currentOwnerId: String
    ) -> Bool {
        guard let active = queue.activeRide(), active.rideId == rideId, active.ownerId == previousOwnerId else {
            return false
        }
        locationAdapter.stopRecording()
        let discarded = recoveryCoordinator.discardForIdentityChange(
            rideId: rideId,
            previousOwnerId: previousOwnerId,
            currentOwnerId: currentOwnerId
        )
        refreshQueueState()
        return discarded
    }

    func discardIdentityMismatchedRide(currentOwnerId: String) {
        guard let ride = identityChangeRide else { return }
        _ = discardRecoveredRideForIdentityChange(rideId: ride.rideId, previousOwnerId: ride.ownerId, currentOwnerId: currentOwnerId)
        identityChangeRide = nil
    }

    func dismissIdentityChangeNotice() { identityChangeRide = nil }

    func applicationDidEnterBackground() {
        locationAdapter.applicationDidEnterBackground()
    }

    func applicationWillEnterForeground() {
        locationAdapter.applicationWillEnterForeground()
    }

    private func acceptedFix(from ride: ActiveRide) -> AcceptedLocationFix? {
        guard
            let timestamp = ride.lastRecordedAtMilliseconds,
            let latitude = ride.lastLatitude,
            let longitude = ride.lastLongitude,
            let accuracy = ride.lastAccuracyMeters
        else {
            return nil
        }
        return AcceptedLocationFix(
            latitude: latitude.doubleValue,
            longitude: longitude.doubleValue,
            accuracyMeters: accuracy.doubleValue,
            timestampMilliseconds: timestamp.int64Value,
            quality: GpsPolicy.shared.quality(accuracyMeters: accuracy.doubleValue, ageMilliseconds: 0)
        )
    }

    private func refreshQueueState() {
        activeRide = queue.activeRide()
        queuedPointCount = queue.queuedPointCount()
    }
}
