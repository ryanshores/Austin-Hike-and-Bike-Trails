package us.ryanshores.atlas.mobile.shared

/**
 * A deliberately small shared API used by both native hosts to prove the
 * Kotlin-to-Swift bridge before product features move into this module.
 */
class AtlasGreeting {
    fun message(): String = "Austin Hike & Bike Atlas"
}
