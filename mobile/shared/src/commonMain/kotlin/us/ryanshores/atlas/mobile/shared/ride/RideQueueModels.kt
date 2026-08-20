package us.ryanshores.atlas.mobile.shared.ride

import us.ryanshores.atlas.mobile.shared.gps.GpsQuality

enum class RideRecordingStatus(val wireValue: String) {
    RECORDING("recording"),
    STOPPING("stopping"),
}

data class ActiveRide(
    val rideId: String,
    val ownerId: String,
    val startedAtMilliseconds: Long,
    val status: RideRecordingStatus,
    val nextSequence: Long,
)

data class AcceptedRidePoint(
    val recordedAtMilliseconds: Long,
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Double,
    val altitudeMeters: Double?,
    val speedMetersPerSecond: Double?,
    val headingDegrees: Double?,
    val quality: GpsQuality,
)

data class QueuedRidePoint(
    val rideId: String,
    val sequence: Long,
    val batchId: String?,
    val point: AcceptedRidePoint,
)

data class RideUploadBatch(
    val rideId: String,
    val batchId: String,
    val points: List<QueuedRidePoint>,
)

sealed class BeginRideResult {
    data class Started(val ride: ActiveRide) : BeginRideResult()
    data class AlreadyActive(val ride: ActiveRide) : BeginRideResult()
}
