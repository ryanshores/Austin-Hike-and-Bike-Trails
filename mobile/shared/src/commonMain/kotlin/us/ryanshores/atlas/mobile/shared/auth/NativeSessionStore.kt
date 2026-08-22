package us.ryanshores.atlas.mobile.shared.auth

/** Secure platform storage for native session credentials. */
interface NativeSessionStore {
    @Throws(Exception::class)
    fun load(): NativeSessionLoadResult

    @Throws(Exception::class)
    fun save(session: NativeSession)

    @Throws(Exception::class)
    fun clear()
}

/** Boxes an optional session so Swift can distinguish absence from a thrown storage error. */
data class NativeSessionLoadResult(val session: NativeSession?)
