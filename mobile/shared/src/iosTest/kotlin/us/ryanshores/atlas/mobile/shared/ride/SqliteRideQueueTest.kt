package us.ryanshores.atlas.mobile.shared.ride

import app.cash.sqldelight.driver.native.NativeSqliteDriver
import co.touchlab.sqliter.DatabaseConfiguration
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import platform.Foundation.NSTemporaryDirectory
import platform.posix.remove
import us.ryanshores.atlas.mobile.shared.db.AtlasDatabase
import us.ryanshores.atlas.mobile.shared.gps.GpsQuality

class SqliteRideQueueTest {
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
    fun beginsOneRideAndPersistsAcceptedPointsInSequence() {
        val queue = createQueue()

        val started = assertIs<BeginRideResult.Started>(
            queue.beginRide(RIDE_ID, OWNER_ID, startedAtMilliseconds = 1_000),
        ).ride
        assertEquals(0, started.nextSequence)
        assertNull(started.lastRecordedAtMilliseconds)

        val first = queue.append(point(recordedAt = 1_100, latitude = 30.2672))
        val second = queue.append(point(recordedAt = 1_200, latitude = 30.2673))
        assertEquals(0, first.sequence)
        assertEquals(1, second.sequence)
        assertEquals(listOf(first, second), queue.queuedPoints())
        assertEquals(2, queue.activeRide()?.nextSequence)
        assertEquals(1_200, queue.activeRide()?.lastRecordedAtMilliseconds)

        val existing = assertIs<BeginRideResult.AlreadyActive>(
            queue.beginRide(OTHER_RIDE_ID, OTHER_OWNER_ID, startedAtMilliseconds = 2_000),
        ).ride
        assertEquals(RIDE_ID, existing.rideId)
        assertEquals(OWNER_ID, existing.ownerId)
        queue.close()
    }

    @Test
    fun retriesTheSameStableBatchUntilItIsAcknowledged() {
        val queue = createQueue()
        queue.beginRide(RIDE_ID, OWNER_ID, startedAtMilliseconds = 1_000)
        repeat(3) { index ->
            queue.append(point(recordedAt = 1_100L + index, latitude = 30.2672 + index * 0.0001))
        }

        val firstAttempt = queue.nextUploadBatch(FIRST_BATCH_ID, maximumPoints = 2)
        val retry = queue.nextUploadBatch(SECOND_BATCH_ID, maximumPoints = 2)
        assertEquals(FIRST_BATCH_ID, firstAttempt?.batchId)
        assertEquals(listOf(0L, 1L), firstAttempt?.points?.map { it.sequence })
        assertEquals(firstAttempt, retry)
        assertEquals(2, queue.acknowledgeBatch(FIRST_BATCH_ID))

        val next = queue.nextUploadBatch(SECOND_BATCH_ID, maximumPoints = 2)
        assertEquals(SECOND_BATCH_ID, next?.batchId)
        assertEquals(listOf(2L), next?.points?.map { it.sequence })
        assertEquals(1, queue.acknowledgeBatch(SECOND_BATCH_ID))

        val afterAcknowledgement = queue.append(point(recordedAt = 1_200, latitude = 30.2676))
        assertEquals(3, afterAcknowledgement.sequence)
        queue.close()
    }

    @Test
    fun recoversRideQueueAndBatchAssignmentAfterReopeningDatabase() {
        val databaseName = newDatabaseName()
        createQueue(databaseName).also { queue ->
            queue.beginRide(RIDE_ID, OWNER_ID, startedAtMilliseconds = 1_000)
            queue.append(point(recordedAt = 1_100, latitude = 30.2672))
            queue.nextUploadBatch(FIRST_BATCH_ID)
            queue.requestCompletion()
            queue.close()
        }

        createQueue(databaseName).also { recovered ->
            assertEquals(RideRecordingStatus.STOPPING, recovered.activeRide()?.status)
            assertEquals(FIRST_BATCH_ID, recovered.nextUploadBatch(SECOND_BATCH_ID)?.batchId)
            assertFailsWith<IllegalStateException> {
                recovered.append(point(recordedAt = 1_200, latitude = 30.2673))
            }
            assertFalse(recovered.finishCompletionIfQueueEmpty())
            assertEquals(1, recovered.acknowledgeBatch(FIRST_BATCH_ID))
            assertTrue(recovered.finishCompletionIfQueueEmpty())
            assertNull(recovered.activeRide())
            recovered.close()
        }
    }

    @Test
    fun rejectsInvalidIdentifiersAndUnacceptedPointData() {
        val queue = createQueue()
        assertFailsWith<IllegalArgumentException> {
            queue.beginRide("short", OWNER_ID, startedAtMilliseconds = 1_000)
        }
        queue.beginRide(RIDE_ID, OWNER_ID, startedAtMilliseconds = 1_000)
        assertFailsWith<IllegalArgumentException> {
            queue.append(point(recordedAt = 1_100, latitude = 91.0))
        }
        assertFailsWith<IllegalArgumentException> {
            queue.append(point(recordedAt = 1_100, latitude = 30.2672, accuracy = 101.0))
        }
        assertFailsWith<IllegalArgumentException> {
            queue.append(
                point(
                    recordedAt = 1_100,
                    latitude = 30.2672,
                    accuracy = 12.0,
                    quality = GpsQuality.POOR,
                ),
            )
        }
        assertTrue(queue.queuedPoints().isEmpty())
        queue.close()
    }

    @Test
    fun rejectsBackwardTimestampsAfterAcknowledgementAndRestart() {
        val databaseName = newDatabaseName()
        createQueue(databaseName).also { queue ->
            queue.beginRide(RIDE_ID, OWNER_ID, startedAtMilliseconds = 1_000)
            queue.append(point(recordedAt = 1_200, latitude = 30.2672))
            queue.nextUploadBatch(FIRST_BATCH_ID)
            assertEquals(1, queue.acknowledgeBatch(FIRST_BATCH_ID))
            assertTrue(queue.queuedPoints().isEmpty())
            queue.close()
        }

        createQueue(databaseName).also { recovered ->
            assertEquals(1_200, recovered.activeRide()?.lastRecordedAtMilliseconds)
            assertFailsWith<IllegalArgumentException> {
                recovered.append(point(recordedAt = 1_199, latitude = 30.2673))
            }
            assertEquals(1, recovered.activeRide()?.nextSequence)
            assertTrue(recovered.queuedPoints().isEmpty())
            recovered.close()
        }
    }

    private fun createQueue(databaseName: String = newDatabaseName()): SqliteRideQueue = SqliteRideQueue(
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

    private fun newDatabaseName(): String = "atlas-ride-queue-${Random.nextLong().toString().replace('-', '0')}.db"
        .also(databaseNames::add)

    private fun point(
        recordedAt: Long,
        latitude: Double,
        accuracy: Double = 12.0,
        quality: GpsQuality = GpsQuality.GOOD,
    ) = AcceptedRidePoint(
        recordedAtMilliseconds = recordedAt,
        latitude = latitude,
        longitude = -97.7431,
        accuracyMeters = accuracy,
        altitudeMeters = 150.0,
        speedMetersPerSecond = 4.0,
        headingDegrees = 90.0,
        quality = quality,
    )

    private companion object {
        const val RIDE_ID = "ride-000000000001"
        const val OTHER_RIDE_ID = "ride-000000000002"
        const val OWNER_ID = "owner-00000000001"
        const val OTHER_OWNER_ID = "owner-00000000002"
        const val FIRST_BATCH_ID = "batch-00000000001"
        const val SECOND_BATCH_ID = "batch-00000000002"
    }
}
