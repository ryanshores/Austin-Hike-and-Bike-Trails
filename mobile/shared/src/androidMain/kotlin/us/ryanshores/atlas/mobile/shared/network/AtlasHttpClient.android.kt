package us.ryanshores.atlas.mobile.shared.network

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp

actual fun createPlatformAtlasHttpClient(): HttpClient = HttpClient(OkHttp) {
    configureAtlasHttpClient()
}
