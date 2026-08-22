package us.ryanshores.atlas.mobile.shared.ride

import app.cash.sqldelight.driver.native.NativeSqliteDriver
import co.touchlab.sqliter.DatabaseConfiguration
import kotlinx.coroutines.test.runTest
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import platform.Foundation.NSTemporaryDirectory
import platform.posix.remove
import us.ryanshores.atlas.mobile.shared.auth.NativeSession
import us.ryanshores.atlas.mobile.shared.auth.NativeSessionLoadResult
import us.ryanshores.atlas.mobile.shared.auth.NativeSessionStore
import us.ryanshores.atlas.mobile.shared.db.AtlasDatabase
import us.ryanshores.atlas.mobile.shared.gps.GpsQuality

class RideUploadCoordinatorTest {
    private val databaseNames = mutableListOf<String>()

    @AfterTest
    fun removeDatabases() {
        for (name in databaseNames) {
            val path = NSTemporaryDirectory() + name
            remove(path)
            remove("$path-shm")
            remove("$path-wal")
        }
        databaseNames.clear()
    }

    @Test
    fun refreshesOncePersistsRotationAndAcknowledgesOnlySuccessfulBatch() = runTest {
        val queue = createQueueWithPoint()
        val store = FakeSessionStore(session())
        val api = FakeRideApi().apply {
            createResults.add(RideApiResult.HttpFailure(401, null))
            createResults.add(successfulCreate())
            refreshResults.add(
                RideApiResult.Success(RefreshSessionResponse("access-two", "refresh-two")),
            )
        }
        val coordinator = coordinator(queue, api, store)

        val result = assertIs<RideSyncResult.RecordingSynced>(
            coordinator.synchronize(nowMilliseconds = 2_000, sessionOwnerId = OWNER_ID),
        )

        assertEquals(1, result.uploadedPointCount)
        assertEquals(listOf("access-one", "access-two"), api.createAccessTokens)
        assertEquals(listOf("refresh-one"), api.refreshTokens)
        assertEquals(listOf("access-two"), api.uploadAccessTokens)
        assertEquals(listOf(BATCH_ID), api.uploadBatchIds)
        assertTrue(queue.queuedPoints().isEmpty())
        val rotated = store.saved.single()
        assertEquals("access-two", rotated.accessToken)
        assertEquals("refresh-two", rotated.refreshToken)
        assertEquals("installation-one", rotated.installationCredential)
        queue.close()
    }

    @Test
    fun restoresAnonymousSessionWhenRefreshRotationResponseIsLost() = runTest {
        val queue = createQueueWithPoint()
        val store = FakeSessionStore(session())
        val api = FakeRideApi().apply {
            createResults.add(RideApiResult.HttpFailure(401, null))
            createResults.add(successfulCreate())
            refreshResults.add(RideApiResult.Unavailable)
            restoreResults.add(
                RideApiResult.Success(
                    RestoreSessionResponse("access-three", "refresh-three", OWNER_ID),
                ),
            )
        }
        val coordinator = coordinator(queue, api, store)

        assertIs<RideSyncResult.RecordingSynced>(
            coordinator.synchronize(nowMilliseconds = 2_000, sessionOwnerId = OWNER_ID),
        )

        assertEquals(listOf("refresh-one"), api.refreshTokens)
        assertEquals(listOf("installation-one"), api.restorationCredentials)
        assertEquals(listOf("access-one", "access-three"), api.createAccessTokens)
        assertEquals("access-three", store.saved.single().accessToken)
        assertTrue(queue.queuedPoints().isEmpty())
        queue.close()
    }

    @Test
    fun restoresAnonymousSessionWhenRotatedCredentialsCannotBeSaved() = runTest {
        val queue = createQueueWithPoint()
        val store = FakeSessionStore(session(), saveFailuresRemaining = 1)
        val api = FakeRideApi().apply {
            createResults.add(RideApiResult.HttpFailure(401, null))
            createResults.add(successfulCreate())
            refreshResults.add(
                RideApiResult.Success(RefreshSessionResponse("access-two", "refresh-two")),
            )
            restoreResults.add(
                RideApiResult.Success(
                    RestoreSessionResponse("access-three", "refresh-three", OWNER_ID),
                ),
            )
        }
        val coordinator = coordinator(queue, api, store)

        assertIs<RideSyncResult.RecordingSynced>(
            coordinator.synchronize(nowMilliseconds = 2_000, sessionOwnerId = OWNER_ID),
        )

        assertEquals(listOf("installation-one"), api.restorationCredentials)
        assertEquals(listOf("access-one", "access-three"), api.createAccessTokens)
        assertEquals("access-three", store.saved.single().accessToken)
        assertTrue(queue.queuedPoints().isEmpty())
        queue.close()
    }

