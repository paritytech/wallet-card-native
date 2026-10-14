// Minimal host app for WalletSurface. In a real app: add ../../src to your sources (or copy the three
// files), and the same copyWalletAssets task (or copy assets/ + shaders/*.vert|frag into assets/wallet/).
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val packageRoot = rootDir.resolve("../..")              // wallet-native/
val walletAssets = layout.buildDirectory.dir("generated/walletAssets")

// assets/ (the baked card + params.json) and the GLSL shaders → assets/wallet/ in the APK
val copyWalletAssets by tasks.registering(Sync::class) {
    from(packageRoot.resolve("assets"))
    from(packageRoot.resolve("shaders")) { include("*.vert", "*.frag") }
    into(walletAssets.map { it.dir("wallet") })
}

android {
    namespace = "io.parity.walletdemo"
    compileSdk = 36
    defaultConfig {
        applicationId = "io.parity.walletdemo"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }
    sourceSets["main"].java.srcDir(packageRoot.resolve("android/src"))
    sourceSets["main"].assets.srcDir(walletAssets)
    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

tasks.named("preBuild") { dependsOn(copyWalletAssets) }

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.05.00"))
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.activity:activity-compose:1.11.0")
}
