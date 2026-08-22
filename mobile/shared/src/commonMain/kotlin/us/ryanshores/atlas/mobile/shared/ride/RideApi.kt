package us.ryanshores.atlas.mobile.shared.ride

interface RideApi {
    suspend fun createRide(accessToken: String, ride: ActiveRide): RideApiResult<CreateRideResponse>

    suspend fun uploadBatch(accessToken: String, batch: RideUploadBatch): RideApiResult<UploadBatchResponse>

    suspend fun completeRide(accessToken: String, rideId: String): RideApiResult<CompleteRideResponse>

    suspend fun refresh(refreshToken: String): RideApiResult<RefreshSessionResponse>

    suspend fun restoreAnonymousSession(
        installationCredential: String,
    ): RideApiResult<RestoreSessionResponse>
}

sealed class RideApiResult<out T> {
    data class Success<T>(val value: T) : RideApiResult<T>()

    data class HttpFailure(
        val statusCode: Int,
        val retryAfterSeconds: Long?,
    ) : RideApiResult<Nothing>()

    data object InvalidResponse : RideApiResult<Nothing>()
    data object Unavailable : RideApiResult<Nothing>()
}

data class CreateRideResponse(
    val rideId: String,
    val created: Boolean,
)

data class UploadBatchResponse(
    val acceptedPointCount: Long,
    val received: Boolean,
)

data class CompleteRideResponse(
    val rideId: String,
)

data class RefreshSessionResponse(
    val accessToken: String,
    val refreshToken: String,
)

data class RestoreSessionResponse(
    val accessToken: String,
    val refreshToken: String,
    val ownerId: String,
)