    @Test
    fun doesNotBypassRefreshRateLimitThroughInstallationRestore() = runTest {
        val queue = createQueueWithPoint()
        val api = FakeRideApi().apply {
            createResults.add(RideApiResult.HttpFailure(401, null))
            refreshResults.add(RideApiResult.HttpFailure(429, 3))
        }
        val coordinator = coordinator(queue, api, FakeSessionStore(session()))

        val failed = assertIs<RideSyncResult.RecoverableFailure>(
            coordinator.synchronize(nowMilliseconds = 2_000, sessionOwnerId = OWNER_ID),
        )

        assertEquals(RideSyncPhase.REFRESH_SESSION, failed.phase)
        assertEquals(429, failed.statusCode)
        assertEquals(3, failed.retryAfterSeconds)
        assertTrue(api.restorationCredentials.isEmpty())
        queue.close()
    }

    @Test
    fun refusesInstallationRecoveryForADifferentOwner() = runTest {
        val queue = createQueueWithPoint()
        val store = FakeSessionStore(session())
        val api = FakeRideApi().apply {
            createResults.add(RideApiResult.HttpFailure(401, null))
            refreshResults.add(RideApiResult.Unavailable)
            restoreResults.add(
                RideApiResult.Success(
                    RestoreSessionResponse("access-other", "refresh-other", OTHER_OWNER_ID),
                ),
            )
        }
        val coordinator = coordinator(queue, api, store)

        val failed = assertIs<RideSyncResult.RecoverableFailure>(
            coordinator.synchronize(nowMilliseconds = 2_000, sessionOwnerId = OWNER_ID),
        )

        assertEquals(RideSyncPhase.REFRESH_SESSION, failed.phase)
        assertEquals(listOf("access-one"), api.createAccessTokens)
        assertTrue(store.saved.isEmpty())
        assertNull(queue.queuedPoints().single().batchId)
        queue.close()
    }

    @Test
    fun leavesStableBatchQueuedAfterFailureAndRetriesItWithoutRefreshing() = runTest {
        val queue = createQueueWithPoint()
        val store = FakeSessionStore(session())
        val api = FakeRideApi().apply {
            uploadResults.add(RideApiResult.HttpFailure(503, 2))
        }
        val coordinator = coordinator(queue, api, store)

        val failed = assertIs<RideSyncResult.RecoverableFailure>(
            coordinator.synchronize(nowMilliseconds = 2_000, sessionOwnerId = OWNER_ID),
        )
        assertEquals(RideSyncPhase.UPLOAD_BATCH, failed.phase)
        assertEquals(503, failed.statusCode)
        assertEquals(2, failed.retryAfterSeconds)
        assertEquals(BATCH_ID, queue.queuedPoints().single().batchId)
        assertTrue(store.saved.isEmpty())

        val retried = assertIs<RideSyncResult.RecordingSynced>(
            coordinator.synchronize(nowMilliseconds = 2_100, sessionOwnerId = OWNER_ID),
        )
        assertEquals(1, retried.uploadedPointCount)
        assertEquals(listOf(BATCH_ID, BATCH_ID), api.uploadBatchIds)
        assertTrue(queue.queuedPoints().isEmpty())
        queue.close()
    }

    @Test
    fun reportsAssignedBatchExpiredAfterWorkerRejectsItsStalePoints() = runTest {
        val queue = createQueueWithPoint()
        assertIs<NextUploadBatchResult.Ready>(
            queue.nextUploadBatch(BATCH_ID, nowMilliseconds = 2_000),
        )
        val api = FakeRideApi().apply {
            uploadResults.add(RideApiResult.HttpFailure(400, null))
        }
        val coordinator = coordinator(queue, api, FakeSessionStore(session()))

        val expired = assertIs<RideSyncResult.Expired>(
            coordinator.synchronize(
                nowMilliseconds = 1_100 + MAX_POINT_AGE_MILLISECONDS + 1,
                sessionOwnerId = OWNER_ID,
            ),
        )

        assertEquals(RIDE_ID, expired.rideId)
        assertEquals(1_100, expired.oldestRecordedAtMilliseconds)
        assertEquals(BATCH_ID, queue.queuedPoints().single().batchId)
        queue.close()
    }

    @Test
    fun completesStoppingRideOnlyAfterQueuedPointsAreAcknowledged() = runTest {
        val queue = createQueueWithPoint()
        queue.requestCompletion()
        val api = FakeRideApi()
        val coordinator = coordinator(queue, api, FakeSessionStore(session()))

        val completed = assertIs<RideSyncResult.RideCompleted>(
            coordinator.synchronize(nowMilliseconds = 2_000, sessionOwnerId = OWNER_ID),
        )

        assertEquals(RIDE_ID, completed.rideId)
        assertEquals(1, completed.uploadedPointCount)
        assertEquals(listOf("access-one"), api.completeAccessTokens)
        assertNull(queue.activeRide())
        queue.close()
    }

