package com.offlineid

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * ReactPackage that registers [FaceEngineModule] and [ScreenBrightnessModule]
 * with the React Native bridge.
 *
 * Add to the host app's `MainApplication.kt`:
 * ```kotlin
 * override fun getPackages(): List<ReactPackage> =
 *     PackageList(this).packages.apply { add(FaceEnginePackage()) }
 * ```
 */
class FaceEnginePackage : ReactPackage {

    override fun createNativeModules(
        reactContext: ReactApplicationContext
    ): List<NativeModule> = listOf(
        FaceEngineModule(reactContext),
        ScreenBrightnessModule(reactContext),
    )

    override fun createViewManagers(
        reactContext: ReactApplicationContext
    ): List<ViewManager<*, *>> = emptyList()
}
