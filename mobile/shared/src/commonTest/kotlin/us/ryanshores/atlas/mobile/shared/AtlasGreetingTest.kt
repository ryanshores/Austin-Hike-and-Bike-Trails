package us.ryanshores.atlas.mobile.shared

import kotlin.test.Test
import kotlin.test.assertEquals

class AtlasGreetingTest {
    @Test
    fun exposesTheProductNameToNativeHosts() {
        assertEquals("Austin Hike & Bike Atlas", AtlasGreeting().message())
    }
}
