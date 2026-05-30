//
//  RGBAImage.swift
//  OfflineID — CoreGraphics pixel helper for FaceEngine.
//
//  Replaces Android's `Bitmap` + `getPixels`/`createScaledBitmap`/`createBitmap`. Produces a
//  row-major RGBA byte buffer with **top-left origin**, matching the Kotlin pixel convention
//  exactly so the ported preprocessing math is byte-for-byte equivalent.
//

import Foundation
import CoreGraphics

struct RGBAImage {
  let width: Int
  let height: Int
  /// Row-major RGBA bytes (R,G,B,A per pixel), top-left origin.
  let pixels: [UInt8]
  /// Retained for resize/crop (nil for buffers produced by warpAffine).
  private let cgImage: CGImage?

  /// Build from a CGImage, rendering its pixels at native size (top-left origin).
  init(cgImage: CGImage, width: Int, height: Int) {
    self.cgImage = cgImage
    self.width = width
    self.height = height
    self.pixels = RGBAImage.render(cgImage, width: width, height: height)
  }

  /// Build directly from a pixel buffer (e.g. warpAffine output).
  init(width: Int, height: Int, pixels: [UInt8]) {
    self.cgImage = nil
    self.width = width
    self.height = height
    self.pixels = pixels
  }

  /// Full resize to `w × h` (mirrors `Bitmap.createScaledBitmap`).
  func resized(to w: Int, _ h: Int) -> RGBAImage {
    guard let cg = cgImage else {
      return RGBAImage(width: w, height: h, pixels: RGBAImage.nearestResize(self, w, h))
    }
    return RGBAImage(width: w, height: h, pixels: RGBAImage.render(cg, width: w, height: h))
  }

  /// Crop `[x,y,w,h]` then resize to `out × out` (mirrors `createBitmap` + `createScaledBitmap`).
  func cropResized(x: Int, y: Int, w: Int, h: Int, to out: Int) -> RGBAImage {
    if let cg = cgImage,
       let cropped = cg.cropping(to: CGRect(x: x, y: y, width: w, height: h)) {
      return RGBAImage(width: out, height: out,
                       pixels: RGBAImage.render(cropped, width: out, height: out))
    }
    // Fallback: crop the in-memory buffer, then nearest-neighbour resize.
    var sub = [UInt8](repeating: 0, count: w * h * 4)
    for ry in 0..<h {
      for rx in 0..<w {
        let sx = min(width - 1, max(0, x + rx))
        let sy = min(height - 1, max(0, y + ry))
        let so = (sy * width + sx) * 4
        let dor = (ry * w + rx) * 4
        sub[dor] = pixels[so]; sub[dor + 1] = pixels[so + 1]
        sub[dor + 2] = pixels[so + 2]; sub[dor + 3] = pixels[so + 3]
      }
    }
    let cropImg = RGBAImage(width: w, height: h, pixels: sub)
    return RGBAImage(width: out, height: out, pixels: RGBAImage.nearestResize(cropImg, out, out))
  }

  // MARK: - Rendering

  /// Draw a CGImage into an RGBA8 context at `width × height`, top-left origin.
  private static func render(_ cg: CGImage, width: Int, height: Int) -> [UInt8] {
    let bytesPerRow = width * 4
    var buffer = [UInt8](repeating: 0, count: bytesPerRow * height)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue

    buffer.withUnsafeMutableBytes { ptr in
      guard let ctx = CGContext(data: ptr.baseAddress,
                                width: width, height: height,
                                bitsPerComponent: 8, bytesPerRow: bytesPerRow,
                                space: colorSpace, bitmapInfo: bitmapInfo) else { return }
      // Flip so row 0 is the top of the image (CoreGraphics is bottom-left by default).
      ctx.translateBy(x: 0, y: CGFloat(height))
      ctx.scaleBy(x: 1, y: -1)
      ctx.draw(cg, in: CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
    }
    return buffer
  }

  /// Nearest-neighbour resize for buffer-only images (no CGImage available).
  private static func nearestResize(_ img: RGBAImage, _ w: Int, _ h: Int) -> [UInt8] {
    var out = [UInt8](repeating: 0, count: w * h * 4)
    for dy in 0..<h {
      let sy = dy * img.height / h
      for dx in 0..<w {
        let sx = dx * img.width / w
        let so = (sy * img.width + sx) * 4
        let dor = (dy * w + dx) * 4
        out[dor] = img.pixels[so]; out[dor + 1] = img.pixels[so + 1]
        out[dor + 2] = img.pixels[so + 2]; out[dor + 3] = img.pixels[so + 3]
      }
    }
    return out
  }
}