    @Test
    fun leavesBatchQueuedWhenServerDoesNotConfirmItsFinalSequence() = runTest {
        val queue = createQueueWithPoint()
        val api = FakeRideApi().apply {
            uploadResults.add(
                RideApiResult.Success(
                    UploadBatchResponse(acceptedPointCount = 0, received = true),
                ),
            )
        }
        val coordinator = coordinator(queue, api, FakeSessionStore(session()))

        val failed = assertIs<RideSyncResult.RecoverableFailure>(
            coordinator.synchronize(nowMilliseconds = 2_000, sessionOwnerId = OWNER_ID),
        )

        assertEquals(RideSyncPhase.UPLOAD_BATCH, failed.phase)
        assertEquals(BATCH_ID, queue.queuedPoints().single().batchId)
        queue.close()
    }

    @Test
    fun doesNotDeleteStoppingRideAfterMismatchedCompletionResponse() = runTest {
        val queue = createQueue()
        queue.beginRide(
            rideId = RIDE_ID,
            ownerId = OWNER_ID,
            startedAtMilliseconds = 1_000,
            nowMilliseconds = 1_000,
        )
        queue.requestCompletion()
        val api = FakeRideApi().apply {
            completeResults.add(
                RideApiResult.Success(CompleteRideResponse("ride-000000000002")),
            )
        }
        val coordinator = coordinator(queue, api, FakeSessionStore(session()))

        val failed = assertIs<RideSyncResult.RecoverableFailure>(
            coordinator.synchronize(nowMilliseconds = 2_000, sessionOwnerId = OWNER_ID),
        )

        assertEquals(RideSyncPhase.COMPLETE_RIDE, failed.phase)
        assertNotNull(queue.activeRide())
        queue.close()
    }

    @Test
    fun refreshFailureDoesNotAssignOrDeleteQueuedPoints() = runTest {
        val queue = createQueueWithPoint()
        val api = FakeRideApi().apply {
            createResults.add(RideApiResult.HttpFailure(401, null))
            refreshResults.add(RideApiResult.HttpFailure(409, 1))
        }
        val coordinator = coordinator(queue, api, FakeSessionStore(session()))

        val failed = assertIs<RideSyncResult.RecoverableFailure>(
            coordinator.synchronize(nowMilliseconds = 2_000, sessionOwnerId = OWNER_ID),
        )

        assertEquals(RideSyncPhase.REFRESH_SESSION, failed.phase)
        assertEquals(409, failed.statusCode)
        assertEquals(1, failed.retryAfterSeconds)
        assertNull(queue.queuedPoints().single().batchId)
        assertTrue(api.uploadBatchIds.isEmpty())
        queue.close()
    }

    @Test
    fun refusesIdentityChangesAndMissingSessionsBeforeNetworkUse() = runTest {
        val queue = createQueueWithPoint()
        val api = FakeRideApi()
        val store = FakeSessionStore(null)
        val coordinator = coordinator(queue, api, store)

        val mismatch = assertIs<RideSyncResult.IdentityMismatch>(
            coordinator.synchronize(nowMilliseconds = 2_000, sessionOwnerId = OTHER_OWNER_ID),
        )
        assertEquals(OWNER_ID, mismatch.activeOwnerId)
        assertIs<RideSyncResult.AuthenticationRequired>(
            coordinator.synchronize(nowMilliseconds = 2_000, sessionOwnerId = OWNER_ID),
        )
        assertTrue(api.createAccessTokens.isEmpty())
        queue.close()
    }

    @Test
    fun refusesStoredSessionForADifferentOwnerBeforeNetworkUse() = runTest {
        val queue = createQueueWithPoint()
        val api = FakeRideApi()
        val store = FakeSessionStore(
            NativeSession(
                accessToken = "access-other",
                refreshToken = "refresh-other",
                installationCredential = "installation-other",
                ownerId = OTHER_OWNER_ID,
            ),
        )
        val coordinator = coordinator(queue, api, store)

        val mismatch = assertIs<RideSyncResult.IdentityMismatch>(
            coordinator.synchronize(nowMilliseconds = 2_000, sessionOwnerId = OWNER_ID),
        )

        assertEquals(OWNER_ID, mismatch.activeOwnerId)
        assertEquals(OTHER_OWNER_ID, mismatch.sessionOwnerId)
        assertTrue(api.createAccessTokens.isEmpty())
        assertNull(queue.queuedPoints().single().batchId)
        queue.close()
    }

    private fun coordinator(
        queue: SqliteRideQueue,
        api: FakeRideApi,
        store: FakeSessionStore,
    ) = RideUploadCoordinator(queue, api, store) { BATCH_ID }

