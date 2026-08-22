package us.ryanshores.atlas.mobile.shared.ride

import app.cash.sqldelight.driver.native.NativeSqliteDriver
import co.touchlab.sqliter.DatabaseConfiguration
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import platform.Foundation.NSTemporaryDirectory
import platform.posix.remove
import us.ryanshores.atlas.mobile.shared.db.AtlasDatabase
import us.ryanshores.atlas.mobile.shared.gps.GpsFixAction
import us.ryanshores.atlas.mobile.shared.gps.GpsPolicy
import us.ryanshores.atlas.mobile.shared.gps.GpsPolicyState
import us.ryanshores.atlas.mobile.shared.gps.RawLocationFix

class AcceptedFixRecorderTest {
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
    fun persistsOnlyTheFixAcceptedByTheSharedPolicy() {
        val queue = createQueue()
        queue.beginRide(RIDE_ID, OWNER_ID, startedAtMilliseconds = 1_000, nowMilliseconds = 1_000)
        val recorder = AcceptedFixRecorder(queue)
        val rejected = GpsPolicy.evaluate(
            state = GpsPolicyState(),
            fix = RawLocationFix(30.2672, -97.7431, 150.0, 1_100),
            nowMilliseconds = 1_100,
        )
        val accepted = GpsPolicy.evaluate(
            state = rejected.state,
            fix = RawLocationFix(30.2672, -97.7431, 12.0, 1_200),
            nowMilliseconds = 1_200,
        )

        assertEquals(GpsFixAction.WAIT_FOR_ACCURATE_FIX, rejected.action)
        assertIs<PersistAcceptedFixResult.Ignored>(recorder.persist(rejected))
        val persisted = assertIs<PersistAcceptedFixResult.Persisted>(recorder.persist(accepted))

        assertEquals(0, persisted.point.sequence)
        assertEquals(1, queue.queuedPointCount())
        assertEquals(accepted.acceptedFix, queue.queuedPoints().single().point.let {
            accepted.acceptedFix?.copy(
                latitude = it.latitude,
                longitude = it.longitude,
                accuracyMeters = it.accuracyMeters,
                timestampMilliseconds = it.recordedAtMilliseconds,
                quality = it.quality,
            )
        })
        queue.close()
    }

    private companion object {
        const val RIDE_ID = "ride-000000000001"
        const val OWNER_ID = "owner-00000000001"
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

    private fun newDatabaseName(): String = "atlas-accepted-fix-${Random.nextLong().toString().replace('-', '0')}.db"
        .also(databaseNames::add)
}
