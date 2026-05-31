package com.offlineid

import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.view.WindowManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

class ScreenBrightnessModule(
    private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "ScreenBrightness"

    // Ambient light sensor — cached last reading, -1 if unavailable.
    @Volatile private var lastLux: Float = -1f

    private val luxListener = object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent) {
            lastLux = event.values[0]
        }
        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    }

    init {
        val sm = reactContext.getSystemService(SensorManager::class.java)
        val light = sm?.getDefaultSensor(Sensor.TYPE_LIGHT)
        if (light != null) {
            sm.registerListener(luxListener, light, SensorManager.SENSOR_DELAY_NORMAL)
        }
    }

    override fun invalidate() {
        super.invalidate()
        val sm = reactContext.getSystemService(SensorManager::class.java)
        sm?.unregisterListener(luxListener)
    }

    /** Returns the latest ambient lux reading, or -1 if the sensor is unavailable. */
    @ReactMethod
    fun getLux(promise: Promise) {
        promise.resolve(lastLux.toDouble())
    }

    @ReactMethod
    fun setBrightness(value: Double, promise: Promise) {
        val activity = currentActivity
        if (activity == null) {
            promise.reject("no_activity", "No current activity")
            return
        }
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

    @ReactMethod
    fun restore(promise: Promise) {
        setBrightness(-1.0, promise)
    }

    @ReactMethod
    fun acquireWakeLock(promise: Promise) {
        val activity = currentActivity
        if (activity == null) { promise.resolve(null); return }
        UiThreadUtil.runOnUiThread {
            try {
                activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                promise.resolve(null)
            } catch (e: Exception) { promise.reject("wake_lock_failed", e) }
        }
    }

    @ReactMethod
    fun releaseWakeLock(promise: Promise) {
        val activity = currentActivity
        if (activity == null) { promise.resolve(null); return }
        UiThreadUtil.runOnUiThread {
            try {
                activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                promise.resolve(null)
            } catch (e: Exception) { promise.reject("wake_lock_failed", e) }
        }
    }
}
