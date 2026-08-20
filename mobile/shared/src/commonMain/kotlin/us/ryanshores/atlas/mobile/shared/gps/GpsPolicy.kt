package us.ryanshores.atlas.mobile.shared.gps

import kotlin.math.PI
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

enum class GpsQuality(val wireValue: String) {
    GOOD("good"),
    FAIR("fair"),
    POOR("poor"),
    UNUSABLE("unusable");

    fun canAdvanceGuidance(): Boolean = this == GOOD || this == FAIR
}

enum class GpsFixAction(val wireValue: String) {
    USE_FIX("use-fix"),
    WAIT_FOR_ACCURATE_FIX("wait-for-accurate-fix"),
    KEEP_LAST_FIX("keep-last-fix"),
    REJECT_JUMP("reject-jump"),
}

data class RawLocationFix(
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Double,
    val timestampMilliseconds: Long,
)

data class AcceptedLocationFix(
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Double,
    val timestampMilliseconds: Long,
    val quality: GpsQuality,
)

data class GpsPolicyState(
    val lastAcceptedFix: AcceptedLocationFix? = null,
)

data class GpsDecision(
    val action: GpsFixAction,
    val quality: GpsQuality,
    val acceptedFix: AcceptedLocationFix?,
    val state: GpsPolicyState,
) {
    val accepted: Boolean get() = acceptedFix != null
}

object GpsPolicy {
    const val GOOD_ACCURACY_METERS = 25.0
    const val FAIR_ACCURACY_METERS = 75.0
    const val MAX_USABLE_ACCURACY_METERS = 100.0
    const val MAX_FIX_AGE_MILLISECONDS = 15_000L
    private const val MAX_CYCLING_SPEED_METERS_PER_SECOND = 22.0
    private const val MINIMUM_JUMP_ALLOWANCE_METERS = 80.0
    private const val EARTH_RADIUS_METERS = 6_371_000.0

    fun quality(
        accuracyMeters: Double,
        ageMilliseconds: Long = 0,
    ): GpsQuality {
        if (
            !accuracyMeters.isFinite() || accuracyMeters < 0 ||
            ageMilliseconds < 0 || ageMilliseconds > MAX_FIX_AGE_MILLISECONDS ||
            accuracyMeters > MAX_USABLE_ACCURACY_METERS
        ) {
            return GpsQuality.UNUSABLE
        }
        return when {
            accuracyMeters <= GOOD_ACCURACY_METERS -> GpsQuality.GOOD
            accuracyMeters <= FAIR_ACCURACY_METERS -> GpsQuality.FAIR
            else -> GpsQuality.POOR
        }
    }

    fun fixAction(
        accuracyMeters: Double,
        hasUsableFix: Boolean,
        ageMilliseconds: Long = 0,
    ): GpsFixAction = if (quality(accuracyMeters, ageMilliseconds) == GpsQuality.UNUSABLE) {
        if (hasUsableFix) GpsFixAction.KEEP_LAST_FIX else GpsFixAction.WAIT_FOR_ACCURATE_FIX
    } else {
        GpsFixAction.USE_FIX
    }

    fun isPlausibleLocationChange(
        distanceMeters: Double,
        elapsedMilliseconds: Long,
        previousAccuracyMeters: Double,
        nextAccuracyMeters: Double,
    ): Boolean {
        if (!distanceMeters.isFinite() || distanceMeters < 0 || elapsedMilliseconds <= 0) return false
        val accuracyAllowance = usableAllowance(previousAccuracyMeters) + usableAllowance(nextAccuracyMeters)
        val cyclingAllowance = elapsedMilliseconds / 1_000.0 * MAX_CYCLING_SPEED_METERS_PER_SECOND
        return distanceMeters <= max(MINIMUM_JUMP_ALLOWANCE_METERS, accuracyAllowance + cyclingAllowance)
    }

    fun smoothingWeight(accuracyMeters: Double): Double = when (quality(accuracyMeters)) {
        GpsQuality.GOOD -> 0.82
        GpsQuality.FAIR -> 0.62
        GpsQuality.POOR, GpsQuality.UNUSABLE -> 0.45
    }

