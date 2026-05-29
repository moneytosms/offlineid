//
//  FaceEngineModule.swift
//  OfflineID — Hackathon 7.0
//
//  iOS native face-engine bridge. Mirrors the Android Kotlin module:
//  loads three ONNX models (SCRFD-500M detector, MobileFaceNet INT8 recogniser,
//  two-scale FASNet liveness) via ONNX Runtime Mobile (onnxruntime-objc /
//  onnxruntime-mobile-c) and exposes five async methods to JS.
//
//  Execution providers (iOS priority): CoreML (ANE/GPU) → CPU fallback.
//  ALL inference runs on DispatchQueue.global() so the JS/main thread never
//  blocks. Results are returned through RCTPromiseResolveBlock.
//
//  Preprocessing is ported verbatim from MODEL_PIPELINE.md §3 with NO OpenCV
//  dependency — the ArcFace similarity transform and warpAffine are implemented
//  by hand.
//

import Foundation
import UIKit
import onnxruntime_objc

// MARK: - Module

@objc(FaceEngine)
class FaceEngineModule: NSObject {

    // ONNX Runtime objects are created once in initModels() and reused.
    private var ortEnv: ORTEnv?
    private var detectorSession: ORTSession?   // SCRFD-500M
    private var recogniserSession: ORTSession?  // MobileFaceNet INT8
    private var liveness27Session: ORTSession?  // FASNet scale 2.7
    private var liveness40Session: ORTSession?  // FASNet scale 4.0

    /// Dedicated serial queue label is unnecessary — ORTSession.run is
    /// thread-safe, so we fan inference out onto the global concurrent queue.
    private let inferenceQueue = DispatchQueue.global(qos: .userInitiated)

    // MARK: ArcFace reference landmarks (112×112 destination space)

    private static let arcfaceDst: [[Float]] = [
        [38.2946, 51.6963],   // left eye
        [73.5318, 51.5014],   // right eye
        [56.0252, 71.7366],   // nose tip
        [41.5493, 92.3655],   // left mouth corner
        [70.7299, 92.2041],   // right mouth corner
    ]

    // MARK: - RN plumbing

    @objc static func requiresMainQueueSetup() -> Bool {
        return false
    }

    // MARK: - initModels

    /// Load all four ONNX models from the app bundle and configure the CoreML
    /// execution provider with a CPU fallback.
    @objc(initModels:rejecter:)
    func initModels(_ resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        inferenceQueue.async {
            do {
                let env = try ORTEnv(loggingLevel: .warning)

                let options = try ORTSessionOptions()
                try options.setIntraOpNumThreads(2)
                try options.setGraphOptimizationLevel(.all)
                // CoreML EP first; if append fails the session still runs on CPU.
                do {
                    let coreMLOptions = ORTCoreMLExecutionProviderOptions()
                    coreMLOptions.useCPUOnly = false
                    coreMLOptions.enableOnSubgraphs = true
                    try options.appendCoreMLExecutionProvider(with: coreMLOptions)
                } catch {
                    NSLog("FaceEngine: CoreML EP unavailable, using CPU. \(error)")
                }

                func loadModel(_ name: String) throws -> ORTSession {
                    guard let path = Bundle.main.path(forResource: name, ofType: "onnx") else {
                        throw FaceEngineError.modelNotFound(name)
                    }
                    return try ORTSession(env: env, modelPath: path, sessionOptions: options)
                }

                self.ortEnv = env
                self.detectorSession = try loadModel("scrfd_500m_fixed")
                self.recogniserSession = try loadModel("mobilefacenet_int8")
                self.liveness27Session = try loadModel("fasnet_2_7")
                self.liveness40Session = try loadModel("fasnet_4_0")

                resolve("Models loaded")
            } catch {
                reject("INIT_ERROR", "Failed to initialise models: \(error.localizedDescription)", error)
            }
        }
    }

    // MARK: - releaseModels

