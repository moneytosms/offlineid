package com.offlineid

import android.view.WindowManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/**
 * ScreenBrightnessModule — sets the **current activity's window** brightness.
 *
 * Used as a low-light fill light for the front-camera face pipeline: when the
 * camera preview detects a dark scene the JS layer maxes the screen so the
 * subject's face is lit by the display.
 *
 * Scope is the app window only (`WindowManager.LayoutParams.screenBrightness`),
 * so this needs **no permission** (unlike system-wide brightness, which would
 * require `WRITE_SETTINGS`). Android automatically restores the system value
 * when our activity pauses; we also restore explicitly via `setBrightness(-1)`.
 *
 * `value` is in [0, 1]; pass `-1` for `BRIGHTNESS_OVERRIDE_NONE` (follow system).
 */
class ScreenBrightnessModule(
    private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "ScreenBrightness"

    @ReactMethod
    fun setBrightness(value: Double, promise: Promise) {
        val activity = currentActivity
        if (activity == null) {
            promise.reject("no_activity", "No current activity to set brightness on")
            return
        }
        // Clamp to [0,1]; any negative value means "restore system default".
        val level = when {
            value < 0.0 -> WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            value > 1.0 -> 1.0f
            else -> value.toFloat()
        }
        UiThreadUtil.runOnUiThread {
            try {
                val lp = activity.window.attributes
                lp.screenBrightness = level
                activity.window.attributes = lp
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("set_brightness_failed", e)
            }
        }
    }

    /** Restore the window to the system brightness. */
    @ReactMethod
    fun restore(promise: Promise) {
        setBrightness(-1.0, promise)
    }
}
