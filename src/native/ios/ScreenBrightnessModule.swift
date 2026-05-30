import Foundation
import UIKit

/**
 ScreenBrightness — low-light fill light for the front-camera face pipeline.

 iOS has no per-window brightness, so this sets `UIScreen.main.brightness`
 (system display brightness; no permission required). The pre-boost value is
 saved on the first boost and restored via `restore()` / `setBrightness(-1)`,
 so leaving the scan screen returns the display to where the user had it.

 `value` is in [0, 1]; a negative value restores the saved brightness.
 */
@objc(ScreenBrightness)
class ScreenBrightness: NSObject {

  /// Brightness captured immediately before the first boost.
  private var saved: CGFloat?

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

  @objc(restore:rejecter:)
  func restore(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    setBrightness(-1, resolver: resolve, rejecter: reject)
  }

  @objc static func requiresMainQueueSetup() -> Bool { return false }
}
