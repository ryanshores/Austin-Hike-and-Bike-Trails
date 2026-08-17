package us.ryanshores.atlas.mobile.shared.auth

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NativeSessionTest {
    @Test
    fun requiresBothRotatingSessionCredentials() {
        assertTrue(NativeSession("access", "refresh", "installation").isComplete())
        assertFalse(NativeSession("", "refresh", null).isComplete())
        assertFalse(NativeSession("access", "", null).isComplete())
    }
}
