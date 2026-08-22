package us.ryanshores.atlas.mobile.shared.ride

import android.content.Context
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import us.ryanshores.atlas.mobile.shared.db.AtlasDatabase

class AndroidRideQueueStoreFactory(
    context: Context,
    private val databaseName: String = "atlas-rides.db",
) : RideQueueStoreFactory {
    private val applicationContext = context.applicationContext

    override fun create(): SqliteRideQueue = SqliteRideQueue(
        AndroidSqliteDriver(AtlasDatabase.Schema, applicationContext, databaseName),
    )
}
