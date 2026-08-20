package us.ryanshores.atlas.mobile.shared.gps

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class GpsPolicyTest {
    @Test
    fun matchesTheSharedGoldenContract() {
        assertEquals(GpsPolicyGoldenFixtures.goodAccuracyMeters, GpsPolicy.GOOD_ACCURACY_METERS)
        assertEquals(GpsPolicyGoldenFixtures.fairAccuracyMeters, GpsPolicy.FAIR_ACCURACY_METERS)
        assertEquals(GpsPolicyGoldenFixtures.maxUsableAccuracyMeters, GpsPolicy.MAX_USABLE_ACCURACY_METERS)
        assertEquals(GpsPolicyGoldenFixtures.maxFixAgeMilliseconds, GpsPolicy.MAX_FIX_AGE_MILLISECONDS)

        for (sample in GpsPolicyGoldenFixtures.samples) {
            assertEquals(
                sample.expectedQuality,
                GpsPolicy.quality(sample.accuracyMeters, sample.ageMilliseconds).wireValue,
                sample.name,
            )
            assertEquals(
                sample.expectedAction,
                GpsPolicy.fixAction(
                    sample.accuracyMeters,
                    sample.hasUsableFix,
                    sample.ageMilliseconds,
                ).wireValue,
                sample.name,
            )
        }
        for (sample in GpsPolicyGoldenFixtures.plausibleMovementSamples) {
            assertEquals(
                sample.expected,
                GpsPolicy.isPlausibleLocationChange(
                    sample.distanceMeters,
                    sample.elapsedMilliseconds,
                    sample.previousAccuracyMeters,
                    sample.nextAccuracyMeters,
                ),
            )
        }
        for (sample in GpsPolicyGoldenFixtures.smoothingSamples) {
            assertEquals(sample.expectedWeight, GpsPolicy.smoothingWeight(sample.accuracyMeters))
        }
    }

    @Test
    fun waitsForAUsableFirstFixAndRetainsTheLastTrustedFix() {
        val empty = GpsPolicyState()
        val coarse = GpsPolicy.evaluate(
            empty,
            fix(latitude = 30.2672, longitude = -97.7431, accuracy = 4_000.0, timestamp = 1_000),
            nowMilliseconds = 1_000,
        )
        assertEquals(GpsFixAction.WAIT_FOR_ACCURATE_FIX, coarse.action)
        assertNull(coarse.state.lastAcceptedFix)

        val first = GpsPolicy.evaluate(
            coarse.state,
            fix(latitude = 30.2672, longitude = -97.7431, accuracy = 12.0, timestamp = 2_000),
            nowMilliseconds = 2_000,
        )
        val trusted = assertNotNull(first.acceptedFix)
        assertTrue(first.accepted)
        assertEquals(GpsQuality.GOOD, trusted.quality)

        val weakened = GpsPolicy.evaluate(
            first.state,
            fix(latitude = 30.30, longitude = -97.70, accuracy = 4_000.0, timestamp = 3_000),
            nowMilliseconds = 3_000,
        )
        assertEquals(GpsFixAction.KEEP_LAST_FIX, weakened.action)
        assertFalse(weakened.accepted)
        assertSame(trusted, weakened.state.lastAcceptedFix)
    }

    @Test
    fun rejectsStaleInvalidAndImplausibleFixesWithoutChangingState() {
        val first = GpsPolicy.evaluate(
            GpsPolicyState(),
            fix(latitude = 30.2672, longitude = -97.7431, accuracy = 10.0, timestamp = 20_000),
            nowMilliseconds = 20_000,
        )
        val trusted = assertNotNull(first.state.lastAcceptedFix)

        val stale = GpsPolicy.evaluate(
            first.state,
            fix(latitude = 30.2673, longitude = -97.7432, accuracy = 10.0, timestamp = 20_001),
            nowMilliseconds = 35_002,
        )
        assertEquals(GpsFixAction.KEEP_LAST_FIX, stale.action)
        assertSame(trusted, stale.state.lastAcceptedFix)

        val invalid = GpsPolicy.evaluate(
            first.state,
            fix(latitude = Double.NaN, longitude = -97.7432, accuracy = 10.0, timestamp = 21_000),
            nowMilliseconds = 21_000,
        )
        assertEquals(GpsFixAction.KEEP_LAST_FIX, invalid.action)
        assertSame(trusted, invalid.state.lastAcceptedFix)

        val jump = GpsPolicy.evaluate(
            first.state,
            fix(latitude = 30.30, longitude = -97.70, accuracy = 10.0, timestamp = 22_000),
            nowMilliseconds = 22_000,
        )
        assertEquals(GpsFixAction.REJECT_JUMP, jump.action)
        assertSame(trusted, jump.state.lastAcceptedFix)
    }

    @Test
    fun smoothsOnlyAnAcceptedFixAndClassifiesGuidancePrecision() {
        val first = GpsPolicy.evaluate(
            GpsPolicyState(),
            fix(latitude = 30.2672, longitude = -97.7431, accuracy = 10.0, timestamp = 1_000),
            nowMilliseconds = 1_000,
        )
        val nextRaw = fix(latitude = 30.2673, longitude = -97.7430, accuracy = 65.0, timestamp = 3_000)
        val next = GpsPolicy.evaluate(first.state, nextRaw, nowMilliseconds = 3_000)
        val firstAccepted = assertNotNull(first.state.lastAcceptedFix)
        val accepted = assertNotNull(next.acceptedFix)

        assertEquals(GpsFixAction.USE_FIX, next.action)
        assertTrue(accepted.latitude > firstAccepted.latitude)
        assertTrue(accepted.latitude < nextRaw.latitude)
        assertTrue(accepted.longitude > firstAccepted.longitude)
        assertTrue(accepted.longitude < nextRaw.longitude)
        assertTrue(accepted.quality.canAdvanceGuidance())
        assertFalse(GpsQuality.POOR.canAdvanceGuidance())
        assertFalse(GpsQuality.UNUSABLE.canAdvanceGuidance())
    }

    private fun fix(
        latitude: Double,
        longitude: Double,
        accuracy: Double,
        timestamp: Long,
    ) = RawLocationFix(
        latitude = latitude,
        longitude = longitude,
        accuracyMeters = accuracy,
        timestampMilliseconds = timestamp,
    )
}
