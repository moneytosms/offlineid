//
//  FaceEngine.swift
//  OfflineID — iOS native face detection, liveness, and recognition via ONNX Runtime.
//
//  Swift port of the Android `FaceEngineModule.kt`. Bridges the same four ONNX models
//  to React Native with an identical contract (see src/services/FaceEngine.ts), so no
//  JavaScript changes are needed once this module is linked:
//
//    - SCRFD-500M       face detector   (1×3×640×640, RGB)
//    - MobileFaceNet    INT8 recogniser (1×3×112×112, RGB, ArcFace-aligned)
//    - FASNet 2.7 / 4.0 liveness        (1×3×80×80,  BGR)
//
//  All preprocessing formulas/constants are ported verbatim from MODEL_PIPELINE.md §3
//  and kept byte-for-byte equal to the Kotlin implementation. No OpenCV — the ArcFace
//  similarity transform is solved manually (normal equations + Gaussian elimination).
//
//  Threading: every inference runs on a dedicated serial DispatchQueue ("OrtInference"),
//  mirroring the Android HandlerThread. The ORTEnv and all ORTSession objects are created
//  once in initModels().
//
//  Build note (not wired into the Xcode project here): add `pod 'onnxruntime-objc'` to the
//  Podfile, add the 4 .onnx files to the app target's "Copy Bundle Resources", and create a
//  bridging header that imports <React/RCTBridgeModule.h>. See ios/FaceEngine/README.md.
//

import Foundation
import UIKit
import onnxruntime_objc

@objc(FaceEngine)
final class FaceEngine: NSObject {

  // MARK: - ONNX singletons

  private var env: ORTEnv?
  private var detectorSession: ORTSession?      // scrfd_500m_fixed.onnx
  private var recogniserSession: ORTSession?    // mobilefacenet_int8.onnx
  private var liveness27Session: ORTSession?    // fasnet_2_7.onnx
  private var liveness40Session: ORTSession?    // fasnet_4_0.onnx

  /// Dedicated serial inference queue (matches Android's HandlerThread).
  private let inferenceQueue = DispatchQueue(label: "OrtInference")

  // MARK: - Constants (companion object parity)

  private static let SCRFD_SIZE = 640
  private static let MOBILEFACENET_SIZE = 112
  private static let FASNET_SIZE = 80

  private static let SCRFD_SCORE_THRESHOLD: Float = 0.5
  private static let SCRFD_NMS_THRESHOLD: Float = 0.4
  private static let FASNET_THRESHOLD: Float = 0.6

  /// ArcFace destination landmarks in the 112×112 output space (MODEL_PIPELINE §3.2).
  private static let ARCFACE_DST: [[Float]] = [
    [38.2946, 51.6963],   // left eye
    [73.5318, 51.5014],   // right eye
    [56.0252, 71.7366],   // nose tip
    [41.5493, 92.3655],   // left mouth corner
    [70.7299, 92.2041],   // right mouth corner
  ]

  @objc static func requiresMainQueueSetup() -> Bool { false }

  // MARK: - Lifecycle

  /// Load the four ONNX sessions from the app bundle on the inference queue.
  /// CPU execution provider only — reliable on every device and meets the latency budget.
  @objc(initModels:rejecter:)
  func initModels(_ resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    inferenceQueue.async {
      do {
        if self.detectorSession != nil {
          resolve("Models already loaded")
          return
        }
        let ortEnv = try ORTEnv(loggingLevel: ORTLoggingLevel.warning)
        self.env = ortEnv

        self.detectorSession = try self.loadModel(ortEnv, "scrfd_500m_fixed")
        self.recogniserSession = try self.loadModel(ortEnv, "mobilefacenet_int8")
        self.liveness27Session = try self.loadModel(ortEnv, "fasnet_2_7")
        self.liveness40Session = try self.loadModel(ortEnv, "fasnet_4_0")

        resolve("Models loaded")
      } catch {
        self.releaseInternal()
        reject("INIT_ERROR", error.localizedDescription, error)
      }
    }
  }

