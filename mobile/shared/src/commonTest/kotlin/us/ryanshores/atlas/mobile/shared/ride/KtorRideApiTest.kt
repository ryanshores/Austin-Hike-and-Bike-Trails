package us.ryanshores.atlas.mobile.shared.ride

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import us.ryanshores.atlas.mobile.shared.gps.GpsQuality
import us.ryanshores.atlas.mobile.shared.network.configureAtlasHttpClient

class KtorRideApiTest {
    @Test
    fun sendsBearerRideMutationsAndRefreshesOnlyThroughTheRefreshBody() = runTest {
        val engine = MockEngine { request ->
            val response = when (request.url.encodedPath) {
                "/api/rides" -> """{"ride":{"id":"$RIDE_ID"},"created":true}"""
                "/api/rides/$RIDE_ID/batches" ->
                    """{"acceptedPointCount":1,"distanceMeters":0,"received":true}"""
                "/api/rides/$RIDE_ID/complete" ->
                    """{"ride":{"id":"$RIDE_ID","status":"completed"}}"""
                "/api/mobile/v1/auth/refresh" ->
                    """{"accessToken":"access-two","refreshToken":"refresh-two"}"""
                else -> error("Unexpected path ${request.url.encodedPath}")
            }
            respond(
                content = response,
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val client = HttpClient(engine) { configureAtlasHttpClient() }
        val api = KtorRideApi("https://atlas.example/", client)
        val ride = activeRide()
        val batch = RideUploadBatch(
            rideId = RIDE_ID,
            batchId = BATCH_ID,
            points = listOf(
                QueuedRidePoint(
                    rideId = RIDE_ID,
                    sequence = 0,
                    batchId = BATCH_ID,
                    point = AcceptedRidePoint(
                        recordedAtMilliseconds = 1_000,
                        latitude = 30.2672,
                        longitude = -97.7431,
                        accuracyMeters = 12.0,
                        altitudeMeters = null,
                        speedMetersPerSecond = null,
                        headingDegrees = null,
                        quality = GpsQuality.GOOD,
                    ),
                ),
            ),
        )

        assertIs<RideApiResult.Success<CreateRideResponse>>(api.createRide("access-one", ride))
        assertIs<RideApiResult.Success<UploadBatchResponse>>(api.uploadBatch("access-one", batch))
        assertIs<RideApiResult.Success<CompleteRideResponse>>(api.completeRide("access-one", RIDE_ID))
        val refreshed = assertIs<RideApiResult.Success<RefreshSessionResponse>>(api.refresh("refresh-one"))
        assertEquals("access-two", refreshed.value.accessToken)

        assertEquals(4, engine.requestHistory.size)
        for (request in engine.requestHistory.take(3)) {
            assertEquals("Bearer access-one", request.headers[HttpHeaders.Authorization])
            assertNull(request.headers[HttpHeaders.Origin])
        }
        val refreshRequest = engine.requestHistory.last()
        assertNull(refreshRequest.headers[HttpHeaders.Authorization])
        assertNull(refreshRequest.headers[HttpHeaders.Origin])

        val createBody = jsonBody(engine.requestHistory[0])
        assertEquals(RIDE_ID, createBody["id"]?.jsonPrimitive?.content)
        assertEquals(1_000, createBody["startedAt"]?.jsonPrimitive?.content?.toLong())
        val batchBody = jsonBody(engine.requestHistory[1])
        assertEquals(BATCH_ID, batchBody["id"]?.jsonPrimitive?.content)
        val point = batchBody["points"]?.jsonArray?.single()?.jsonObject
        assertEquals("good", point?.get("quality")?.jsonPrimitive?.content)
        assertEquals("0", point?.get("sequence")?.jsonPrimitive?.content)
        val refreshBody = jsonBody(refreshRequest)
        assertEquals("refresh-one", refreshBody["refreshToken"]?.jsonPrimitive?.content)
        api.close()
    }

    @Test
    fun mapsFailureMetadataWithoutReturningServerDetails() = runTest {
        val engine = MockEngine {
            respond(
                content = """{"error":"internal credential detail"}""",
                status = HttpStatusCode.Unauthorized,
                headers = headersOf(HttpHeaders.RetryAfter, "1"),
            )
        }
        val api = KtorRideApi(
            "https://atlas.example",
            HttpClient(engine) { configureAtlasHttpClient() },
        )

        val result = assertIs<RideApiResult.HttpFailure>(
            api.createRide("access-one", activeRide()),
        )
        assertEquals(401, result.statusCode)
        assertEquals(1, result.retryAfterSeconds)
        api.close()
    }

    @Test
    fun requiresAnHttpsBaseUrl() {
        val client = HttpClient(MockEngine { error("No request expected") }) {
            configureAtlasHttpClient()
        }
        assertFailsWith<IllegalArgumentException> {
            KtorRideApi("http://atlas.example", client)
        }
        client.close()
    }

    private suspend fun jsonBody(request: io.ktor.client.request.HttpRequestData) =
        Json.parseToJsonElement(request.body.toByteArray().decodeToString()).jsonObject

    private fun activeRide() = ActiveRide(
        rideId = RIDE_ID,
        ownerId = OWNER_ID,
        startedAtMilliseconds = 1_000,
        status = RideRecordingStatus.RECORDING,
        nextSequence = 1,
        lastRecordedAtMilliseconds = 1_000,
        lastLatitude = 30.2672,
        lastLongitude = -97.7431,
        lastAccuracyMeters = 12.0,
    )

    private companion object {
        const val RIDE_ID = "ride-000000000001"
        const val OWNER_ID = "owner-00000000001"
        const val BATCH_ID = "batch-00000000001"
    }
}
