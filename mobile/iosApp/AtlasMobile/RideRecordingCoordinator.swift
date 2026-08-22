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
        let result = queue.beginRide(
            rideId: rideId,
            ownerId: ownerId,
            startedAtMilliseconds: startedAtMilliseconds,
            nowMilliseconds: nowMilliseconds
        )
        if queue.activeRide()?.ownerId == ownerId {
            locationAdapter.startRecording()
        }
        return result
    }

    @discardableResult
    func stopRide() -> ActiveRide? {
        guard queue.activeRide() != nil else { return nil }
        locationAdapter.stopRecording()
        return queue.requestCompletion()
    }

    func recoverRide(sessionOwnerId: String) -> RideRecoveryState {
        recoveryCoordinator.recover(sessionOwnerId: sessionOwnerId)
    }

    func applicationDidEnterBackground() {
        locationAdapter.applicationDidEnterBackground()
    }

    func applicationWillEnterForeground() {
        locationAdapter.applicationWillEnterForeground()
    }
}