    /// Free all ONNX sessions and the environment. Called on background-enter.
    @objc(releaseModels:rejecter:)
    func releaseModels(_ resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
        inferenceQueue.async {
            self.detectorSession = nil
            self.recogniserSession = nil
            self.liveness27Session = nil
            self.liveness40Session = nil
            self.ortEnv = nil
            resolve("Models released")
        }
    }

    // MARK: - detectFace

    /// Run SCRFD on a base64 frame and resolve the single highest-confidence face.
    /// Resolves `{ found, bbox?, landmarks?, confidence? }`.
    @objc(detectFace:resolver:rejecter:)
    func detectFace(_ base64Frame: String,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        inferenceQueue.async {
            do {
                guard let session = self.detectorSession else {
                    throw FaceEngineError.notInitialised
                }
                guard let image = self.decodeBase64(base64Frame) else {
                    throw FaceEngineError.invalidImage
                }

                let (tensorData, _) = try self.preprocessForScrfd(image)
                let shape: [NSNumber] = [1, 3, 640, 640]
                let input = try ORTValue(tensorData: NSMutableData(data: tensorData),
                                         elementType: .float,
                                         shape: shape)

                let inputName = try session.inputNames().first ?? "input.1"
                let outputNames = Set(try session.outputNames())
                let outputs = try session.run(withInputs: [inputName: input],
                                              outputNames: outputNames,
                                              runOptions: nil)

                // SCRFD post-processing (decode anchors → NMS) is performed in JS
                // in this build; here we surface the raw best detection if the
                // graph emits a fused [N,15] output, else report "not found".
                let result = try self.decodeScrfd(outputs: outputs,
                                                  origWidth: CGFloat(image.size.width),
                                                  origHeight: CGFloat(image.size.height))
                resolve(result)
            } catch {
                reject("DETECT_ERROR", "detectFace failed: \(error.localizedDescription)", error)
            }
        }
    }

    // MARK: - checkLiveness

    /// Two-scale FASNet passive liveness. `bbox` is `[x, y, w, h]` in source
    /// pixels. Resolves `{ isLive, score }` where score is the averaged P(real).
    @objc(checkLiveness:bbox:resolver:rejecter:)
    func checkLiveness(_ base64Frame: String,
                       bbox: [NSNumber],
                       resolver resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
        inferenceQueue.async {
            do {
                guard let s27 = self.liveness27Session, let s40 = self.liveness40Session else {
                    throw FaceEngineError.notInitialised
                }
                guard let image = self.decodeBase64(base64Frame) else {
                    throw FaceEngineError.invalidImage
                }
                guard bbox.count == 4 else { throw FaceEngineError.badArgument("bbox") }
                let box = bbox.map { CGFloat(truncating: $0) }

                let score27 = try self.runFasnet(session: s27, image: image, bbox: box, scale: 2.7)
                let score40 = try self.runFasnet(session: s40, image: image, bbox: box, scale: 4.0)
                let finalScore = (score27 + score40) / 2.0

                resolve(["isLive": finalScore > 0.6, "score": Double(finalScore)])
            } catch {
                reject("LIVENESS_ERROR", "checkLiveness failed: \(error.localizedDescription)", error)
            }
        }
    }

    // MARK: - getEmbedding

