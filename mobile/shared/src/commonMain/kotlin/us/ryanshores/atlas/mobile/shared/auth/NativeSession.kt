package us.ryanshores.atlas.mobile.shared.auth

/**
 * The native-only credentials returned by the `/api/mobile/v1/auth` endpoints.
 *
 * Platform adapters persist this value in secure storage; it is deliberately
 * not serializable or printable so credentials do not enter logs by default.
 */
class NativeSession(
    val accessToken: String,
    val refreshToken: String,
    val installationCredential: String?,
) {
    fun isComplete(): Boolean = accessToken.isNotBlank() && refreshToken.isNotBlank()
}
