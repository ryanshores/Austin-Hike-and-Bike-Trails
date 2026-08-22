package us.ryanshores.atlas.mobile.shared.network

import io.ktor.client.HttpClient
import io.ktor.client.engine.darwin.Darwin

actual fun createPlatformAtlasHttpClient(): HttpClient = HttpClient(Darwin) {
    configureAtlasHttpClient()
}