  @objc(releaseModels:rejecter:)
  func releaseModels(_ resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
    inferenceQueue.async {
      self.releaseInternal()
      resolve("Models released")
    }
  }

  private func releaseInternal() {
    detectorSession = nil
    recogniserSession = nil
    liveness27Session = nil
    liveness40Session = nil
    env = nil
  }

  /// Build CPU session options and load a model from the main bundle (`name.onnx`).
  private func loadModel(_ ortEnv: ORTEnv, _ name: String) throws -> ORTSession {
    guard let path = Bundle.main.path(forResource: name, ofType: "onnx") else {
      throw NSError(domain: "FaceEngine", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Model \(name).onnx not found in bundle"])
    }
    let opts = try ORTSessionOptions()
    try opts.setIntraOpNumThreads(2)
    return try ORTSession(env: ortEnv, modelPath: path, sessionOptions: opts)
  }

  // MARK: - detectFace (SCRFD)

  /// Detect the single most-confident face in a base64 frame. Resolves with
  /// `{found, bbox{x,y,w,h}, landmarks[[x,y]×5], confidence}` — identical to Android.
  @objc(detectFace:resolver:rejecter:)
  func detectFace(_ base64Frame: String,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    inferenceQueue.async {
      do {
        guard let session = self.detectorSession, let ortEnv = self.env else {
          throw NSError(domain: "FaceEngine", code: 2,
                        userInfo: [NSLocalizedDescriptionKey: "Models not initialised"])
        }

        let image = try self.decodeImage(base64Frame)
        let origW = image.width
        let origH = image.height
        let scaleX = Float(origW) / Float(Self.SCRFD_SIZE)
        let scaleY = Float(origH) / Float(Self.SCRFD_SIZE)

        // Resize whole frame to 640², CHW, RGB, (px-127.5)/128.
        let resized = image.resized(to: Self.SCRFD_SIZE, Self.SCRFD_SIZE)
        let input = Self.preprocessForScrfd(resized)
        let shape: [NSNumber] = [1, 3, NSNumber(value: Self.SCRFD_SIZE), NSNumber(value: Self.SCRFD_SIZE)]

        let outputs = try self.run(session, ortEnv, input: input, inputShape: shape)
        let detections = self.parseScrfdOutputs(outputs)

        if detections.isEmpty {
          resolve(["found": false])
          return
        }

        let best = detections[0]   // post-NMS list sorted by score desc
        var landmarks: [[Double]] = []
        for i in 0..<5 {
          landmarks.append([
            Double(best.kps[i * 2] * scaleX),
            Double(best.kps[i * 2 + 1] * scaleY),
          ])
        }

        resolve([
          "found": true,
          "confidence": Double(best.score),
          "bbox": [
            "x": Double(best.x1 * scaleX),
            "y": Double(best.y1 * scaleY),
            "w": Double((best.x2 - best.x1) * scaleX),
            "h": Double((best.y2 - best.y1) * scaleY),
          ],
          "landmarks": landmarks,
        ])
      } catch {
        reject("DETECT_ERROR", error.localizedDescription, error)
      }
    }
  }

  // MARK: - checkLiveness (FASNet)

  /// Passive liveness on the bbox crop using the scale-appropriate FASNet (BGR).
  /// Resolves with `{isLive, score}`; threshold 0.6 on the "real" class (index 2).
  @objc(checkLiveness:bbox:scale:resolver:rejecter:)
  func checkLiveness(_ base64Frame: String,
                     bbox bboxArray: NSArray,
                     scale: NSNumber,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
    inferenceQueue.async {
      do {
        guard let ortEnv = self.env else {
          throw NSError(domain: "FaceEngine", code: 2,
                        userInfo: [NSLocalizedDescriptionKey: "Env not initialised"])
        }
        let scaleF = scale.floatValue
        let session = (scaleF < 3.0 ? self.liveness27Session : self.liveness40Session)
        guard let session = session else {
          throw NSError(domain: "FaceEngine", code: 2,
                        userInfo: [NSLocalizedDescriptionKey: "Models not initialised"])
        }

        let image = try self.decodeImage(base64Frame)
        let bbox = [
          (bboxArray[0] as? NSNumber)?.intValue ?? 0,
          (bboxArray[1] as? NSNumber)?.intValue ?? 0,
          (bboxArray[2] as? NSNumber)?.intValue ?? 0,
          (bboxArray[3] as? NSNumber)?.intValue ?? 0,
        ]

        let input = Self.preprocessForFasnet(image, bbox: bbox, scale: scaleF, outSize: Self.FASNET_SIZE)
        let shape: [NSNumber] = [1, 3, NSNumber(value: Self.FASNET_SIZE), NSNumber(value: Self.FASNET_SIZE)]

        let outputs = try self.run(session, ortEnv, input: input, inputShape: shape)
        let logits = outputs[0].floats   // [3] class logits
        let realScore = Self.parseFasnetOutput(logits)

        resolve([
          "isLive": realScore > Self.FASNET_THRESHOLD,
          "score": Double(realScore),
        ])
      } catch {
        reject("LIVENESS_ERROR", error.localizedDescription, error)
      }
    }
  }

  // MARK: - getEmbedding (ArcFace align + MobileFaceNet)

  /// 512-d L2-normalised embedding from a base64 frame + 5 landmarks (JSON `[[x,y]×5]`).
  /// Resolves with `{embedding:number[512], inferenceMs}`.
  @objc(getEmbedding:landmarksJson:resolver:rejecter:)
  func getEmbedding(_ base64Frame: String,
                    landmarksJson: String,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    inferenceQueue.async {
      do {
        guard let session = self.recogniserSession, let ortEnv = self.env else {
          throw NSError(domain: "FaceEngine", code: 2,
                        userInfo: [NSLocalizedDescriptionKey: "Models not initialised"])
        }

        let image = try self.decodeImage(base64Frame)
        let landmarks = try Self.parseLandmarks(landmarksJson)

        // ArcFace alignment → 112² aligned crop.
        let m = Self.estimateNorm(landmarks)
        let aligned = Self.warpAffine(image, m: m, outSize: Self.MOBILEFACENET_SIZE)

        let input = Self.preprocessForMobileFaceNet(aligned)
        let shape: [NSNumber] = [1, 3, NSNumber(value: Self.MOBILEFACENET_SIZE), NSNumber(value: Self.MOBILEFACENET_SIZE)]

        let start = DispatchTime.now()
        let outputs = try self.run(session, ortEnv, input: input, inputShape: shape)
        let inferMs = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000.0

        let raw = outputs[0].floats   // [512]

        // L2-normalise.
        var sumSq = 0.0
        for v in raw { sumSq += Double(v) * Double(v) }
        let norm = sumSq.squareRoot() == 0 ? 1.0 : sumSq.squareRoot()
        let embedding = raw.map { Double($0) / norm }

        resolve(["embedding": embedding, "inferenceMs": inferMs])
      } catch {
        reject("EMBED_ERROR", error.localizedDescription, error)
      }
    }
  }

  // MARK: - ORT run helper

  /// Wrap a CHW float tensor, run the session, and return outputs as flat float arrays
  /// with their shapes (mirrors how the Kotlin code consumes OrtSession.Result).
  private func run(_ session: ORTSession,
                   _ ortEnv: ORTEnv,
                   input: [Float],
                   inputShape: [NSNumber]) throws -> [(floats: [Float], shape: [Int])] {
    let data = NSMutableData(bytes: input, length: input.count * MemoryLayout<Float>.size)
    let inputValue = try ORTValue(tensorData: data,
                                  elementType: ORTTensorElementDataType.float,
                                  shape: inputShape)

    let inputName = try session.inputNames()[0]
    let outputNames = try session.outputNames()
    let outputs = try session.run(withInputs: [inputName: inputValue],
                                  outputNames: Set(outputNames),
                                  runOptions: ORTRunOptions())

    // Preserve declared output order so SCRFD bucketing stays deterministic.
    return try outputNames.map { name in
      let value = outputs[name]!
      let info = try value.tensorTypeAndShapeInfo()
      let shape = info.shape.map { $0.intValue }
      let raw = try value.tensorData() as Data
      let floats = raw.withUnsafeBytes { ptr -> [Float] in
        Array(ptr.bindMemory(to: Float.self))
      }
      return (floats, shape)
    }
  }

  // MARK: - Image decode / pixel helpers

  /// Decode a base64 (JPEG/PNG) string into an RGBA pixel image (row-major, top-left origin).
  private func decodeImage(_ base64: String) throws -> RGBAImage {
    guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters),
          let uiImage = UIImage(data: data),
          let cg = uiImage.cgImage else {
      throw NSError(domain: "FaceEngine", code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "Failed to decode base64 frame"])
    }
    return RGBAImage(cgImage: cg, width: cg.width, height: cg.height)
  }

  /// Parse a JSON array of 5 `[x, y]` pairs into a `[5][2]` landmark array.
  private static func parseLandmarks(_ json: String) throws -> [[Float]] {
    guard let data = json.data(using: .utf8),
          let arr = try JSONSerialization.jsonObject(with: data) as? [[Any]],
          arr.count == 5 else {
      throw NSError(domain: "FaceEngine", code: 4,
                    userInfo: [NSLocalizedDescriptionKey: "Expected 5 landmarks"])
    }
    return arr.map { pt in
      [Float(truncating: pt[0] as! NSNumber), Float(truncating: pt[1] as! NSNumber)]
    }
  }

  // MARK: - Preprocessing (MODEL_PIPELINE §3)

  /// §3.1 — SCRFD: 640² resized image, (px-127.5)/128, CHW, RGB.
  private static func preprocessForScrfd(_ img: RGBAImage) -> [Float] {
    let n = SCRFD_SIZE * SCRFD_SIZE
    var out = [Float](repeating: 0, count: 3 * n)
    let p = img.pixels
    for i in 0..<n {
      let o = i * 4
      out[i]         = (Float(p[o])     - 127.5) / 128.0   // R
      out[n + i]     = (Float(p[o + 1]) - 127.5) / 128.0   // G
      out[2 * n + i] = (Float(p[o + 2]) - 127.5) / 128.0   // B
    }
    return out
  }

  /// §3.3 — MobileFaceNet: 112² aligned crop, (px-127.5)/127.5, CHW, RGB.
  private static func preprocessForMobileFaceNet(_ img: RGBAImage) -> [Float] {
    let size = MOBILEFACENET_SIZE
    let n = size * size
    var out = [Float](repeating: 0, count: 3 * n)
    let p = img.pixels
    for i in 0..<n {
      let o = i * 4
      out[i]         = (Float(p[o])     - 127.5) / 127.5   // R
      out[n + i]     = (Float(p[o + 1]) - 127.5) / 127.5   // G
      out[2 * n + i] = (Float(p[o + 2]) - 127.5) / 127.5   // B
    }
    return out
  }

  /// §3.4 — FASNet: scale-crop the bbox, resize to 80², normalise in **BGR** order with
  /// mean=[0.406,0.456,0.485] std=[0.225,0.224,0.229]. BGR is mandatory.
  private static func preprocessForFasnet(_ src: RGBAImage, bbox: [Int], scale: Float, outSize: Int) -> [Float] {
    let cx = Float(bbox[0]) + Float(bbox[2]) / 2.0
    let cy = Float(bbox[1]) + Float(bbox[3]) / 2.0
    let newW = Int(Float(bbox[2]) * scale)
    let newH = Int(Float(bbox[3]) * scale)
    let x1 = max(0, Int(cx - Float(newW) / 2.0))
    let y1 = max(0, Int(cy - Float(newH) / 2.0))
    let x2 = min(src.width, x1 + newW)
    let y2 = min(src.height, y1 + newH)
    let cropW = max(1, x2 - x1)
    let cropH = max(1, y2 - y1)

    let resized = src.cropResized(x: x1, y: y1, w: cropW, h: cropH, to: outSize)

    let mean: [Float] = [0.406, 0.456, 0.485]   // B, G, R
    let std: [Float] = [0.225, 0.224, 0.229]
    let n = outSize * outSize
    var out = [Float](repeating: 0, count: 3 * n)
    let p = resized.pixels
    for i in 0..<n {
      let o = i * 4
      let r = Float(p[o])     / 255.0
      let g = Float(p[o + 1]) / 255.0
      let b = Float(p[o + 2]) / 255.0
      out[i]         = (b - mean[0]) / std[0]   // B (channel 0)
      out[n + i]     = (g - mean[1]) / std[1]   // G (channel 1)
      out[2 * n + i] = (r - mean[2]) / std[2]   // R (channel 2)
    }
    return out
  }

  // MARK: - FASNet softmax (§3.5)

  /// Softmax over the 3-class FASNet logits; return P(real). Live class is index 2.
  private static func parseFasnetOutput(_ output: [Float]) -> Float {
    let maxVal = output.max() ?? 0
    var sumExp = 0.0
    var expVals = [Double](repeating: 0, count: output.count)
    for i in 0..<output.count {
      let e = exp(Double(output[i] - maxVal)); expVals[i] = e; sumExp += e
    }
    let realIdx = output.count >= 3 ? 2 : output.count - 1
    return Float(expVals[realIdx] / sumExp)
  }

  // MARK: - ArcFace similarity transform (§3.2)

  /// Estimate a 2×3 affine mapping the 5 source landmarks to the ArcFace destinations,
  /// returned as `[m00,m01,m02,m10,m11,m12]`. Fits `[a,b,tx,ty]` by least squares.
  private static func estimateNorm(_ landmarks: [[Float]]) -> [Float] {
    let n = 5
    let srcX = (0..<n).map { Double(landmarks[$0][0]) }
    let srcY = (0..<n).map { Double(landmarks[$0][1]) }
    let dstX = (0..<n).map { Double(ARCFACE_DST[$0][0]) }
    let dstY = (0..<n).map { Double(ARCFACE_DST[$0][1]) }

    var a = [[Double]](repeating: [Double](repeating: 0, count: 4), count: 2 * n)
    var rhs = [Double](repeating: 0, count: 2 * n)
    for i in 0..<n {
      a[i][0] = srcX[i]; a[i][1] = -srcY[i]; a[i][2] = 1.0; a[i][3] = 0.0
      rhs[i] = dstX[i]
      a[n + i][0] = srcY[i]; a[n + i][1] = srcX[i]; a[n + i][2] = 0.0; a[n + i][3] = 1.0
      rhs[n + i] = dstY[i]
    }
    let p = solveLeastSquares(a, rhs)   // [a_, b_, tx, ty]
    let aa = p[0], bb = p[1], tx = p[2], ty = p[3]
    return [Float(aa), Float(-bb), Float(tx), Float(bb), Float(aa), Float(ty)]
  }

  /// Solve over-determined `A·x = b` via normal equations + Gaussian elimination.
  private static func solveLeastSquares(_ matA: [[Double]], _ b: [Double]) -> [Double] {
    let rows = matA.count
    let cols = matA[0].count
    var ata = [[Double]](repeating: [Double](repeating: 0, count: cols), count: cols)
    var atb = [Double](repeating: 0, count: cols)
    for i in 0..<cols {
      for j in 0..<cols {
        var s = 0.0
        for k in 0..<rows { s += matA[k][i] * matA[k][j] }
        ata[i][j] = s
      }
      var s = 0.0
      for k in 0..<rows { s += matA[k][i] * b[k] }
      atb[i] = s
    }
    return gaussianSolve(ata, atb)
  }

  /// Gaussian elimination with partial pivoting for a square system `M·x = v`.
  private static func gaussianSolve(_ m: [[Double]], _ v: [Double]) -> [Double] {
    let n = v.count
    var a = [[Double]](repeating: [Double](repeating: 0, count: n + 1), count: n)
    for i in 0..<n {
      for j in 0..<n { a[i][j] = m[i][j] }
      a[i][n] = v[i]
    }
    for col in 0..<n {
      var pivot = col
      for r in (col + 1)..<n where abs(a[r][col]) > abs(a[pivot][col]) { pivot = r }
      a.swapAt(col, pivot)
      let diag = a[col][col]
      precondition(abs(diag) > 1e-12, "Singular matrix in alignment solve")
      for r in 0..<n where r != col {
        let factor = a[r][col] / diag
        for c in col...n { a[r][c] -= factor * a[col][c] }
      }
    }
    return (0..<n).map { a[$0][n] / a[$0][$0] }
  }

  /// Apply the 2×3 affine [m] to [src] via inverse mapping + nearest-neighbour sampling.
  private static func warpAffine(_ src: RGBAImage, m: [Float], outSize: Int) -> RGBAImage {
    let srcW = src.width, srcH = src.height
    let sp = src.pixels
    var dst = [UInt8](repeating: 0, count: outSize * outSize * 4)

    let det = m[0] * m[4] - m[1] * m[3]
    precondition(abs(det) > 1e-12, "Non-invertible affine matrix")
    let invDet = 1.0 / det
    let i00 = m[4] * invDet
    let i01 = -m[1] * invDet
    let i10 = -m[3] * invDet
    let i11 = m[0] * invDet

    for dy in 0..<outSize {
      for dx in 0..<outSize {
        let tx = Float(dx) - m[2]
        let ty = Float(dy) - m[5]
        let sx = Int(i00 * tx + i01 * ty)
        let sy = Int(i10 * tx + i11 * ty)
        if sx >= 0 && sx < srcW && sy >= 0 && sy < srcH {
          let so = (sy * srcW + sx) * 4
          let do_ = (dy * outSize + dx) * 4
          dst[do_]     = sp[so]
          dst[do_ + 1] = sp[so + 1]
          dst[do_ + 2] = sp[so + 2]
          dst[do_ + 3] = 255
        }
      }
    }
    return RGBAImage(width: outSize, height: outSize, pixels: dst)
  }

  // MARK: - SCRFD FPN decoding + NMS

  private struct Detection {
    let score: Float
    let x1: Float, y1: Float, x2: Float, y2: Float
    let kps: [Float]   // 10 = 5 × (x, y)
  }

  /// Decode the 9 SCRFD FPN outputs into detections and run NMS. Outputs are bucketed by
  /// feature count (1→score, 4→bbox, 10→kps) so the routine is robust to output ordering.
  private func parseScrfdOutputs(_ outputs: [(floats: [Float], shape: [Int])]) -> [Detection] {
    var scores: [[[Float]]] = []
    var bboxes: [[[Float]]] = []
    var kpses: [[[Float]]] = []

    for out in outputs {
      guard let arr = Self.to2D(out.floats, out.shape) else { continue }
      switch arr.first?.count ?? 0 {
      case 1: scores.append(arr)
      case 4: bboxes.append(arr)
      case 10: kpses.append(arr)
      default: break
      }
    }

    // Order each bucket by anchor count desc (stride 8 → 16 → 32).
    scores.sort { $0.count > $1.count }
    bboxes.sort { $0.count > $1.count }
    kpses.sort { $0.count > $1.count }

    let strides = [8, 16, 32]
    var dets: [Detection] = []
    let levels = min(scores.count, bboxes.count, strides.count)

    for lvl in 0..<levels {
      let stride = strides[lvl]
      let scoreArr = scores[lvl]
      let bboxArr = bboxes[lvl]
      let kpsArr: [[Float]]? = lvl < kpses.count ? kpses[lvl] : nil
      let numAnchors = scoreArr.count

      let featW = Self.SCRFD_SIZE / stride
      let centers = Self.buildAnchorCenters(featW: featW, numAnchors: numAnchors, stride: stride)

      for idx in 0..<numAnchors {
        let score = scoreArr[idx][0]
        if score < Self.SCRFD_SCORE_THRESHOLD { continue }

        let cx = centers[idx * 2]
        let cy = centers[idx * 2 + 1]

        let l = bboxArr[idx][0] * Float(stride)
        let t = bboxArr[idx][1] * Float(stride)
        let r = bboxArr[idx][2] * Float(stride)
        let btm = bboxArr[idx][3] * Float(stride)

        var kps = [Float](repeating: 0, count: 10)
        if let k = kpsArr?[idx] {
          for p in 0..<5 {
            kps[p * 2]     = cx + k[p * 2] * Float(stride)
            kps[p * 2 + 1] = cy + k[p * 2 + 1] * Float(stride)
          }
        }
        dets.append(Detection(score: score, x1: cx - l, y1: cy - t, x2: cx + r, y2: cy + btm, kps: kps))
      }
    }
    return nms(dets, Self.SCRFD_NMS_THRESHOLD)
  }

  /// Build anchor centres for one FPN level (row-major grid, anchorsPerLoc anchors/cell).
  private static func buildAnchorCenters(featW: Int, numAnchors: Int, stride: Int) -> [Float] {
    let locations = featW * featW
    let anchorsPerLoc = locations > 0 ? max(1, numAnchors / locations) : 1
    var centers = [Float](repeating: 0, count: numAnchors * 2)
    var idx = 0
    for y in 0..<featW {
      for x in 0..<featW {
        let cx = (Float(x) + 0.5) * Float(stride)
        let cy = (Float(y) + 0.5) * Float(stride)
        for _ in 0..<anchorsPerLoc {
          if idx >= numAnchors { break }
          centers[idx * 2] = cx
          centers[idx * 2 + 1] = cy
          idx += 1
        }
      }
    }
    return centers
  }

  /// Greedy IoU non-maximum suppression; returns detections sorted by score desc.
  private func nms(_ dets: [Detection], _ iouThreshold: Float) -> [Detection] {
    var sorted = dets.sorted { $0.score > $1.score }
    var kept: [Detection] = []
    while !sorted.isEmpty {
      let best = sorted.removeFirst()
      kept.append(best)
      sorted.removeAll { iou(best, $0) > iouThreshold }
    }
    return kept
  }

  private func iou(_ a: Detection, _ b: Detection) -> Float {
    let ix1 = max(a.x1, b.x1), iy1 = max(a.y1, b.y1)
    let ix2 = min(a.x2, b.x2), iy2 = min(a.y2, b.y2)
    let iw = max(0, ix2 - ix1), ih = max(0, iy2 - iy1)
    let inter = iw * ih
    let areaA = max(0, a.x2 - a.x1) * max(0, a.y2 - a.y1)
    let areaB = max(0, b.x2 - b.x1) * max(0, b.y2 - b.y1)
    let union = areaA + areaB - inter
    return union <= 0 ? 0 : inter / union
  }

  /// Coerce a flat output + shape to `[rows][feat]`, handling [rows,feat] and [1,rows,feat].
  private static func to2D(_ floats: [Float], _ shape: [Int]) -> [[Float]]? {
    let dims = shape.count == 3 ? [shape[1], shape[2]] :
               shape.count == 2 ? [shape[0], shape[1]] : nil
    guard let dims = dims, dims[0] > 0, dims[1] > 0 else { return nil }
    let rows = dims[0], feat = dims[1]
    guard floats.count >= rows * feat else { return nil }
    var out = [[Float]](repeating: [Float](repeating: 0, count: feat), count: rows)
    for r in 0..<rows {
      for c in 0..<feat { out[r][c] = floats[r * feat + c] }
    }
    return out
  }
}
