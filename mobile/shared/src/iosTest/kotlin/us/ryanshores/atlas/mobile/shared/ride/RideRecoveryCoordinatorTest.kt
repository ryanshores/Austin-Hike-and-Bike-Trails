package us.ryanshores.atlas.mobile.shared.ride

import app.cash.sqldelight.driver.native.NativeSqliteDriver
import co.touchlab.sqliter.DatabaseConfiguration
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import platform.Foundation.NSTemporaryDirectory
import platform.posix.remove
import us.ryanshores.atlas.mobile.shared.db.AtlasDatabase
import us.ryanshores.atlas.mobile.shared.gps.GpsQuality

class RideRecoveryCoordinatorTest {
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
    fun recoversPersistedRecordingRideAndQueuedPointsAfterInterruption() {
        val databaseName = newDatabaseName()
        createQueue(databaseName).also { queue ->
            queue.beginRide(RIDE_ID, OWNER_ID, startedAtMilliseconds = 1_000, nowMilliseconds = 1_000)
            queue.append(point(recordedAt = 1_100, latitude = 30.2672))
            queue.append(point(recordedAt = 2_100, latitude = 30.2673))
            queue.close()
        }

        createQueue(databaseName).also { recoveredQueue ->
            val recovered = assertIs<RideRecoveryState.Resumable>(
                RideRecoveryCoordinator(recoveredQueue).recover(OWNER_ID),
            )

            assertEquals(RIDE_ID, recovered.ride.rideId)
            assertEquals(RideRecordingStatus.RECORDING, recovered.ride.status)
            assertEquals(2L, recovered.queuedPointCount)
            assertEquals(listOf(0L, 1L), recoveredQueue.queuedPoints().map { it.sequence })
            recoveredQueue.close()
        }
    }

    @Test
    fun requiresAnExplicitDiscardWhenTheAuthenticatedOwnerChanges() {
        val queue = createQueue()
        queue.beginRide(RIDE_ID, OWNER_ID, startedAtMilliseconds = 1_000, nowMilliseconds = 1_000)
        queue.append(point(recordedAt = 1_100, latitude = 30.2672))
        val recovery = RideRecoveryCoordinator(queue)

        val change = assertIs<RideRecoveryState.IdentityChangeRequired>(recovery.recover(OTHER_OWNER_ID))

        assertEquals(RIDE_ID, change.ride.rideId)
        assertEquals(OTHER_OWNER_ID, change.currentOwnerId)
        assertEquals(1, queue.queuedPoints().size)
        assertFalse(recovery.discardForIdentityChange(OTHER_RIDE_ID, OWNER_ID, OTHER_OWNER_ID))
        assertEquals(RIDE_ID, queue.activeRide()?.rideId)
        assertEquals(1, queue.queuedPoints().size)

        assertTrue(recovery.discardForIdentityChange(RIDE_ID, OWNER_ID, OTHER_OWNER_ID))
        assertNull(queue.activeRide())
        assertTrue(queue.queuedPoints().isEmpty())
        queue.close()
    }

    @Test
    fun refusesAnIdentityChangeDiscardForTheSameOwner() {
        val queue = createQueue()
        queue.beginRide(RIDE_ID, OWNER_ID, startedAtMilliseconds = 1_000, nowMilliseconds = 1_000)
        val recovery = RideRecoveryCoordinator(queue)

        kotlin.test.assertFailsWith<IllegalArgumentException> {
            recovery.discardForIdentityChange(RIDE_ID, OWNER_ID, OWNER_ID)
        }
        assertEquals(RIDE_ID, queue.activeRide()?.rideId)
        queue.close()
    }

    private companion object {
        const val RIDE_ID = "ride-000000000001"
        const val OTHER_RIDE_ID = "ride-000000000002"
        const val OWNER_ID = "owner-00000000001"
        const val OTHER_OWNER_ID = "owner-00000000002"
    }

    private fun createQueue(databaseName: String = newDatabaseName()): SqliteRideQueue = SqliteRideQueue(
        NativeSqliteDriver(
            schema = AtlasDatabase.Schema,
            name = databaseName,
            onConfiguration = { configuration ->
                configuration.copy(
                    extendedConfig = DatabaseConfiguration.Extended(basePath = NSTemporaryDirectory()),
                )
            },
        ),
    )

    private fun newDatabaseName(): String = "atlas-ride-recovery-${Random.nextLong().toString().replace('-', '0')}.db"
        .also(databaseNames::add)

    private fun point(recordedAt: Long, latitude: Double) = AcceptedRidePoint(
        recordedAtMilliseconds = recordedAt,
        latitude = latitude,
        longitude = -97.7431,
        accuracyMeters = 12.0,
        altitudeMeters = 150.0,
        speedMetersPerSecond = 4.0,
        headingDegrees = 90.0,
        quality = GpsQuality.GOOD,
    )
}