    fun evaluate(
        state: GpsPolicyState,
        fix: RawLocationFix,
        nowMilliseconds: Long,
    ): GpsDecision {
        val ageMilliseconds = fixAge(nowMilliseconds, fix.timestampMilliseconds)
        val coordinatesUsable = coordinatesAreUsable(fix.latitude, fix.longitude)
        val quality = if (coordinatesUsable) {
            quality(fix.accuracyMeters, ageMilliseconds)
        } else {
            GpsQuality.UNUSABLE
        }
        val initialAction = if (quality == GpsQuality.UNUSABLE) {
            if (state.lastAcceptedFix == null) {
                GpsFixAction.WAIT_FOR_ACCURATE_FIX
            } else {
                GpsFixAction.KEEP_LAST_FIX
            }
        } else {
            GpsFixAction.USE_FIX
        }
        if (initialAction != GpsFixAction.USE_FIX) {
            return GpsDecision(initialAction, quality, null, state)
        }

        val previous = state.lastAcceptedFix
        if (previous != null) {
            val elapsedMilliseconds = fix.timestampMilliseconds - previous.timestampMilliseconds
            val distanceMeters = distanceMeters(
                previous.latitude,
                previous.longitude,
                fix.latitude,
                fix.longitude,
            )
            if (!isPlausibleLocationChange(
                    distanceMeters,
                    elapsedMilliseconds,
                    previous.accuracyMeters,
                    fix.accuracyMeters,
                )
            ) {
                return GpsDecision(GpsFixAction.REJECT_JUMP, quality, null, state)
            }
        }

        val accepted = if (previous == null) {
            AcceptedLocationFix(
                latitude = fix.latitude,
                longitude = fix.longitude,
                accuracyMeters = fix.accuracyMeters,
                timestampMilliseconds = fix.timestampMilliseconds,
                quality = quality,
            )
        } else {
            val weight = smoothingWeight(fix.accuracyMeters)
            AcceptedLocationFix(
                latitude = previous.latitude + (fix.latitude - previous.latitude) * weight,
                longitude = previous.longitude + (fix.longitude - previous.longitude) * weight,
                accuracyMeters = fix.accuracyMeters,
                timestampMilliseconds = fix.timestampMilliseconds,
                quality = quality,
            )
        }
        val nextState = GpsPolicyState(accepted)
        return GpsDecision(GpsFixAction.USE_FIX, quality, accepted, nextState)
    }

    private fun coordinatesAreUsable(latitude: Double, longitude: Double): Boolean =
        latitude.isFinite() && longitude.isFinite() && latitude in -90.0..90.0 && longitude in -180.0..180.0

    private fun fixAge(nowMilliseconds: Long, timestampMilliseconds: Long): Long = when {
        nowMilliseconds < 0 || timestampMilliseconds < 0 -> Long.MAX_VALUE
        timestampMilliseconds > nowMilliseconds -> -1
        else -> nowMilliseconds - timestampMilliseconds
    }

    private fun usableAllowance(accuracyMeters: Double): Double =
        if (accuracyMeters.isFinite()) max(0.0, accuracyMeters) else 0.0

    private fun distanceMeters(
        firstLatitude: Double,
        firstLongitude: Double,
        secondLatitude: Double,
        secondLongitude: Double,
    ): Double {
        val latitudeDelta = radians(secondLatitude - firstLatitude)
        val longitudeDelta = radians(secondLongitude - firstLongitude)
        val firstLatitudeRadians = radians(firstLatitude)
        val secondLatitudeRadians = radians(secondLatitude)
        val haversine = sin(latitudeDelta / 2).let { it * it } +
            cos(firstLatitudeRadians) * cos(secondLatitudeRadians) *
            sin(longitudeDelta / 2).let { it * it }
        return EARTH_RADIUS_METERS * 2 * asin(sqrt(min(1.0, haversine)))
    }

    private fun radians(degrees: Double): Double = degrees * PI / 180.0
}
