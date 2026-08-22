package us.ryanshores.atlas.mobile.shared.auth

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NativeSessionTest {
    @Test
    fun requiresBothRotatingSessionCredentials() {
        assertTrue(NativeSession("access", "refresh", "installation", "owner").isComplete())
        assertFalse(NativeSession("", "refresh", null, "owner").isComplete())
        assertFalse(NativeSession("access", "", null, "owner").isComplete())
        assertFalse(NativeSession("access", "refresh", null, "").isComplete())
    }
}