    private fun createQueueWithPoint(): SqliteRideQueue = createQueue().also { queue ->
        queue.beginRide(
            rideId = RIDE_ID,
            ownerId = OWNER_ID,
            startedAtMilliseconds = 1_000,
            nowMilliseconds = 1_000,
        )
        queue.append(
            AcceptedRidePoint(
                recordedAtMilliseconds = 1_100,
                latitude = 30.2672,
                longitude = -97.7431,
                accuracyMeters = 12.0,
                altitudeMeters = null,
                speedMetersPerSecond = null,
                headingDegrees = null,
                quality = GpsQuality.GOOD,
            ),
        )
    }

    private fun createQueue(): SqliteRideQueue {
        val databaseName = "atlas-ride-upload-${Random.nextLong().toString().replace('-', '0')}.db"
            .also(databaseNames::add)
        return SqliteRideQueue(
            NativeSqliteDriver(
                schema = AtlasDatabase.Schema,
                name = databaseName,
                onConfiguration = { configuration ->
                    configuration.copy(
                        extendedConfig = DatabaseConfiguration.Extended(
                            basePath = NSTemporaryDirectory(),
                        ),
                    )
                },
            ),
        )
    }

    private fun session() = NativeSession(
        accessToken = "access-one",
        refreshToken = "refresh-one",
        installationCredential = "installation-one",
        ownerId = OWNER_ID,
    )

    private class FakeSessionStore(
        initial: NativeSession?,
        private var saveFailuresRemaining: Int = 0,
    ) : NativeSessionStore {
        private var current = initial
        val saved = mutableListOf<NativeSession>()

        override fun load() = NativeSessionLoadResult(current)

        override fun save(session: NativeSession) {
            if (saveFailuresRemaining > 0) {
                saveFailuresRemaining -= 1
                error("Simulated session-store failure")
            }
            current = session
            saved.add(session)
        }

        override fun clear() {
            current = null
        }
    }

    private class FakeRideApi : RideApi {
        val createResults = ArrayDeque<RideApiResult<CreateRideResponse>>()
        val uploadResults = ArrayDeque<RideApiResult<UploadBatchResponse>>()
        val completeResults = ArrayDeque<RideApiResult<CompleteRideResponse>>()
        val refreshResults = ArrayDeque<RideApiResult<RefreshSessionResponse>>()
        val restoreResults = ArrayDeque<RideApiResult<RestoreSessionResponse>>()
        val createAccessTokens = mutableListOf<String>()
        val uploadAccessTokens = mutableListOf<String>()
        val completeAccessTokens = mutableListOf<String>()
        val refreshTokens = mutableListOf<String>()
        val restorationCredentials = mutableListOf<String>()
        val uploadBatchIds = mutableListOf<String>()

        override suspend fun createRide(
            accessToken: String,
            ride: ActiveRide,
        ): RideApiResult<CreateRideResponse> {
            createAccessTokens.add(accessToken)
            return createResults.removeFirstOrNull() ?: successfulCreate()
        }

        override suspend fun uploadBatch(
            accessToken: String,
            batch: RideUploadBatch,
        ): RideApiResult<UploadBatchResponse> {
            uploadAccessTokens.add(accessToken)
            uploadBatchIds.add(batch.batchId)
            return uploadResults.removeFirstOrNull()
                ?: RideApiResult.Success(
                    UploadBatchResponse(
                        acceptedPointCount = batch.points.last().sequence + 1,
                        received = true,
                    ),
                )
        }

        override suspend fun completeRide(
            accessToken: String,
            rideId: String,
        ): RideApiResult<CompleteRideResponse> {
            completeAccessTokens.add(accessToken)
            return completeResults.removeFirstOrNull()
                ?: RideApiResult.Success(CompleteRideResponse(rideId))
        }

        override suspend fun refresh(refreshToken: String): RideApiResult<RefreshSessionResponse> {
            refreshTokens.add(refreshToken)
            return refreshResults.removeFirstOrNull() ?: RideApiResult.HttpFailure(401, null)
        }

        override suspend fun restoreAnonymousSession(
            installationCredential: String,
        ): RideApiResult<RestoreSessionResponse> {
            restorationCredentials.add(installationCredential)
            return restoreResults.removeFirstOrNull() ?: RideApiResult.HttpFailure(401, null)
        }
    }

    private companion object {
        const val RIDE_ID = "ride-000000000001"
        const val OWNER_ID = "owner-00000000001"
        const val OTHER_OWNER_ID = "owner-00000000002"
        const val BATCH_ID = "batch-00000000001"
        const val MAX_POINT_AGE_MILLISECONDS = 24L * 60 * 60 * 1_000

        fun successfulCreate(): RideApiResult.Success<CreateRideResponse> =
            RideApiResult.Success(CreateRideResponse(RIDE_ID, created = true))
    }
}
