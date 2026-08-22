package us.ryanshores.atlas.mobile.shared.network

import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json

internal fun HttpClientConfig<*>.configureAtlasHttpClient() {
    expectSuccess = false
    install(HttpTimeout) {
        connectTimeoutMillis = 15_000
        requestTimeoutMillis = 30_000
        socketTimeoutMillis = 30_000
    }
    install(ContentNegotiation) {
        json(
            Json {
                explicitNulls = false
                ignoreUnknownKeys = true
            },
        )
    }
}

expect fun createPlatformAtlasHttpClient(): HttpClient
