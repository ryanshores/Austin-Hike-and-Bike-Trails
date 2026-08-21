package us.ryanshores.atlas.mobile.shared.ride

import app.cash.sqldelight.db.SqlDriver
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin
import kotlin.math.sqrt
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
        nowMilliseconds: Long,
    ): BeginRideResult {
        requireValidId(rideId, "rideId")
        requireValidId(ownerId, "ownerId")
        require(startedAtMilliseconds >= 0) { "startedAtMilliseconds must be nonnegative" }
        require(nowMilliseconds >= 0) { "nowMilliseconds must be nonnegative" }
        require(
            if (startedAtMilliseconds > nowMilliseconds) {
                startedAtMilliseconds - nowMilliseconds <= MAX_FUTURE_MILLISECONDS
            } else {
                nowMilliseconds - startedAtMilliseconds <= MAX_POINT_AGE_MILLISECONDS
            },
        ) { "startedAtMilliseconds is outside the allowed creation window" }
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
            active.lastRecordedAtMilliseconds?.let { previousRecordedAt ->
                require(
                    isPlausibleUploadMovement(
                        previousRecordedAt = previousRecordedAt,
                        previousLatitude = checkNotNull(active.lastLatitude),
                        previousLongitude = checkNotNull(active.lastLongitude),
                        previousAccuracyMeters = checkNotNull(active.lastAccuracyMeters),
                        point = point,
                    ),
                ) { "point movement is implausible" }
            }
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
            queries.advanceSequence(
                recordedAt = point.recordedAtMilliseconds,
                latitude = point.latitude,
                longitude = point.longitude,
                accuracyMeters = point.accuracyMeters,
            )
            QueuedRidePoint(active.rideId, active.nextSequence, null, point)
        }
    }

    fun queuedPoints(): List<QueuedRidePoint> {
        val active = activeRide() ?: return emptyList()
        return queries.selectQueuedPoints(active.rideId).executeAsList().map(::mapQueuedPoint)
    }

    fun nextUploadBatch(
        newBatchId: String,
        nowMilliseconds: Long,
        maximumPoints: Long = 100,
    ): NextUploadBatchResult {
        requireValidId(newBatchId, "newBatchId")
        require(nowMilliseconds >= 0) { "nowMilliseconds must be nonnegative" }
        require(maximumPoints in 1..100) { "maximumPoints must be between 1 and 100" }
        return database.transactionWithResult {
            val active = activeRide() ?: return@transactionWithResult NextUploadBatchResult.Empty
            val first = queries.selectFirstQueuedPoint(active.rideId).executeAsOneOrNull()
                ?: return@transactionWithResult NextUploadBatchResult.Empty
            first.batch_id?.let { batchId ->
                return@transactionWithResult readyBatch(active.rideId, batchId)
            }
            if (first.recorded_at < nowMilliseconds - MAX_POINT_AGE_MILLISECONDS) {
                return@transactionWithResult NextUploadBatchResult.Expired(
                    rideId = active.rideId,
                    oldestRecordedAtMilliseconds = first.recorded_at,
                )
            }
            val candidates = queries.selectNextUnassignedPoints(active.rideId, maximumPoints)
                .executeAsList()
                .map(::mapQueuedPoint)
            val future = candidates.lastOrNull { queued ->
                val recordedAt = queued.point.recordedAtMilliseconds
                recordedAt > nowMilliseconds && recordedAt - nowMilliseconds > MAX_FUTURE_MILLISECONDS
            }
            if (future != null) {
                return@transactionWithResult NextUploadBatchResult.FutureDated(
                    rideId = active.rideId,
                    recordedAtMilliseconds = future.point.recordedAtMilliseconds,
                    retryAtMilliseconds = future.point.recordedAtMilliseconds - MAX_FUTURE_MILLISECONDS,
                )
            }
            queries.assignNextBatch(newBatchId, active.rideId, maximumPoints)
            readyBatch(active.rideId, newBatchId)
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
        lastLatitude: Double?,
        lastLongitude: Double?,
        lastAccuracyMeters: Double?,
    ) = ActiveRide(
        rideId = rideId,
        ownerId = ownerId,
        startedAtMilliseconds = startedAt,
        status = RideRecordingStatus.entries.single { it.wireValue == status },
        nextSequence = nextSequence,
        lastRecordedAtMilliseconds = lastRecordedAt,
        lastLatitude = lastLatitude,
        lastLongitude = lastLongitude,
        lastAccuracyMeters = lastAccuracyMeters,
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

    private fun readyBatch(rideId: String, batchId: String): NextUploadBatchResult.Ready {
        val points = queries.selectBatch(rideId, batchId).executeAsList().map(::mapQueuedPoint)
        check(points.isNotEmpty()) { "Assigned upload batch is empty" }
        return NextUploadBatchResult.Ready(RideUploadBatch(rideId, batchId, points))
    }

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

    private fun isPlausibleUploadMovement(
        previousRecordedAt: Long,
        previousLatitude: Double,
        previousLongitude: Double,
        previousAccuracyMeters: Double,
        point: AcceptedRidePoint,
    ): Boolean {
        val elapsedMilliseconds = point.recordedAtMilliseconds - previousRecordedAt
        val distanceMeters = distanceMeters(previousLatitude, previousLongitude, point.latitude, point.longitude)
        return if (elapsedMilliseconds == 0L) {
            distanceMeters <= max(previousAccuracyMeters, point.accuracyMeters)
        } else {
            distanceMeters / (elapsedMilliseconds / 1_000.0) <= MAX_UPLOAD_SPEED_METERS_PER_SECOND
        }
    }

    private fun distanceMeters(
        firstLatitude: Double,
        firstLongitude: Double,
        secondLatitude: Double,
        secondLongitude: Double,
    ): Double {
        val radians = PI / 180.0
        val latitudeDelta = (secondLatitude - firstLatitude) * radians
        val longitudeDelta = (secondLongitude - firstLongitude) * radians
        val a = sin(latitudeDelta / 2).let { it * it } +
            cos(firstLatitude * radians) * cos(secondLatitude * radians) *
            sin(longitudeDelta / 2).let { it * it }
        return EARTH_RADIUS_METERS * 2 * atan2(sqrt(a), sqrt(1 - a))
    }

    private companion object {
        const val MAX_POINT_AGE_MILLISECONDS = 24L * 60 * 60 * 1_000
        const val MAX_FUTURE_MILLISECONDS = 5L * 60 * 1_000
        const val MAX_UPLOAD_SPEED_METERS_PER_SECOND = 35.0
        const val EARTH_RADIUS_METERS = 6_371_000.0
    }
}
