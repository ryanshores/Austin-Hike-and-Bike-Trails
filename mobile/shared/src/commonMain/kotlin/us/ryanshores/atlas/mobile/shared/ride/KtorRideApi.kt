package us.ryanshores.atlas.mobile.shared.ride

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.Url
import io.ktor.http.contentType
import io.ktor.http.encodeURLPathPart
import io.ktor.http.isSuccess
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import us.ryanshores.atlas.mobile.shared.network.createPlatformAtlasHttpClient

class KtorRideApi(
    baseUrl: String,
    private val client: HttpClient = createPlatformAtlasHttpClient(),
) : RideApi {
    private val baseUrl = normalizeBaseUrl(baseUrl)

    override suspend fun createRide(
        accessToken: String,
        ride: ActiveRide,
    ): RideApiResult<CreateRideResponse> = execute {
        val response = client.post("$baseUrl/api/rides") {
            bearerAuth(accessToken)
            contentType(ContentType.Application.Json)
            setBody(CreateRideRequest(ride.rideId, ride.startedAtMilliseconds))
        }
        response.parse<RideEnvelope, CreateRideResponse> { body ->
            CreateRideResponse(body.ride.id, body.created)
        }
    }

    override suspend fun uploadBatch(
        accessToken: String,
        batch: RideUploadBatch,
    ): RideApiResult<UploadBatchResponse> = execute {
        val response = client.post(
            "$baseUrl/api/rides/${batch.rideId.encodeURLPathPart()}/batches",
        ) {
            bearerAuth(accessToken)
            contentType(ContentType.Application.Json)
            setBody(
                UploadBatchRequest(
                    id = batch.batchId,
                    points = batch.points.map { queued ->
                        val point = queued.point
                        UploadPointRequest(
                            sequence = queued.sequence,
                            recordedAt = point.recordedAtMilliseconds,
                            latitude = point.latitude,
                            longitude = point.longitude,
                            accuracyMeters = point.accuracyMeters,
                            altitudeMeters = point.altitudeMeters,
                            speedMetersPerSecond = point.speedMetersPerSecond,
                            headingDegrees = point.headingDegrees,
                            quality = point.quality.wireValue,
                        )
                    },
                ),
            )
        }
        response.parse<BatchEnvelope, UploadBatchResponse> { body ->
            UploadBatchResponse(body.acceptedPointCount, body.received)
        }
    }

    override suspend fun completeRide(
        accessToken: String,
        rideId: String,
    ): RideApiResult<CompleteRideResponse> = execute {
        val response = client.post(
            "$baseUrl/api/rides/${rideId.encodeURLPathPart()}/complete",
        ) {
            bearerAuth(accessToken)
        }
        response.parse<RideEnvelope, CompleteRideResponse> { body -> CompleteRideResponse(body.ride.id) }
    }

    override suspend fun refresh(refreshToken: String): RideApiResult<RefreshSessionResponse> = execute {
        val response = client.post("$baseUrl/api/mobile/v1/auth/refresh") {
            contentType(ContentType.Application.Json)
            setBody(RefreshRequest(refreshToken))
        }
        response.parse<RefreshEnvelope, RefreshSessionResponse> { body ->
            RefreshSessionResponse(body.accessToken, body.refreshToken)
        }
    }

    override suspend fun restoreAnonymousSession(
        installationCredential: String,
    ): RideApiResult<RestoreSessionResponse> = execute {
        val response = client.post("$baseUrl/api/mobile/v1/auth/installation/restore") {
            contentType(ContentType.Application.Json)
            setBody(InstallationRestoreRequest(installationCredential))
        }
        response.parse<RestoreEnvelope, RestoreSessionResponse> { body ->
            RestoreSessionResponse(body.accessToken, body.refreshToken, body.user.id)
        }
    }

    fun close() {
        client.close()
    }

    private suspend fun <T> execute(block: suspend () -> RideApiResult<T>): RideApiResult<T> = try {
        block()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Throwable) {
        RideApiResult.Unavailable
    }

    private suspend inline fun <reified Wire, T> io.ktor.client.statement.HttpResponse.parse(
        transform: (Wire) -> T,
    ): RideApiResult<T> {
        if (!status.isSuccess()) {
            return RideApiResult.HttpFailure(
                statusCode = status.value,
                retryAfterSeconds = headers[HttpHeaders.RetryAfter]?.toLongOrNull(),
            )
        }
        return try {
            RideApiResult.Success(transform(body<Wire>()))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            RideApiResult.InvalidResponse
        }
    }

    private fun normalizeBaseUrl(value: String): String {
        val normalized = value.trim().trimEnd('/')
        val url = Url(normalized)
        require(url.protocol.name == "https") { "baseUrl must use HTTPS" }
        require(url.host.isNotBlank()) { "baseUrl must include a host" }
        return normalized
    }

    @Serializable
    private data class CreateRideRequest(val id: String, val startedAt: Long)

    @Serializable
    private data class UploadBatchRequest(val id: String, val points: List<UploadPointRequest>)

    @Serializable
    private data class UploadPointRequest(
        val sequence: Long,
        val recordedAt: Long,
        val latitude: Double,
        val longitude: Double,
        val accuracyMeters: Double,
        val altitudeMeters: Double?,
        val speedMetersPerSecond: Double?,
        val headingDegrees: Double?,
        val quality: String,
    )

    @Serializable
    private data class RefreshRequest(val refreshToken: String)

    @Serializable
    private data class InstallationRestoreRequest(val installationCredential: String)

    @Serializable
    private data class RideEnvelope(val ride: RideWire, val created: Boolean = false)

    @Serializable
    private data class RideWire(val id: String)

    @Serializable
    private data class BatchEnvelope(
        val acceptedPointCount: Long,
        val received: Boolean,
    )

    @Serializable
    private data class RefreshEnvelope(val accessToken: String, val refreshToken: String)

    @Serializable
    private data class RestoreEnvelope(
        val accessToken: String,
        val refreshToken: String,
        val user: RestoreUser,
    )

    @Serializable
    private data class RestoreUser(val id: String)
}
