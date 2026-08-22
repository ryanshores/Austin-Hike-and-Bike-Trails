package us.ryanshores.atlas.mobile.shared.ride

/**
 * Reads persisted local ride state after an interruption without attempting a network request.
 *
 * Hosts should show [RideRecoveryState.IdentityChangeRequired] and obtain an explicit discard
 * decision before calling [discardForIdentityChange]. This prevents a newly signed-in user from
 * silently deleting a previous user's locally queued ride points.
 */
class RideRecoveryCoordinator(
    private val queue: SqliteRideQueue,
) {
    fun recover(sessionOwnerId: String): RideRecoveryState {
        requireValidOwnerId(sessionOwnerId)
        val active = queue.activeRide() ?: return RideRecoveryState.NoActiveRide
        if (active.ownerId != sessionOwnerId) {
            return RideRecoveryState.IdentityChangeRequired(
                ride = active,
                currentOwnerId = sessionOwnerId,
            )
        }
        return RideRecoveryState.Resumable(
            ride = active,
            queuedPointCount = queue.queuedPoints().size,
        )
    }

    fun discardForIdentityChange(
        rideId: String,
        previousOwnerId: String,
        currentOwnerId: String,
    ): Boolean {
        requireValidOwnerId(previousOwnerId)
        requireValidOwnerId(currentOwnerId)
        require(previousOwnerId != currentOwnerId) {
            "discardForIdentityChange requires a different current owner"
        }
        return queue.clearRideIfOwnedBy(rideId, previousOwnerId)
    }

    private fun requireValidOwnerId(ownerId: String) {
        require(ownerId.isNotBlank()) { "sessionOwnerId must not be blank" }
    }
}

sealed class RideRecoveryState {
    data object NoActiveRide : RideRecoveryState()

    data class Resumable(
        val ride: ActiveRide,
        val queuedPointCount: Int,
    ) : RideRecoveryState()

    data class IdentityChangeRequired(
        val ride: ActiveRide,
        val currentOwnerId: String,
    ) : RideRecoveryState()
}