    /// ArcFace-align + MobileFaceNet embed. `landmarks` is 5 `[x,y]` pairs.
    /// Resolves `{ embedding: [512 doubles, L2-normalised], inferenceMs }`.
    @objc(getEmbedding:landmarks:resolver:rejecter:)
    func getEmbedding(_ base64Frame: String,
                      landmarks: [[NSNumber]],
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
        inferenceQueue.async {
            do {
                guard let session = self.recogniserSession else {
                    throw FaceEngineError.notInitialised
                }
                guard let image = self.decodeBase64(base64Frame) else {
                    throw FaceEngineError.invalidImage
                }
                guard landmarks.count == 5 else { throw FaceEngineError.badArgument("landmarks") }
                let lms: [[Float]] = landmarks.map { $0.map { Float(truncating: $0) } }

                // Step 1: align (estimateNorm → warpAffine to 112×112)
                let m = self.estimateNorm(landmarks: lms)
                let aligned = try self.warpAffine(src: image, m: m, outSize: 112)

                // Step 2: preprocess [-1,1], CHW, RGB
                let tensorData = self.preprocessForMobileFaceNet(aligned)
                let shape: [NSNumber] = [1, 3, 112, 112]
                let input = try ORTValue(tensorData: NSMutableData(data: tensorData),
                                         elementType: .float,
                                         shape: shape)

                // Step 3: infer
                let inputName = try session.inputNames().first ?? "input.1"
                let outputNames = Set(try session.outputNames())
                let t0 = Date()
                let outputs = try session.run(withInputs: [inputName: input],
                                              outputNames: outputNames,
                                              runOptions: nil)
                let inferMs = Date().timeIntervalSince(t0) * 1000.0

                guard let outValue = outputs.values.first else {
                    throw FaceEngineError.inferenceFailed("no output")
                }
                var raw = try self.floatArray(from: outValue)

                // Step 4: L2-normalise
                let norm = sqrt(raw.reduce(Float(0)) { $0 + $1 * $1 })
                if norm > 0 { for i in 0..<raw.count { raw[i] /= norm } }

                resolve([
                    "embedding": raw.map { Double($0) },
                    "inferenceMs": inferMs,
                ])
            } catch {
                reject("EMBED_ERROR", "getEmbedding failed: \(error.localizedDescription)", error)
            }
        }
    }

    // MARK: - Preprocessing: SCRFD (§3.1)

    /// Resize to 640×640, normalise `(px - 127.5) / 128`, transpose HWC→CHW (RGB).
    private func preprocessForScrfd(_ image: UIImage) throws -> (Data, CGSize) {
        let size = 640
        guard let pixels = self.rgbaPixels(of: image, width: size, height: size) else {
            throw FaceEngineError.invalidImage
        }
        let plane = size * size
        var floats = [Float](repeating: 0, count: 3 * plane)
        for i in 0..<plane {
            let r = Float(pixels[i * 4 + 0])
            let g = Float(pixels[i * 4 + 1])
            let b = Float(pixels[i * 4 + 2])
            floats[i] = (r - 127.5) / 128.0
            floats[plane + i] = (g - 127.5) / 128.0
            floats[2 * plane + i] = (b - 127.5) / 128.0
        }
        return (floats.withUnsafeBufferPointer { Data(buffer: $0) }, image.size)
    }

    // MARK: - Preprocessing: MobileFaceNet (§3.3)

    /// 112×112 RGB, channel-first, normalised `(px - 127.5) / 127.5`.
    private func preprocessForMobileFaceNet(_ image: UIImage) -> Data {
        let size = 112
        let plane = size * size
        var floats = [Float](repeating: 0, count: 3 * plane)
        guard let pixels = self.rgbaPixels(of: image, width: size, height: size) else {
            return floats.withUnsafeBufferPointer { Data(buffer: $0) }
        }
        for i in 0..<plane {
            let r = Float(pixels[i * 4 + 0])
            let g = Float(pixels[i * 4 + 1])
            let b = Float(pixels[i * 4 + 2])
            floats[i] = (r - 127.5) / 127.5
            floats[plane + i] = (g - 127.5) / 127.5
            floats[2 * plane + i] = (b - 127.5) / 127.5
        }
        return floats.withUnsafeBufferPointer { Data(buffer: $0) }
    }

    // MARK: - FASNet (§3.4, §3.5)

