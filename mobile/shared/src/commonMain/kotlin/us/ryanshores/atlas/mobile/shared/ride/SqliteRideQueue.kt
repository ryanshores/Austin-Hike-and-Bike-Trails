package us.ryanshores.atlas.mobile.shared.ride

import app.cash.sqldelight.db.SqlDriver
import us.ryanshores.atlas.mobile.shared.db.AtlasDatabase
import us.ryanshores.atlas.mobile.shared.db.Queued_ride_point
import us.ryanshores.atlas.mobile.shared.gps.GpsPolicy
import us.ryanshores.atlas.mobile.shared.gps.GpsQuality

class SqliteRideQueue(
    private val driver: SqlDriver,
) {
    private val database = AtlasDatabase(driver)
    private val queries = database.rideQueueQueries

    fun activeRide(): ActiveRide? = queries.selectActiveRide(::mapActiveRide).executeAsOneOrNull()

    fun beginRide(
        rideId: String,
        ownerId: String,
        startedAtMilliseconds: Long,
    ): BeginRideResult {
        requireValidId(rideId, "rideId")
        requireValidId(ownerId, "ownerId")
        require(startedAtMilliseconds >= 0) { "startedAtMilliseconds must be nonnegative" }
        return database.transactionWithResult {
            val existing = activeRide()
            if (existing != null) return@transactionWithResult BeginRideResult.AlreadyActive(existing)
            queries.insertActiveRide(rideId, ownerId, startedAtMilliseconds)
            BeginRideResult.Started(checkNotNull(activeRide()))
        }
    }

    fun append(point: AcceptedRidePoint): QueuedRidePoint {
        validatePoint(point)
        return database.transactionWithResult {
            val active = checkNotNull(activeRide()) { "No active ride" }
            check(active.status == RideRecordingStatus.RECORDING) { "Ride is stopping" }
            require(point.recordedAtMilliseconds >= active.startedAtMilliseconds - 60_000) {
                "recordedAtMilliseconds is before the allowed recording window"
            }
            require(
                active.lastRecordedAtMilliseconds == null ||
                    point.recordedAtMilliseconds >= active.lastRecordedAtMilliseconds,
            ) { "recordedAtMilliseconds cannot move backward" }
            queries.insertPointAtNextSequence(
                recordedAt = point.recordedAtMilliseconds,
                latitude = point.latitude,
                longitude = point.longitude,
                accuracyMeters = point.accuracyMeters,
                altitudeMeters = point.altitudeMeters,
                speedMetersPerSecond = point.speedMetersPerSecond,
                headingDegrees = point.headingDegrees,
                quality = point.quality.wireValue,
            )
            queries.advanceSequence(point.recordedAtMilliseconds)
            QueuedRidePoint(active.rideId, active.nextSequence, null, point)
        }
    }

    fun queuedPoints(): List<QueuedRidePoint> {
        val active = activeRide() ?: return emptyList()
        return queries.selectQueuedPoints(active.rideId).executeAsList().map(::mapQueuedPoint)
    }

    fun nextUploadBatch(
        newBatchId: String,
        maximumPoints: Long = 100,
    ): RideUploadBatch? {
        requireValidId(newBatchId, "newBatchId")
        require(maximumPoints in 1..100) { "maximumPoints must be between 1 and 100" }
        return database.transactionWithResult {
            val active = activeRide() ?: return@transactionWithResult null
            val first = queries.selectFirstQueuedPoint(active.rideId).executeAsOneOrNull()
                ?: return@transactionWithResult null
            val batchId = first.batch_id ?: newBatchId.also {
                queries.assignNextBatch(it, active.rideId, maximumPoints)
            }
            val points = queries.selectBatch(active.rideId, batchId).executeAsList().map(::mapQueuedPoint)
            check(points.isNotEmpty()) { "Assigned upload batch is empty" }
            RideUploadBatch(active.rideId, batchId, points)
        }
    }

    fun acknowledgeBatch(batchId: String): Int {
        requireValidId(batchId, "batchId")
        val active = activeRide() ?: return 0
        return queries.deleteBatch(active.rideId, batchId).value.toInt()
    }

    fun requestCompletion(): ActiveRide {
        val active = checkNotNull(activeRide()) { "No active ride" }
        queries.markStopping(active.rideId)
        return checkNotNull(activeRide())
    }

    fun finishCompletionIfQueueEmpty(): Boolean {
        val active = activeRide() ?: return true
        if (active.status != RideRecordingStatus.STOPPING) return false
        return queries.deleteCompletedRideIfEmpty(active.rideId).value == 1L
    }

    fun clearRide(rideId: String): Boolean {
        requireValidId(rideId, "rideId")
        return database.transactionWithResult {
            queries.deletePointsForRide(rideId)
            queries.deleteActiveRide(rideId).value == 1L
        }
    }

    fun close() {
        driver.close()
    }

    private fun mapActiveRide(
        rideId: String,
        ownerId: String,
        startedAt: Long,
        status: String,
        nextSequence: Long,
        lastRecordedAt: Long?,
    ) = ActiveRide(
        rideId = rideId,
        ownerId = ownerId,
        startedAtMilliseconds = startedAt,
        status = RideRecordingStatus.entries.single { it.wireValue == status },
        nextSequence = nextSequence,
        lastRecordedAtMilliseconds = lastRecordedAt,
    )

    private fun mapQueuedPoint(row: Queued_ride_point) = QueuedRidePoint(
        rideId = row.ride_id,
        sequence = row.sequence,
        batchId = row.batch_id,
        point = AcceptedRidePoint(
            recordedAtMilliseconds = row.recorded_at,
            latitude = row.latitude,
            longitude = row.longitude,
            accuracyMeters = row.accuracy_meters,
            altitudeMeters = row.altitude_meters,
            speedMetersPerSecond = row.speed_meters_per_second,
            headingDegrees = row.heading_degrees,
            quality = GpsQuality.entries.single { it.wireValue == row.quality },
        ),
    )

    private fun requireValidId(value: String, name: String) {
        require(
            value.length in 16..128 && value.all {
                it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '_' || it == '-'
            },
        ) {
            "$name must be a valid Atlas identifier"
        }
    }

    private fun validatePoint(point: AcceptedRidePoint) {
        require(point.recordedAtMilliseconds >= 0) { "recordedAtMilliseconds must be nonnegative" }
        require(point.latitude.isFinite() && point.latitude in -90.0..90.0) { "latitude is invalid" }
        require(point.longitude.isFinite() && point.longitude in -180.0..180.0) { "longitude is invalid" }
        require(point.accuracyMeters.isFinite() && point.accuracyMeters in 0.0..100.0) { "accuracyMeters is invalid" }
        require(point.altitudeMeters == null || point.altitudeMeters.isFinite()) { "altitudeMeters is invalid" }
        require(
            point.speedMetersPerSecond == null ||
                point.speedMetersPerSecond.isFinite() && point.speedMetersPerSecond >= 0,
        ) { "speedMetersPerSecond is invalid" }
        require(
            point.headingDegrees == null ||
                point.headingDegrees.isFinite() && point.headingDegrees in 0.0..<360.0,
        ) { "headingDegrees is invalid" }
        require(point.quality == GpsPolicy.quality(point.accuracyMeters)) {
            "quality must match accuracyMeters"
        }
    }
}
