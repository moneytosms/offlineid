//
//  ScreenBrightness.swift
//  OfflineID — display fill-light + screen-awake control for the face pipeline.
//
//  Swift port of the Android `ScreenBrightnessModule.kt`, exposing the same JS
//  contract (see src/services/ScreenBrightness.ts) so NativeModules.ScreenBrightness
//  resolves identically on iOS and Android:
//
//    setBrightness / restore / getLux / acquireWakeLock / releaseWakeLock
//
//  Platform differences vs Android (kept behind the same contract):
//    - Brightness: iOS has no per-window brightness, so this sets the *system*
//      display brightness (UIScreen.main.brightness). The pre-boost value is saved
//      on the first boost and restored via restore() / setBrightness(-1), so leaving
//      the scan screen returns the display to where the user had it. No permission.
//    - Ambient lux: iOS exposes no public ambient-light-sensor API, so getLux()
//      returns -1 ("unavailable"), exactly like Android when no light sensor exists.
//      The JS layer treats -1 as "not dim" and simply skips the auto fill-light.
//    - Wake-lock: maps to UIApplication.isIdleTimerDisabled (keep screen awake).
//
//  All UIKit access is marshalled to the main thread.
//

import Foundation
import UIKit

@objc(ScreenBrightness)
final class ScreenBrightness: NSObject {

  /// Brightness captured immediately before the first boost.
  private var saved: CGFloat?

  // MARK: - Brightness

  /// Set the system display brightness in [0,1]; pass a negative value to restore
  /// the brightness captured before the first boost.
  @objc(setBrightness:resolver:rejecter:)
  func setBrightness(
    _ value: NSNumber,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let v = value.doubleValue
      if v < 0 {
        if let s = self.saved {
          UIScreen.main.brightness = s
          self.saved = nil
        }
      } else {
        if self.saved == nil { self.saved = UIScreen.main.brightness }
        UIScreen.main.brightness = CGFloat(min(max(v, 0.0), 1.0))
      }
      resolve(nil)
    }
  }

  /// Restore the display to the brightness saved before the first boost.
  @objc(restore:rejecter:)
  func restore(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    setBrightness(-1, resolver: resolve, rejecter: reject)
  }

  // MARK: - Ambient lux (parity stub)

  /// iOS has no public ambient-light-sensor API, so report -1 ("unavailable"),
  /// matching the Android contract when the device exposes no light sensor.
  @objc(getLux:rejecter:)
  func getLux(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(-1)
  }

  // MARK: - Keep screen awake (Android FLAG_KEEP_SCREEN_ON equivalent)

  /// Keep the screen on during a scan (disables the idle/auto-lock timer).
  @objc(acquireWakeLock:rejecter:)
  func acquireWakeLock(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      UIApplication.shared.isIdleTimerDisabled = true
      resolve(nil)
    }
  }

  /// Re-enable the idle/auto-lock timer.
  @objc(releaseWakeLock:rejecter:)
  func releaseWakeLock(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      UIApplication.shared.isIdleTimerDisabled = false
      resolve(nil)
    }
  }

  @objc static func requiresMainQueueSetup() -> Bool { false }
}