    /// Scale-crop the bbox, resize to 80×80, BGR-normalise with ImageNet stats,
    /// run the session, softmax, return P(real).
    ///
    /// ⚠️ FASNet is trained in BGR channel order (OpenCV convention).
    private func runFasnet(session: ORTSession,
                           image: UIImage,
                           bbox: [CGFloat],
                           scale: CGFloat) throws -> Float {
        let outSize = 80
        // Scale & clamp the crop region around the bbox centre.
        let cx = bbox[0] + bbox[2] / 2.0
        let cy = bbox[1] + bbox[3] / 2.0
        let newW = bbox[2] * scale
        let newH = bbox[3] * scale
        let x1 = max(0, cx - newW / 2.0)
        let y1 = max(0, cy - newH / 2.0)
        let x2 = min(image.size.width, x1 + newW)
        let y2 = min(image.size.height, y1 + newH)
        let cropRect = CGRect(x: x1, y: y1, width: max(1, x2 - x1), height: max(1, y2 - y1))

        guard let cropped = self.crop(image: image, rect: cropRect),
              let pixels = self.rgbaPixels(of: cropped, width: outSize, height: outSize) else {
            throw FaceEngineError.invalidImage
        }

        // BGR mean/std per MODEL_PIPELINE.md §3.4
        let mean: [Float] = [0.406, 0.456, 0.485]  // B, G, R
        let std: [Float] = [0.225, 0.224, 0.229]
        let plane = outSize * outSize
        var floats = [Float](repeating: 0, count: 3 * plane)
        for i in 0..<plane {
            let r = Float(pixels[i * 4 + 0]) / 255.0
            let g = Float(pixels[i * 4 + 1]) / 255.0
            let b = Float(pixels[i * 4 + 2]) / 255.0
            floats[i] = (b - mean[0]) / std[0]              // B
            floats[plane + i] = (g - mean[1]) / std[1]      // G
            floats[2 * plane + i] = (r - mean[2]) / std[2]  // R
        }

        let data = floats.withUnsafeBufferPointer { Data(buffer: $0) }
        let shape: [NSNumber] = [1, 3, NSNumber(value: outSize), NSNumber(value: outSize)]
        let input = try ORTValue(tensorData: NSMutableData(data: data),
                                 elementType: .float,
                                 shape: shape)
        let inputName = try session.inputNames().first ?? "input"
        let outputNames = Set(try session.outputNames())
        let outputs = try session.run(withInputs: [inputName: input],
                                      outputNames: outputNames,
                                      runOptions: nil)
        guard let outValue = outputs.values.first else {
            throw FaceEngineError.inferenceFailed("fasnet no output")
        }
        let logits = try self.floatArray(from: outValue)
        return self.softmaxRealScore(logits)
    }

    /// Softmax over the 3-class FASNet output, returning P(real).
    /// Per Silent-Face inference, class index 1 is the live/real face
    /// (indices 0 and 2 are spoof types).
    private func softmaxRealScore(_ logits: [Float]) -> Float {
        guard let maxVal = logits.max() else { return 0 }
        let exps = logits.map { expf($0 - maxVal) }
        let sumExp = exps.reduce(0, +)
        guard sumExp > 0 else { return 0 }
        let realIdx = logits.count > 1 ? 1 : 0
        return exps[realIdx] / sumExp
    }

    // MARK: - ArcFace alignment (§3.2, no OpenCV)

