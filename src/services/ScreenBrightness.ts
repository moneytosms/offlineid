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

export const ScreenBrightness = {
  setBrightness,
  restore,
  isAvailable: isScreenBrightnessAvailable,
};

export default ScreenBrightness;
