package us.ryanshores.atlas.mobile.shared.map

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class AtlasMapModelsTest {
    @Test
    fun classifiesWorkerFacilityPropertiesConservatively() {
        assertEquals(BikeFacilityCategory.OFF_ROAD, classifyBikeFacility("Urban Trail", null))
        assertEquals(BikeFacilityCategory.PROTECTED, classifyBikeFacility("Protected Bike Lane", "On Street"))
        assertEquals(BikeFacilityCategory.STREET, classifyBikeFacility("Bike Lane", "On Street"))
    }

    @Test
    fun boundsRemainViewportBounded() {
        assertEquals("-97.8,30.2,-97.7,30.3", MapBounds(-97.8, 30.2, -97.7, 30.3).queryValue())
        assertFailsWith<IllegalArgumentException> { MapBounds(-100.0, 30.0, -90.0, 31.0) }
    }
}
