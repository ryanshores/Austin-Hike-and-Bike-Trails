import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("app.cash.sqldelight")
    id("com.android.kotlin.multiplatform.library")
    id("org.jetbrains.kotlin.multiplatform")
    id("org.jetbrains.kotlin.plugin.serialization")
}

kotlin {
    android {
        namespace = "us.ryanshores.atlas.mobile.shared"
        compileSdk = 36
        minSdk = 26

        compilerOptions {
            jvmTarget.set(JvmTarget.JVM_17)
        }
    }

    iosArm64()
    iosX64()
    iosSimulatorArm64()

    targets.withType<org.jetbrains.kotlin.gradle.plugin.mpp.KotlinNativeTarget>().configureEach {
        binaries.framework {
            baseName = "AtlasShared"
            isStatic = true
        }
    }

    sourceSets {
        commonMain.dependencies {
            implementation("app.cash.sqldelight:runtime:2.3.2")
            implementation("io.ktor:ktor-client-content-negotiation:3.5.1")
            implementation("io.ktor:ktor-client-core:3.5.1")
            implementation("io.ktor:ktor-serialization-kotlinx-json:3.5.1")
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
            implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation("io.ktor:ktor-client-mock:3.5.1")
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
        }
        androidMain.dependencies {
            implementation("app.cash.sqldelight:android-driver:2.3.2")
            implementation("io.ktor:ktor-client-okhttp:3.5.1")
        }
        iosMain.dependencies {
            implementation("app.cash.sqldelight:native-driver:2.3.2")
            implementation("io.ktor:ktor-client-darwin:3.5.1")
        }
    }
}

sqldelight {
    databases {
        create("AtlasDatabase") {
            packageName.set("us.ryanshores.atlas.mobile.shared.db")
            schemaOutputDirectory.set(file("src/commonMain/sqldelight/databases"))
            verifyMigrations.set(true)
        }
    }
}

fun registerXcodeFrameworkCopy(
    name: String,
    linkTask: String,
    sourceDirectory: String,
    destinationDirectory: String,
) = tasks.register<Copy>(name) {
    dependsOn(linkTask)
    from(layout.buildDirectory.dir(sourceDirectory))
    into(layout.buildDirectory.dir(destinationDirectory))
}

registerXcodeFrameworkCopy(
    name = "copyDebugIosSimulatorArm64FrameworkForXcode",
    linkTask = "linkDebugFrameworkIosSimulatorArm64",
    sourceDirectory = "bin/iosSimulatorArm64/debugFramework/AtlasShared.framework",
    destinationDirectory = "xcode-frameworks/Debug/iphonesimulator/AtlasShared.framework",
)
registerXcodeFrameworkCopy(
    name = "copyDebugIosX64FrameworkForXcode",
    linkTask = "linkDebugFrameworkIosX64",
    sourceDirectory = "bin/iosX64/debugFramework/AtlasShared.framework",
    destinationDirectory = "xcode-frameworks/Debug/iphonesimulator/AtlasShared.framework",
)
registerXcodeFrameworkCopy(
    name = "copyDebugIosArm64FrameworkForXcode",
    linkTask = "linkDebugFrameworkIosArm64",
    sourceDirectory = "bin/iosArm64/debugFramework/AtlasShared.framework",
    destinationDirectory = "xcode-frameworks/Debug/iphoneos/AtlasShared.framework",
)