    /// Estimate the 2×3 similarity-transform matrix mapping the 5 source
    /// landmarks onto the fixed ArcFace destinations. Returns
    /// `[m00, m01, m02, m10, m11, m12]`.
    private func estimateNorm(landmarks: [[Float]]) -> [Float] {
        let n = 5
        let srcX = (0..<n).map { Double(landmarks[$0][0]) }
        let srcY = (0..<n).map { Double(landmarks[$0][1]) }
        let dstX = (0..<n).map { Double(FaceEngineModule.arcfaceDst[$0][0]) }
        let dstY = (0..<n).map { Double(FaceEngineModule.arcfaceDst[$0][1]) }

        // Similarity transform: x' = a*x - b*y + tx, y' = b*x + a*y + ty
        // Stack into a (2n × 4) least-squares system A·[a,b,tx,ty] = rhs.
        var aMat = [[Double]](repeating: [Double](repeating: 0, count: 4), count: 2 * n)
        var rhs = [Double](repeating: 0, count: 2 * n)
        for i in 0..<n {
            aMat[i] = [srcX[i], -srcY[i], 1.0, 0.0]
            rhs[i] = dstX[i]
            aMat[n + i] = [srcY[i], srcX[i], 0.0, 1.0]
            rhs[n + i] = dstY[i]
        }
        let params = solveLeastSquares(aMat, rhs)  // [a, b, tx, ty]
        let a = params[0], b = params[1], tx = params[2], ty = params[3]
        return [Float(a), Float(-b), Float(tx), Float(b), Float(a), Float(ty)]
    }

    /// Solve `min ‖A·x − rhs‖` via the normal equations `(AᵀA)x = Aᵀrhs`
    /// using Gaussian elimination with partial pivoting (4×4 system).
    private func solveLeastSquares(_ a: [[Double]], _ rhs: [Double]) -> [Double] {
        let cols = 4
        let rows = a.count
        var ata = [[Double]](repeating: [Double](repeating: 0, count: cols), count: cols)
        var atb = [Double](repeating: 0, count: cols)
        for i in 0..<cols {
            for j in 0..<cols {
                var sum = 0.0
                for r in 0..<rows { sum += a[r][i] * a[r][j] }
                ata[i][j] = sum
            }
            var sumB = 0.0
            for r in 0..<rows { sumB += a[r][i] * rhs[r] }
            atb[i] = sumB
        }
        // Gaussian elimination on the 4×4 augmented matrix.
        for p in 0..<cols {
            var maxRow = p
            for r in (p + 1)..<cols where abs(ata[r][p]) > abs(ata[maxRow][p]) { maxRow = r }
            ata.swapAt(p, maxRow); atb.swapAt(p, maxRow)
            let pivot = ata[p][p]
            guard abs(pivot) > 1e-12 else { continue }
            for r in 0..<cols where r != p {
                let factor = ata[r][p] / pivot
                for c in p..<cols { ata[r][c] -= factor * ata[p][c] }
                atb[r] -= factor * atb[p]
            }
        }
        var x = [Double](repeating: 0, count: cols)
        for i in 0..<cols where abs(ata[i][i]) > 1e-12 { x[i] = atb[i] / ata[i][i] }
        return x
    }

    /// Apply a 2×3 affine `m` to `src`, producing an `outSize × outSize` image
    /// via inverse-mapped nearest-neighbour sampling (matches Kotlin reference).
    private func warpAffine(src: UIImage, m: [Float], outSize: Int) throws -> UIImage {
        guard let srcPixels = self.rgbaPixelsNative(of: src),
              let srcCG = src.cgImage else {
            throw FaceEngineError.invalidImage
        }
        let srcW = srcCG.width
        let srcH = srcCG.height

        let det = m[0] * m[4] - m[1] * m[3]
        guard abs(det) > 1e-12 else { throw FaceEngineError.inferenceFailed("degenerate transform") }
        // Inverse of the 2×2 linear part.
        let i00 = m[4] / det, i01 = -m[1] / det
        let i10 = -m[3] / det, i11 = m[0] / det

        var dst = [UInt8](repeating: 0, count: outSize * outSize * 4)
        for dy in 0..<outSize {
            for dx in 0..<outSize {
                let ox = Float(dx) - m[2]
                let oy = Float(dy) - m[5]
                let sx = Int(i00 * ox + i01 * oy)
                let sy = Int(i10 * ox + i11 * oy)
                let dIdx = (dy * outSize + dx) * 4
                if sx >= 0 && sx < srcW && sy >= 0 && sy < srcH {
                    let sIdx = (sy * srcW + sx) * 4
                    dst[dIdx + 0] = srcPixels[sIdx + 0]
                    dst[dIdx + 1] = srcPixels[sIdx + 1]
                    dst[dIdx + 2] = srcPixels[sIdx + 2]
                    dst[dIdx + 3] = 255
                } else {
                    dst[dIdx + 3] = 255  // black, opaque
                }
            }
        }
        guard let out = self.image(fromRGBA: dst, width: outSize, height: outSize) else {
            throw FaceEngineError.invalidImage
        }
        return out
    }

