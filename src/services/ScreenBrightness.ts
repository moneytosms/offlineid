/**
 * JS wrapper for the `ScreenBrightness` native module.
 *
 * Sets the app window's screen brightness (Android) / system display brightness
 * (iOS) so the display can act as a low-light fill light for the front-camera
 * face pipeline (see {@link ../components/CameraView}).
 *
 * Every method is best-effort and never throws: if the native module is not
 * linked (e.g. the iOS engine has not been built yet) the calls no-op so the
 * camera flow is unaffected.
 *
 * @module services/ScreenBrightness
 */

import { NativeModules } from 'react-native';

import { logger } from '../utils/logger';

const TAG = 'ScreenBrightness';

/** Native contract (Kotlin / Swift). */
interface IScreenBrightnessNative {
  /** Set window brightness in [0,1]; pass -1 to restore the system value. */
  setBrightness(value: number): Promise<void>;
  /** Restore the window/display to the system brightness. */
  restore(): Promise<void>;
  /** Latest ambient lux from the light sensor; -1 if unavailable. */
  getLux(): Promise<number>;
  /** Acquire a wake-lock to keep screen on. */
  acquireWakeLock(): Promise<void>;
  /** Release the wake-lock. */
  releaseWakeLock(): Promise<void>;
}

const native: IScreenBrightnessNative | undefined = (
  NativeModules as { ScreenBrightness?: IScreenBrightnessNative }
).ScreenBrightness;

/** Whether the native module is linked. */
export function isScreenBrightnessAvailable(): boolean {
  return native != null;
}

/**
 * Set the window brightness.
 *
 * @param value - Brightness in [0,1]; `-1` restores the system default.
 */
async function setBrightness(value: number): Promise<void> {
  if (!native) return;
  try {
    await native.setBrightness(value);
  } catch (err) {
    logger.warn(TAG, `setBrightness(${value}) failed`, err);
  }
}

/** Restore the system brightness. */
async function restore(): Promise<void> {
  if (!native) return;
  try {
    await native.restore();
  } catch (err) {
    logger.warn(TAG, 'restore failed', err);
  }
}

/**
 * Lux below which the fill-light overlay activates.
 * 15 lux = near-dark (candle/dim corridor). Typical indoor rooms read 20-300 lux.
 */
export const LUX_DIM_THRESHOLD = 15;

/** Lux above which the fill-light deactivates (hysteresis prevents flicker). */
export const LUX_BRIGHT_THRESHOLD = 28;

/** Returns the latest ambient lux, or -1 if the sensor is unavailable. */
async function getLux(): Promise<number> {
  if (!native) return -1;
  try {
    return await native.getLux();
  } catch {
    return -1;
  }
}

/** Acquire a wake-lock to keep the screen on. */
async function acquireWakeLock(): Promise<void> {
  if (!native) return;
  try {
    await native.acquireWakeLock();
  } catch (err) {
    logger.warn(TAG, 'acquireWakeLock failed', err);
  }
}

/** Release the wake-lock. */
async function releaseWakeLock(): Promise<void> {
  if (!native) return;
  try {
    await native.releaseWakeLock();
  } catch (err) {
    logger.warn(TAG, 'releaseWakeLock failed', err);
  }
}

export const ScreenBrightness = {
  setBrightness,
  restore,
  getLux,
  acquireWakeLock,
  releaseWakeLock,
  isAvailable: isScreenBrightnessAvailable,
};

export default ScreenBrightness;
