package us.ryanshores.atlas.mobile.shared.ride

import us.ryanshores.atlas.mobile.shared.gps.GpsDecision

/** Persists only the location fix already accepted by the shared GPS policy. */
class AcceptedFixRecorder(
    private val queue: SqliteRideQueue,
) {
    fun persist(decision: GpsDecision): PersistAcceptedFixResult {
        val accepted = decision.acceptedFix ?: return PersistAcceptedFixResult.Ignored
        return PersistAcceptedFixResult.Persisted(
            queue.append(
                AcceptedRidePoint(
                    recordedAtMilliseconds = accepted.timestampMilliseconds,
                    latitude = accepted.latitude,
                    longitude = accepted.longitude,
                    accuracyMeters = accepted.accuracyMeters,
                    altitudeMeters = null,
                    speedMetersPerSecond = null,
                    headingDegrees = null,
                    quality = accepted.quality,
                ),
            ),
        )
    }
}

sealed class PersistAcceptedFixResult {
    data object Ignored : PersistAcceptedFixResult()

    data class Persisted(val point: QueuedRidePoint) : PersistAcceptedFixResult()
}