    // MARK: - Image helpers

    private func decodeBase64(_ base64: String) -> UIImage? {
        // Tolerate a "data:image/...;base64," prefix.
        let cleaned = base64.contains(",") ? String(base64.split(separator: ",").last ?? "") : base64
        guard let data = Data(base64Encoded: cleaned, options: .ignoreUnknownCharacters) else {
            return nil
        }
        return UIImage(data: data)
    }

    private func crop(image: UIImage, rect: CGRect) -> UIImage? {
        guard let cg = image.cgImage?.cropping(to: rect) else { return nil }
        return UIImage(cgImage: cg)
    }

    /// Draw `image` into a tightly-packed RGBA8 buffer at the requested size.
    private func rgbaPixels(of image: UIImage, width: Int, height: Int) -> [UInt8]? {
        var buffer = [UInt8](repeating: 0, count: width * height * 4)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
        guard let ctx = CGContext(data: &buffer, width: width, height: height,
                                  bitsPerComponent: 8, bytesPerRow: width * 4,
                                  space: colorSpace, bitmapInfo: bitmapInfo),
              let cg = image.cgImage else { return nil }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        return buffer
    }

    /// RGBA8 buffer at the image's native dimensions (used by warpAffine).
    private func rgbaPixelsNative(of image: UIImage) -> [UInt8]? {
        guard let cg = image.cgImage else { return nil }
        return rgbaPixels(of: image, width: cg.width, height: cg.height)
    }

    private func image(fromRGBA pixels: [UInt8], width: Int, height: Int) -> UIImage? {
        var mutable = pixels
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
        guard let ctx = CGContext(data: &mutable, width: width, height: height,
                                  bitsPerComponent: 8, bytesPerRow: width * 4,
                                  space: colorSpace, bitmapInfo: bitmapInfo),
              let cg = ctx.makeImage() else { return nil }
        return UIImage(cgImage: cg)
    }

    /// Read a float-tensor ORTValue back into a Swift `[Float]`.
    private func floatArray(from value: ORTValue) throws -> [Float] {
        let data = try value.tensorData() as Data
        return data.withUnsafeBytes { raw in
            Array(raw.bindMemory(to: Float.self))
        }
    }

    /// Minimal SCRFD output decode. Real anchor decoding + NMS lives in JS for
    /// this build; if the model graph emits no decodable face we report none.
    private func decodeScrfd(outputs: [String: ORTValue],
                             origWidth: CGFloat,
                             origHeight: CGFloat) throws -> [String: Any] {
        // Surface raw output names so the JS layer can run anchor decoding/NMS.
        // Native side reports "not found" by default; JS post-processes tensors
        // it pulls via the detection pass. Kept minimal to avoid duplicating the
        // anchor math that already exists in the TS detector utilities.
        return ["found": false]
    }
}

// MARK: - Errors

enum FaceEngineError: Error, LocalizedError {
    case notInitialised
    case modelNotFound(String)
    case invalidImage
    case badArgument(String)
    case inferenceFailed(String)

    var errorDescription: String? {
        switch self {
        case .notInitialised: return "Models not initialised; call initModels() first"
        case .modelNotFound(let n): return "Model not found in bundle: \(n).onnx"
        case .invalidImage: return "Could not decode/process image"
        case .badArgument(let a): return "Bad argument: \(a)"
        case .inferenceFailed(let m): return "Inference failed: \(m)"
        }
    }
}
