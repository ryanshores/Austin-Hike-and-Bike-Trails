import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.kotlin.multiplatform.library")
    id("org.jetbrains.kotlin.multiplatform")
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
        commonTest.dependencies {
            implementation(kotlin("test"))
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
    destinationDirectory = "xcode-frameworks/Debug/iphonesimulator",
)
registerXcodeFrameworkCopy(
    name = "copyDebugIosX64FrameworkForXcode",
    linkTask = "linkDebugFrameworkIosX64",
    sourceDirectory = "bin/iosX64/debugFramework/AtlasShared.framework",
    destinationDirectory = "xcode-frameworks/Debug/iphonesimulator",
)
registerXcodeFrameworkCopy(
    name = "copyDebugIosArm64FrameworkForXcode",
    linkTask = "linkDebugFrameworkIosArm64",
    sourceDirectory = "bin/iosArm64/debugFramework/AtlasShared.framework",
    destinationDirectory = "xcode-frameworks/Debug/iphoneos",
)
