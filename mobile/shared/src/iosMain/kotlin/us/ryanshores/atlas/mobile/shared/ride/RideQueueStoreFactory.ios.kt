package us.ryanshores.atlas.mobile.shared.ride

import app.cash.sqldelight.driver.native.NativeSqliteDriver
import us.ryanshores.atlas.mobile.shared.db.AtlasDatabase

class IosRideQueueStoreFactory(
    private val databaseName: String = "atlas-rides.db",
) : RideQueueStoreFactory {
    override fun create(): SqliteRideQueue = SqliteRideQueue(
        NativeSqliteDriver(AtlasDatabase.Schema, databaseName),
    )
}
