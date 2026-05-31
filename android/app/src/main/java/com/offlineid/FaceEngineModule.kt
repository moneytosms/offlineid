package com.offlineid

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtException
import ai.onnxruntime.OrtSession
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import org.json.JSONArray
import java.nio.FloatBuffer
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * FaceEngineModule — offline face detection, liveness, and recognition via ONNX Runtime.
 *
 * Bridges four ONNX models to React Native:
 *  - SCRFD-500M       face detector  (1×3×640×640, RGB)
 *  - MobileFaceNet    INT8 recogniser (1×3×112×112, RGB, ArcFace-aligned)
 *  - FASNet 2.7 / 4.0 liveness        (1×3×80×80, BGR)
 *
 * Threading: every inference runs on a dedicated [HandlerThread] (`OrtInference`);
 * results are marshalled back to JS via the supplied [Promise]. The [OrtEnvironment]
 * and all [OrtSession] objects are singletons created once in [initModels].
 *
 * All preprocessing formulas/constants are ported verbatim from MODEL_PIPELINE.md §3.
 * No OpenCV dependency — the ArcFace similarity transform is solved manually.
 */
class FaceEngineModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    // ---- ONNX singletons ------------------------------------------------------------------
    private var env: OrtEnvironment? = null
    private var detectorSession: OrtSession? = null     // scrfd_500m_fixed.onnx
    private var recogniserSession: OrtSession? = null   // mobilefacenet_int8.onnx
    private var liveness27Session: OrtSession? = null   // fasnet_2_7.onnx
    private var liveness40Session: OrtSession? = null   // fasnet_4_0.onnx

    // Hardware-accel toggle. CPU is the safe default; NNAPI can abort natively on
    // some devices/emulators with INT8 graphs (SPEC §18). Flip on for real-device tuning.
    private val useNnapi = false

    // ---- Dedicated inference thread -------------------------------------------------------
    private val inferenceThread = HandlerThread("OrtInference").apply { start() }
    private val inferenceHandler = Handler(inferenceThread.looper)

    override fun getName(): String = NAME

    // =======================================================================================
    //  Lifecycle
    // =======================================================================================

    /**
     * Load the four ONNX sessions from app assets on the inference thread.
     *
     * Execution-provider priority per session: NNAPI → XNNPACK → CPU. NNAPI failures are
     * swallowed (some devices crash on INT8 + NNAPI); XNNPACK is always appended as a
     * CPU accelerator and plain CPU is the implicit last resort. Sessions are singletons:
     * calling this twice is a no-op once loaded.
     *
     * @param promise resolves with a status string, rejects with `INIT_ERROR`.
     */
    @ReactMethod
    fun initModels(promise: Promise) {
        inferenceHandler.post {
            try {
                if (detectorSession != null) {
                    promise.resolve("Models already loaded")
                    return@post
                }
                val ortEnv = OrtEnvironment.getEnvironment()
                env = ortEnv

                detectorSession = loadModel(ortEnv, "scrfd_500m_fixed.onnx")
                recogniserSession = loadModel(ortEnv, "mobilefacenet_int8.onnx")
                liveness27Session = loadModel(ortEnv, "fasnet_2_7.onnx")
                liveness40Session = loadModel(ortEnv, "fasnet_4_0.onnx")

                promise.resolve("Models loaded")
            } catch (e: Throwable) {
                releaseInternal()
                promise.reject("INIT_ERROR", e.message ?: "initModels failed", e)
            }
        }
    }

    /**
     * Close all sessions and the [OrtEnvironment], freeing native memory.
     *
     * @param promise resolves once released, rejects with `RELEASE_ERROR`.
     */
    @ReactMethod
    fun releaseModels(promise: Promise) {
        inferenceHandler.post {
            try {
                releaseInternal()
                promise.resolve("Models released")
            } catch (e: Throwable) {
                promise.reject("RELEASE_ERROR", e.message ?: "releaseModels failed", e)
            }
        }
    }

    private fun releaseInternal() {
        runCatching { detectorSession?.close() }
        runCatching { recogniserSession?.close() }
        runCatching { liveness27Session?.close() }
        runCatching { liveness40Session?.close() }
        runCatching { env?.close() }
        detectorSession = null
        recogniserSession = null
        liveness27Session = null
        liveness40Session = null
        env = null
    }

    /** RN module teardown: free ONNX resources and stop the inference thread. */
    override fun invalidate() {
        super.invalidate()
        runCatching { releaseInternal() }
        inferenceThread.quitSafely()
    }

    /**
     * Build session options with the NNAPI → XNNPACK → CPU provider fallback and load
     * a model from the APK `assets/` directory.
     */
    private fun loadModel(ortEnv: OrtEnvironment, assetName: String): OrtSession {
        val bytes = reactContext.assets.open(assetName).use { it.readBytes() }

        // Plain CPU options — reliable on every device + emulator. ONNX Runtime's
        // default CPU kernels comfortably meet the latency budget for these models.
        fun cpuOptions() = OrtSession.SessionOptions().apply {
            setIntraOpNumThreads(2)
            setInterOpNumThreads(1)
        }

        // Hardware acceleration (NNAPI) is opt-in: it can throw at createSession
        // time (and on some emulators aborts natively) with INT8 graphs. We try it
        // only when explicitly enabled, and fall back to CPU on any Java-level error.
        if (useNnapi) {
            try {
                val accel = cpuOptions().apply { addNnapi() }
                return ortEnv.createSession(bytes, accel)
            } catch (e: Throwable) {
                // NNAPI failed for this model — fall through to CPU.
            }
        }
        return ortEnv.createSession(bytes, cpuOptions())
    }

    // =======================================================================================
    //  detectFace — SCRFD
    // =======================================================================================

    /**
     * Detect the single most-confident face in a base64-encoded frame using SCRFD-500M.
     *
     * Preprocesses per MODEL_PIPELINE §3.1, runs inference, decodes the FPN outputs at
     * strides 8/16/32 (anchor-distance decoding, 2 anchors per location), applies NMS,
     * and rescales the winning box/landmarks back to original image coordinates.
     *
     * @param base64Frame JPEG/PNG frame, base64-encoded.
     * @param promise resolves with `{found, bbox{x,y,w,h}, landmarks[[x,y]*5], confidence}`.
     */
    @ReactMethod
    fun detectFace(base64Frame: String, promise: Promise) {
        inferenceHandler.post {
            try {
                val session = detectorSession
                    ?: throw IllegalStateException("Models not initialised")
                val ortEnv = env ?: throw IllegalStateException("Env not initialised")

                val bitmap = base64ToBitmap(base64Frame)
                val origW = bitmap.width
                val origH = bitmap.height
                val scaleX = origW.toFloat() / SCRFD_SIZE
                val scaleY = origH.toFloat() / SCRFD_SIZE

                val input = preprocessForScrfd(bitmap)
                bitmap.recycle()
                val shape = longArrayOf(1, 3, SCRFD_SIZE.toLong(), SCRFD_SIZE.toLong())
                val tensor = OnnxTensor.createTensor(ortEnv, FloatBuffer.wrap(input), shape)

                val outputs = tensor.use {
                    session.run(mapOf(session.inputNames.first() to it))
                }

                val detections = outputs.use { parseScrfdOutputs(it) }

                val result = Arguments.createMap()
                if (detections.isEmpty()) {
                    result.putBoolean("found", false)
                    promise.resolve(result)
                    return@post
                }

                // Highest-confidence detection (post-NMS list already sorted desc).
                val best = detections.first()

                result.putBoolean("found", true)
                result.putDouble("confidence", best.score.toDouble())

                val bbox = Arguments.createMap().apply {
                    val x = best.x1 * scaleX
                    val y = best.y1 * scaleY
                    putDouble("x", x.toDouble())
                    putDouble("y", y.toDouble())
                    putDouble("w", ((best.x2 - best.x1) * scaleX).toDouble())
                    putDouble("h", ((best.y2 - best.y1) * scaleY).toDouble())
                }
                result.putMap("bbox", bbox)

                val landmarks: WritableArray = Arguments.createArray()
                for (i in 0 until 5) {
                    val pt = Arguments.createArray().apply {
                        pushDouble((best.kps[i * 2] * scaleX).toDouble())
                        pushDouble((best.kps[i * 2 + 1] * scaleY).toDouble())
                    }
                    landmarks.pushArray(pt)
                }
                result.putArray("landmarks", landmarks)

                promise.resolve(result)
            } catch (e: Throwable) {
                promise.reject("DETECT_ERROR", e.message ?: "detectFace failed", e)
            }
        }
    }

    // =======================================================================================
    //  checkLiveness — FASNet
    // =======================================================================================

    /**
     * Passive liveness check on a single base64 frame using the scale-appropriate FASNet.
     *
     * Crops/scales the bbox per MODEL_PIPELINE §3.4 (BGR channel order), runs the 2.7 or
     * 4.0 session depending on [scale], softmaxes the 3-class logits, and returns the
     * probability of the "real" class (index 0). Threshold downstream at 0.6.
     *
     * @param base64Frame JPEG/PNG frame, base64-encoded.
     * @param bboxArray   `[x, y, w, h]` in original-image pixels.
     * @param scale       2.7 or 4.0 — selects the matching session.
     * @param promise resolves with `{isLive, score}`.
     */
    @ReactMethod
    fun checkLiveness(
        base64Frame: String,
        bboxArray: ReadableArray,
        scale: Double,
        promise: Promise
    ) {
        inferenceHandler.post {
            try {
                val ortEnv = env ?: throw IllegalStateException("Env not initialised")
                val scaleF = scale.toFloat()
                val session = when {
                    scaleF < 3.0f -> liveness27Session
                    else -> liveness40Session
                } ?: throw IllegalStateException("Models not initialised")

                val bitmap = base64ToBitmap(base64Frame)
                val bbox = intArrayOf(
                    bboxArray.getDouble(0).toInt(),
                    bboxArray.getDouble(1).toInt(),
                    bboxArray.getDouble(2).toInt(),
                    bboxArray.getDouble(3).toInt()
                )

                val input = preprocessForFasnet(bitmap, bbox, scaleF, FASNET_SIZE)
                bitmap.recycle()
                val shape = longArrayOf(1, 3, FASNET_SIZE.toLong(), FASNET_SIZE.toLong())
                val tensor = OnnxTensor.createTensor(ortEnv, FloatBuffer.wrap(input), shape)

                val outputs = tensor.use {
                    session.run(mapOf(session.inputNames.first() to it))
                }
                val logits = outputs.use { (it[0].value as Array<FloatArray>)[0] }
                val realScore = parseFasnetOutput(logits)

                val result = Arguments.createMap().apply {
                    putBoolean("isLive", realScore > FASNET_THRESHOLD)
                    putDouble("score", realScore.toDouble())
                }
                promise.resolve(result)
            } catch (e: Throwable) {
                promise.reject("LIVENESS_ERROR", e.message ?: "checkLiveness failed", e)
            }
        }
    }

    // =======================================================================================
    //  getEmbedding — ArcFace align + MobileFaceNet
    // =======================================================================================

    /**
     * Produce a 512-dim L2-normalised face embedding from a base64 frame + 5 landmarks.
     *
     * Aligns via the ArcFace 5-point similarity transform (MODEL_PIPELINE §3.2:
     * [estimateNorm] + [warpAffine], least-squares solved by Gaussian elimination — no
     * OpenCV), preprocesses per §3.3, runs MobileFaceNet INT8, then L2-normalises.
     *
     * @param base64Frame   JPEG/PNG frame, base64-encoded.
     * @param landmarksJson JSON array of 5 `[x, y]` pairs (SCRFD output, original coords).
     * @param promise resolves with `{embedding:number[512], inferenceMs}`.
     */
    @ReactMethod
    fun getEmbedding(base64Frame: String, landmarksJson: String, promise: Promise) {
        inferenceHandler.post {
            try {
                val session = recogniserSession
                    ?: throw IllegalStateException("Models not initialised")
                val ortEnv = env ?: throw IllegalStateException("Env not initialised")

                val bitmap = base64ToBitmap(base64Frame)
                val landmarks = parseLandmarks(landmarksJson)

                // ArcFace alignment.
                val m = estimateNorm(landmarks)
                val aligned = warpAffine(bitmap, m, MOBILEFACENET_SIZE)
                bitmap.recycle()

                val input = preprocessForMobileFaceNet(aligned)
                aligned.recycle()
                val shape = longArrayOf(
                    1, 3, MOBILEFACENET_SIZE.toLong(), MOBILEFACENET_SIZE.toLong()
                )
                val tensor = OnnxTensor.createTensor(ortEnv, FloatBuffer.wrap(input), shape)

                val startMs = SystemClock.elapsedRealtime()
                val outputs = tensor.use {
                    session.run(mapOf(session.inputNames.first() to it))
                }
                val inferMs = SystemClock.elapsedRealtime() - startMs

                val raw = outputs.use { (it[0].value as Array<FloatArray>)[0] }

                // L2-normalise.
                var sumSq = 0.0
                for (v in raw) sumSq += (v * v).toDouble()
                val norm = sqrt(sumSq).toFloat().let { if (it == 0f) 1f else it }

                val embedding: WritableArray = Arguments.createArray()
                for (v in raw) embedding.pushDouble((v / norm).toDouble())

                val result: WritableMap = Arguments.createMap().apply {
                    putArray("embedding", embedding)
                    putDouble("inferenceMs", inferMs.toDouble())
                }
                promise.resolve(result)
            } catch (e: Throwable) {
                promise.reject("EMBED_ERROR", e.message ?: "getEmbedding failed", e)
            }
        }
    }

    // =======================================================================================
    //  Helpers — decoding & input parsing
    // =======================================================================================

    /** Decode a base64 string (JPEG/PNG bytes) into an ARGB_8888 [Bitmap]. */
    private fun base64ToBitmap(base64: String): Bitmap {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            ?: throw IllegalArgumentException("Failed to decode base64 frame")
    }

    /** Parse a JSON array of 5 `[x, y]` pairs into a `[5][2]` landmark array. */
    private fun parseLandmarks(json: String): Array<FloatArray> {
        val arr = JSONArray(json)
        require(arr.length() == 5) { "Expected 5 landmarks, got ${arr.length()}" }
        return Array(5) { i ->
            val pt = arr.getJSONArray(i)
            floatArrayOf(pt.getDouble(0).toFloat(), pt.getDouble(1).toFloat())
        }
    }

    // =======================================================================================
    //  Preprocessing (MODEL_PIPELINE §3)
    // =======================================================================================

    /** §3.1 — SCRFD: resize to 640², (px-127.5)/128, CHW, RGB. */
    private fun preprocessForScrfd(bitmap: Bitmap): FloatArray {
        val resized = Bitmap.createScaledBitmap(bitmap, SCRFD_SIZE, SCRFD_SIZE, true)
        val n = SCRFD_SIZE * SCRFD_SIZE
        val out = FloatArray(3 * n)
        val pixels = IntArray(n)
        resized.getPixels(pixels, 0, SCRFD_SIZE, 0, 0, SCRFD_SIZE, SCRFD_SIZE)
        if (resized != bitmap) resized.recycle()
        for (i in 0 until n) {
            val px = pixels[i]
            out[i] = ((px shr 16 and 0xFF) - 127.5f) / 128f         // R
            out[n + i] = ((px shr 8 and 0xFF) - 127.5f) / 128f      // G
            out[2 * n + i] = ((px and 0xFF) - 127.5f) / 128f        // B
        }
        return out
    }

    /** §3.3 — MobileFaceNet: 112² aligned crop, (px-127.5)/127.5, CHW, RGB. */
    private fun preprocessForMobileFaceNet(aligned: Bitmap): FloatArray {
        val size = MOBILEFACENET_SIZE
        val n = size * size
        val out = FloatArray(3 * n)
        val pixels = IntArray(n)
        aligned.getPixels(pixels, 0, size, 0, 0, size, size)
        for (i in 0 until n) {
            val px = pixels[i]
            out[i] = ((px shr 16 and 0xFF) - 127.5f) / 127.5f       // R
            out[n + i] = ((px shr 8 and 0xFF) - 127.5f) / 127.5f    // G
            out[2 * n + i] = ((px and 0xFF) - 127.5f) / 127.5f      // B
        }
        return out
    }

    /**
     * §3.4 — FASNet: scale-crop the bbox, resize to 80², normalise in **BGR** order
     * with mean=[0.406,0.456,0.485] std=[0.225,0.224,0.229]. BGR is mandatory — feeding
     * RGB makes the liveness model output near-random scores.
     */
    private fun preprocessForFasnet(
        srcBitmap: Bitmap,
        bbox: IntArray,
        scale: Float,
        outSize: Int
    ): FloatArray {
        val cx = bbox[0] + bbox[2] / 2f
        val cy = bbox[1] + bbox[3] / 2f
        val newW = (bbox[2] * scale).toInt()
        val newH = (bbox[3] * scale).toInt()
        val x1 = max(0, (cx - newW / 2f).toInt())
        val y1 = max(0, (cy - newH / 2f).toInt())
        val x2 = min(srcBitmap.width, x1 + newW)
        val y2 = min(srcBitmap.height, y1 + newH)
        val cropW = max(1, x2 - x1)
        val cropH = max(1, y2 - y1)

        val crop = Bitmap.createBitmap(srcBitmap, x1, y1, cropW, cropH)
        val resized = Bitmap.createScaledBitmap(crop, outSize, outSize, true)
        if (crop !== srcBitmap) crop.recycle()

        val mean = floatArrayOf(0.406f, 0.456f, 0.485f)  // B, G, R
        val std = floatArrayOf(0.225f, 0.224f, 0.229f)
        val n = outSize * outSize
        val out = FloatArray(3 * n)
        val pixels = IntArray(n)
        resized.getPixels(pixels, 0, outSize, 0, 0, outSize, outSize)
        if (resized !== crop) resized.recycle()
        for (i in 0 until n) {
            val px = pixels[i]
            val r = (px shr 16 and 0xFF) / 255f
            val g = (px shr 8 and 0xFF) / 255f
            val b = (px and 0xFF) / 255f
            out[i] = (b - mean[0]) / std[0]              // B (channel 0)
            out[n + i] = (g - mean[1]) / std[1]          // G (channel 1)
            out[2 * n + i] = (r - mean[2]) / std[2]      // R (channel 2)
        }
        return out
    }

    /** Full softmax distribution (diagnostic logging for liveness tuning). */
    private fun softmaxAll(output: FloatArray): FloatArray {
        val maxVal = output.max()
        var sumExp = 0.0
        val expVals = DoubleArray(output.size) {
            val e = exp((output[it] - maxVal).toDouble()); sumExp += e; e
        }
        return FloatArray(output.size) { (expVals[it] / sumExp).toFloat() }
    }

    /**
     * §3.5 — softmax over the 3-class FASNet logits; return P(real).
     *
     * The shipped MiniFASNet ONNX models put the live/real class at index **2**:
     * genuine live faces score ~0.88–0.98 there while index 0/1 stay near zero
     * (verified on-device, both 2.7 and 4.0 scales). Real-score = softmax[2].
     */
    private fun parseFasnetOutput(output: FloatArray): Float {
        val maxVal = output.max()
        var sumExp = 0.0
        val expVals = DoubleArray(output.size) {
            val e = exp((output[it] - maxVal).toDouble()); sumExp += e; e
        }
        val realIdx = if (output.size >= 3) 2 else output.size - 1
        return (expVals[realIdx] / sumExp).toFloat()
    }

    // =======================================================================================
    //  ArcFace similarity transform (MODEL_PIPELINE §3.2)
    // =======================================================================================

    /**
     * Estimate a 2×3 affine (similarity) matrix mapping the 5 source landmarks to the
     * fixed ArcFace destinations, returned as `[m00,m01,m02,m10,m11,m12]`.
     *
     * Fits `[a, b, tx, ty]` for `x' = a·x − b·y + tx`, `y' = b·x + a·y + ty` via
     * least squares (normal equations solved with Gaussian elimination).
     */
    private fun estimateNorm(landmarks: Array<FloatArray>): FloatArray {
        val n = 5
        val srcX = DoubleArray(n) { landmarks[it][0].toDouble() }
        val srcY = DoubleArray(n) { landmarks[it][1].toDouble() }
        val dstX = DoubleArray(n) { ARCFACE_DST[it][0].toDouble() }
        val dstY = DoubleArray(n) { ARCFACE_DST[it][1].toDouble() }

        // A is (2n × 4), b is (2n).
        val a = Array(2 * n) { DoubleArray(4) }
        val rhs = DoubleArray(2 * n)
        for (i in 0 until n) {
            a[i][0] = srcX[i]; a[i][1] = -srcY[i]; a[i][2] = 1.0; a[i][3] = 0.0
            rhs[i] = dstX[i]
            a[n + i][0] = srcY[i]; a[n + i][1] = srcX[i]; a[n + i][2] = 0.0; a[n + i][3] = 1.0
            rhs[n + i] = dstY[i]
        }
        val p = solveLeastSquares(a, rhs)  // [a_, b_, tx, ty]
        val aa = p[0]; val bb = p[1]; val tx = p[2]; val ty = p[3]
        return floatArrayOf(
            aa.toFloat(), (-bb).toFloat(), tx.toFloat(),
            bb.toFloat(), aa.toFloat(), ty.toFloat()
        )
    }

    /**
     * Solve the over-determined system `A·x = b` in the least-squares sense by forming
     * the normal equations `(AᵀA)·x = Aᵀb` and solving the square system with Gaussian
     * elimination + partial pivoting. No external math library / OpenCV.
     */
    private fun solveLeastSquares(matA: Array<DoubleArray>, b: DoubleArray): DoubleArray {
        val rows = matA.size
        val cols = matA[0].size

        // Normal equations: ata (cols×cols), atb (cols).
        val ata = Array(cols) { DoubleArray(cols) }
        val atb = DoubleArray(cols)
        for (i in 0 until cols) {
            for (j in 0 until cols) {
                var s = 0.0
                for (k in 0 until rows) s += matA[k][i] * matA[k][j]
                ata[i][j] = s
            }
            var s = 0.0
            for (k in 0 until rows) s += matA[k][i] * b[k]
            atb[i] = s
        }
        return gaussianSolve(ata, atb)
    }

    /** Gaussian elimination with partial pivoting for a square system `M·x = v`. */
    private fun gaussianSolve(m: Array<DoubleArray>, v: DoubleArray): DoubleArray {
        val n = v.size
        // Augmented copy.
        val a = Array(n) { i -> DoubleArray(n + 1).also { row ->
            for (j in 0 until n) row[j] = m[i][j]
            row[n] = v[i]
        } }
        for (col in 0 until n) {
            // Partial pivot.
            var pivot = col
            for (r in col + 1 until n) {
                if (kotlin.math.abs(a[r][col]) > kotlin.math.abs(a[pivot][col])) pivot = r
            }
            val tmp = a[col]; a[col] = a[pivot]; a[pivot] = tmp
            val diag = a[col][col]
            require(kotlin.math.abs(diag) > 1e-12) { "Singular matrix in alignment solve" }
            for (r in 0 until n) {
                if (r == col) continue
                val factor = a[r][col] / diag
                for (c in col..n) a[r][c] -= factor * a[col][c]
            }
        }
        return DoubleArray(n) { i -> a[i][n] / a[i][i] }
    }

    /**
     * Apply the 2×3 affine [m] to [srcBitmap], producing an [outSize]×[outSize] bitmap via
     * inverse mapping with nearest-neighbour sampling (MODEL_PIPELINE §3.2).
     */
    private fun warpAffine(srcBitmap: Bitmap, m: FloatArray, outSize: Int): Bitmap {
        val out = Bitmap.createBitmap(outSize, outSize, Bitmap.Config.ARGB_8888)
        val srcW = srcBitmap.width
        val srcH = srcBitmap.height
        val srcPixels = IntArray(srcW * srcH)
        srcBitmap.getPixels(srcPixels, 0, srcW, 0, 0, srcW, srcH)
        val dstPixels = IntArray(outSize * outSize) { Color.BLACK }

        val det = m[0] * m[4] - m[1] * m[3]
        require(kotlin.math.abs(det) > 1e-12) { "Non-invertible affine matrix" }
        val invDet = 1f / det
        val i00 = m[4] * invDet
        val i01 = -m[1] * invDet
        val i10 = -m[3] * invDet
        val i11 = m[0] * invDet

        for (dy in 0 until outSize) {
            for (dx in 0 until outSize) {
                val tx = dx - m[2]
                val ty = dy - m[5]
                val sx = (i00 * tx + i01 * ty).toInt()
                val sy = (i10 * tx + i11 * ty).toInt()
                if (sx in 0 until srcW && sy in 0 until srcH) {
                    dstPixels[dy * outSize + dx] = srcPixels[sy * srcW + sx]
                }
            }
        }
        out.setPixels(dstPixels, 0, outSize, 0, 0, outSize, outSize)
        return out
    }

    // =======================================================================================
    //  SCRFD FPN output decoding + NMS
    // =======================================================================================

    /** Single decoded detection in SCRFD input (640²) coordinate space. */
    private data class Detection(
        val score: Float,
        val x1: Float,
        val y1: Float,
        val x2: Float,
        val y2: Float,
        val kps: FloatArray  // 10 = 5 × (x, y)
    )

    /**
     * Decode the 9 SCRFD FPN outputs into detections and run NMS.
     *
     * SCRFD (InsightFace, with keypoints) emits, per stride s ∈ {8,16,32}:
     *   score_s : [num, 1]      anchor confidences
     *   bbox_s  : [num, 4]      distances (left, top, right, bottom) × s from anchor centre
     *   kps_s   : [num, 10]     5 keypoint offsets × s from anchor centre
     * with 2 anchors per spatial location. Outputs are matched by their 2nd-dim size
     * (1 → score, 4 → bbox, 10 → kps) so the routine is robust to output-name ordering.
     */
    private fun parseScrfdOutputs(outputs: OrtSession.Result): List<Detection> {
        // Bucket the 9 outputs into score/bbox/kps by feature count, preserving order.
        val scores = ArrayList<Array<FloatArray>>()
        val bboxes = ArrayList<Array<FloatArray>>()
        val kpses = ArrayList<Array<FloatArray>>()

        for (i in 0 until outputs.size()) {
            val value = outputs[i].value
            val arr = to2D(value) ?: continue
            when (arr.firstOrNull()?.size ?: 0) {
                1 -> scores.add(arr)
                4 -> bboxes.add(arr)
                10 -> kpses.add(arr)
            }
        }

        // Order each bucket by anchor count desc (stride 8 has most anchors → 16 → 32).
        scores.sortByDescending { it.size }
        bboxes.sortByDescending { it.size }
        kpses.sortByDescending { it.size }

        val strides = intArrayOf(8, 16, 32)
        val dets = ArrayList<Detection>()

        val levels = minOf(scores.size, bboxes.size, strides.size)
        for (lvl in 0 until levels) {
            val stride = strides[lvl]
            val scoreArr = scores[lvl]
            val bboxArr = bboxes[lvl]
            val kpsArr = if (lvl < kpses.size) kpses[lvl] else null
            val numAnchors = scoreArr.size

            val featW = SCRFD_SIZE / stride
            // 2 anchors per location → anchor centres repeat per cell.
            val centers = buildAnchorCenters(featW, numAnchors, stride)

            for (idx in 0 until numAnchors) {
                val score = scoreArr[idx][0]
                if (score < SCRFD_SCORE_THRESHOLD) continue

                val cx = centers[idx * 2]
                val cy = centers[idx * 2 + 1]

                val l = bboxArr[idx][0] * stride
                val t = bboxArr[idx][1] * stride
                val r = bboxArr[idx][2] * stride
                val btm = bboxArr[idx][3] * stride
                val x1 = cx - l
                val y1 = cy - t
                val x2 = cx + r
                val y2 = cy + btm

                val kps = FloatArray(10)
                if (kpsArr != null) {
                    val k = kpsArr[idx]
                    for (p in 0 until 5) {
                        kps[p * 2] = cx + k[p * 2] * stride
                        kps[p * 2 + 1] = cy + k[p * 2 + 1] * stride
                    }
                }
                dets.add(Detection(score, x1, y1, x2, y2, kps))
            }
        }
        return nms(dets, SCRFD_NMS_THRESHOLD)
    }

    /**
     * Build anchor centres for one FPN level. Grid is row-major (`y * featW + x`) with
     * [anchorsPerLoc] anchors sharing each cell centre (`(x+0.5)*stride, (y+0.5)*stride`).
     * Derives anchors-per-location from `numAnchors / (featW*featW)` (typically 2).
     */
    private fun buildAnchorCenters(featW: Int, numAnchors: Int, stride: Int): FloatArray {
        val locations = featW * featW
        val anchorsPerLoc = if (locations > 0) max(1, numAnchors / locations) else 1
        val centers = FloatArray(numAnchors * 2)
        var idx = 0
        for (y in 0 until featW) {
            for (x in 0 until featW) {
                val cx = (x + 0.5f) * stride
                val cy = (y + 0.5f) * stride
                for (a in 0 until anchorsPerLoc) {
                    if (idx >= numAnchors) break
                    centers[idx * 2] = cx
                    centers[idx * 2 + 1] = cy
                    idx++
                }
            }
        }
        return centers
    }

    /** Greedy IoU non-maximum suppression; returns detections sorted by score desc. */
    private fun nms(dets: List<Detection>, iouThreshold: Float): List<Detection> {
        val sorted = dets.sortedByDescending { it.score }.toMutableList()
        val kept = ArrayList<Detection>()
        while (sorted.isNotEmpty()) {
            val best = sorted.removeAt(0)
            kept.add(best)
            val it = sorted.iterator()
            while (it.hasNext()) {
                if (iou(best, it.next()) > iouThreshold) it.remove()
            }
        }
        return kept
    }

    private fun iou(a: Detection, b: Detection): Float {
        val ix1 = max(a.x1, b.x1)
        val iy1 = max(a.y1, b.y1)
        val ix2 = min(a.x2, b.x2)
        val iy2 = min(a.y2, b.y2)
        val iw = max(0f, ix2 - ix1)
        val ih = max(0f, iy2 - iy1)
        val inter = iw * ih
        val areaA = max(0f, a.x2 - a.x1) * max(0f, a.y2 - a.y1)
        val areaB = max(0f, b.x2 - b.x1) * max(0f, b.y2 - b.y1)
        val union = areaA + areaB - inter
        return if (union <= 0f) 0f else inter / union
    }

    /** Coerce an ONNX output value to `[rows][feat]`, handling 2D and 3D-batched shapes. */
    private fun to2D(value: Any?): Array<FloatArray>? = when (value) {
        is Array<*> -> {
            @Suppress("UNCHECKED_CAST")
            when (val first = value.firstOrNull()) {
                is FloatArray -> value as Array<FloatArray>            // [rows][feat]
                is Array<*> -> {
                    if (first.firstOrNull() is FloatArray) {
                        (value as Array<Array<FloatArray>>)[0]         // [1][rows][feat]
                    } else null
                }
                else -> null
            }
        }
        else -> null
    }

    companion object {
        const val NAME = "FaceEngine"

        private const val SCRFD_SIZE = 640
        private const val MOBILEFACENET_SIZE = 112
        private const val FASNET_SIZE = 80

        private const val SCRFD_SCORE_THRESHOLD = 0.5f
        private const val SCRFD_NMS_THRESHOLD = 0.4f
        private const val FASNET_THRESHOLD = 0.6f

        /** ArcFace destination landmarks in the 112×112 output space (MODEL_PIPELINE §3.2). */
        private val ARCFACE_DST = arrayOf(
            floatArrayOf(38.2946f, 51.6963f),   // left eye
            floatArrayOf(73.5318f, 51.5014f),   // right eye
            floatArrayOf(56.0252f, 71.7366f),   // nose tip
            floatArrayOf(41.5493f, 92.3655f),   // left mouth corner
            floatArrayOf(70.7299f, 92.2041f)    // right mouth corner
        )
    }
}
