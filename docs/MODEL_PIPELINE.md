# MODEL_PIPELINE.md — AI Model Pipeline & Preprocessing
## OfflineID · Hackathon 7.0

> This document is the ground truth for all AI model operations.
> Every number, shape, and formula here is battle-tested against the InsightFace
> reference implementation. Do not deviate without updating this file.

---

## 1. Model Acquisition

### Step 1a — SCRFD-500M Face Detector

```bash
# Option A: Download directly from InsightFace model zoo
pip install insightface
python -c "
import insightface
from insightface.app import FaceAnalysis
app = FaceAnalysis(name='buffalo_sc', providers=['CPUExecutionProvider'])
app.prepare(ctx_id=-1)
# This downloads ~/.insightface/models/buffalo_sc/
# Files: det_500m.onnx, w600k_mbf.onnx
"
cp ~/.insightface/models/buffalo_sc/det_500m.onnx ../models/scrfd_500m_fixed.onnx

# Option B: From InsightFace GitHub release
# https://github.com/deepinsight/insightface/releases → model zoo
```

### Step 1b — MobileFaceNet Recogniser

```bash
# buffalo_sc pack contains w600k_mbf.onnx (MobileFaceNet trained on WebFace600K with ArcFace)
cp ~/.insightface/models/buffalo_sc/w600k_mbf.onnx ../models/mobilefacenet_fp32.onnx
```

### Step 1c — FASNet Liveness Model

```bash
git clone https://github.com/minivision-ai/Silent-Face-Anti-Spoofing
cd Silent-Face-Anti-Spoofing
# Models are at resources/anti_spoof_models/
# Use: 2.7_80x80_MiniFASNetV2.pth and 4_0_80x80_MiniFASNetV2.pth
```

---

## 2. Model Export Scripts

### 2.1 `scripts/export_scrfd.py`

```python
#!/usr/bin/env python3
"""
SCRFD-500M: already in ONNX format from InsightFace.
This script simplifies and validates it for mobile deployment.
"""
import onnx
import onnxsim

MODEL_IN  = "../models/scrfd_500m_raw.onnx"
MODEL_OUT = "../models/scrfd_500m_fixed.onnx"

model = onnx.load(MODEL_IN)
model_simplified, check = onnxsim.simplify(
    model,
    input_shapes={"input.1": [1, 3, 640, 640]},  # fix dynamic shapes
    skip_shape_inference=False,
)
assert check, "ONNX simplification failed"
onnx.save(model_simplified, MODEL_OUT)
print(f"SCRFD saved: {MODEL_OUT}")
print(f"Size: {os.path.getsize(MODEL_OUT) / 1024:.1f} KB")

# Validate inputs/outputs
sess = ort.InferenceSession(MODEL_OUT)
print("Inputs:", [(i.name, i.shape) for i in sess.get_inputs()])
print("Outputs:", [(o.name, o.shape) for o in sess.get_outputs()])
# Expected inputs:  [('input.1', [1, 3, 640, 640])]
# Expected outputs: score_8, score_16, score_32, bbox_8, bbox_16, bbox_32,
#                   kps_8, kps_16, kps_32
```

### 2.2 `scripts/export_mobilefacenet.py`

```python
#!/usr/bin/env python3
"""
MobileFaceNet: FP32 → INT8 dynamic quantisation.
Input:  (1, 3, 112, 112)  RGB, normalised to [-1, 1]
Output: (1, 512)          L2-normalised embedding
"""
import onnx, onnxruntime as ort
from onnxruntime.quantization import quantize_dynamic, QuantType
import numpy as np

MODEL_FP32 = "../models/mobilefacenet_fp32.onnx"
MODEL_INT8 = "../models/mobilefacenet_int8.onnx"

quantize_dynamic(
    MODEL_FP32,
    MODEL_INT8,
    weight_type=QuantType.QInt8,
    optimize_model=True,
)
print(f"INT8 model saved: {MODEL_INT8}")

# Accuracy smoke test
sess_fp32 = ort.InferenceSession(MODEL_FP32)
sess_int8 = ort.InferenceSession(MODEL_INT8)
dummy = np.random.randn(1, 3, 112, 112).astype(np.float32)
emb_fp32 = sess_fp32.run(None, {"input.1": dummy})[0][0]
emb_int8 = sess_int8.run(None, {"input.1": dummy})[0][0]
cos_sim = np.dot(emb_fp32, emb_int8) / (np.linalg.norm(emb_fp32) * np.linalg.norm(emb_int8))
print(f"FP32 vs INT8 cosine similarity on random input: {cos_sim:.6f}")
assert cos_sim > 0.99, "INT8 quantisation degraded accuracy too much!"
```

### 2.3 `scripts/export_fasnet.py`

```python
#!/usr/bin/env python3
"""
Export FASNet (MiniFASNetV2) from PyTorch .pth to ONNX.
Two models needed: scale 2.7 (80×80 input) and scale 4.0 (80×80 input).
Both have identical architecture — only the training data/scale differs.
"""
import torch
import sys
sys.path.insert(0, './Silent-Face-Anti-Spoofing/src/model_lib')
from MiniFASNet import MiniFASNetV2

def export_fasnet(pth_path: str, onnx_path: str, label: str):
    model = MiniFASNetV2(conv6_kernel=(5, 5))
    state = torch.load(pth_path, map_location='cpu')
    # Strip the 'module.' prefix if saved with DataParallel
    state = {k.replace('module.', ''): v for k, v in state.items()}
    model.load_state_dict(state)
    model.eval()
    dummy = torch.randn(1, 3, 80, 80)
    torch.onnx.export(
        model, dummy, onnx_path,
        input_names=['input'],
        output_names=['output'],
        opset_version=11,
        dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}},
    )
    print(f"FASNet [{label}] saved: {onnx_path}")

export_fasnet(
    './Silent-Face-Anti-Spoofing/resources/anti_spoof_models/2.7_80x80_MiniFASNetV2.pth',
    '../models/fasnet_2_7.onnx',
    'scale=2.7'
)
export_fasnet(
    './Silent-Face-Anti-Spoofing/resources/anti_spoof_models/4_0_80x80_MiniFASNetV2.pth',
    '../models/fasnet_4_0.onnx',
    'scale=4.0'
)

# Merge both into one ONNX for a single model file:
# OR ship as two separate files and name them fasnet_anti_spoof_2_7.onnx and ..4_0.onnx
# The native module loads both at startup.
```

---

## 3. Preprocessing Pipeline (Native Implementation Required)

This section defines the EXACT preprocessing every native module (Kotlin/Swift) MUST implement.
The order of operations is critical — deviating will degrade accuracy.

### 3.1 SCRFD Face Detector Preprocessing

```
Input:  Camera frame (YUV_420_888 on Android, CVPixelBuffer on iOS)
Output: Float32 tensor of shape [1, 3, 640, 640]

Steps:
1. YUV → RGB conversion (BT.601 standard)
2. Resize to 640×640 using bilinear interpolation
3. Subtract mean [127.5, 127.5, 127.5]
4. Divide by std [128.0, 128.0, 128.0]
5. Transpose HWC → CHW (from [640,640,3] to [3,640,640])
6. Add batch dim → [1, 3, 640, 640]
7. Cast to Float32
```

**Kotlin reference:**
```kotlin
fun preprocessForScrfd(bitmap: Bitmap): FloatArray {
    val resized = Bitmap.createScaledBitmap(bitmap, 640, 640, true)
    val floatArray = FloatArray(1 * 3 * 640 * 640)
    var idx = 0
    val pixels = IntArray(640 * 640)
    resized.getPixels(pixels, 0, 640, 0, 0, 640, 640)
    // R channel
    for (y in 0 until 640) for (x in 0 until 640) {
        val px = pixels[y * 640 + x]
        floatArray[idx++] = ((px shr 16 and 0xFF) - 127.5f) / 128f
    }
    // G channel
    idx = 640 * 640
    for (y in 0 until 640) for (x in 0 until 640) {
        val px = pixels[y * 640 + x]
        floatArray[idx++] = ((px shr 8 and 0xFF) - 127.5f) / 128f
    }
    // B channel
    idx = 2 * 640 * 640
    for (y in 0 until 640) for (x in 0 until 640) {
        val px = pixels[y * 640 + x]
        floatArray[idx++] = ((px and 0xFF) - 127.5f) / 128f
    }
    return floatArray
}
```

### 3.2 ArcFace 5-Point Alignment (Critical for MobileFaceNet)

This is the MOST CRITICAL preprocessing step. The reference destinations are fixed
by the ArcFace training protocol. Every pixel matters.

```kotlin
// Reference landmark destinations in the 112×112 output space
val ARCFACE_DST = arrayOf(
    floatArrayOf(38.2946f, 51.6963f),   // left eye
    floatArrayOf(73.5318f, 51.5014f),   // right eye
    floatArrayOf(56.0252f, 71.7366f),   // nose tip
    floatArrayOf(41.5493f, 92.3655f),   // left mouth corner
    floatArrayOf(70.7299f, 92.2041f),   // right mouth corner
)

/**
 * Estimate a 2×3 affine matrix from 5 source landmarks to ArcFace destinations.
 * Implements: tform = SimilarityTransform(); tform.estimate(src, dst); M = tform.params[0:2,:]
 * 
 * Uses least-squares fitting. Reference: skimage.transform.SimilarityTransform
 */
fun estimateNorm(landmarks: Array<FloatArray>): FloatArray {
    // landmarks: shape [5,2] — output of SCRFD
    // Returns: 2×3 affine matrix as FloatArray of length 6
    // Implementation: fit similarity transform via SVD
    // See: https://github.com/deepinsight/insightface/blob/master/python-package/insightface/utils/face_align.py
    
    val n = 5
    val srcX = DoubleArray(n) { landmarks[it][0].toDouble() }
    val srcY = DoubleArray(n) { landmarks[it][1].toDouble() }
    val dstX = DoubleArray(n) { ARCFACE_DST[it][0].toDouble() }
    val dstY = DoubleArray(n) { ARCFACE_DST[it][1].toDouble() }
    
    // Build least-squares system for similarity transform [a, b, tx, ty]
    // where the transform is: x' = a*x - b*y + tx, y' = b*x + a*y + ty
    val A = Array(2 * n) { DoubleArray(4) }
    val b = DoubleArray(2 * n)
    for (i in 0 until n) {
        A[i][0] = srcX[i]; A[i][1] = -srcY[i]; A[i][2] = 1.0; A[i][3] = 0.0; b[i] = dstX[i]
        A[n+i][0] = srcY[i]; A[n+i][1] = srcX[i]; A[n+i][2] = 0.0; A[n+i][3] = 1.0; b[n+i] = dstY[i]
    }
    // Solve via normal equations: (A^T A) x = A^T b
    val params = solveLeastSquares(A, b)  // [a, b, tx, ty]
    val a_ = params[0]; val b_ = params[1]; val tx = params[2]; val ty = params[3]
    return floatArrayOf(a_.toFloat(), (-b_).toFloat(), tx.toFloat(), b_.toFloat(), a_.toFloat(), ty.toFloat())
}

fun warpAffine(srcBitmap: Bitmap, M: FloatArray, outSize: Int): Bitmap {
    // Apply 2×3 affine transform M to srcBitmap, output outSize × outSize
    // M = [m00, m01, m02, m10, m11, m12]
    // x' = m00*x + m01*y + m02
    // y' = m10*x + m11*y + m12
    val out = Bitmap.createBitmap(outSize, outSize, Bitmap.Config.ARGB_8888)
    val srcW = srcBitmap.width.toFloat(); val srcH = srcBitmap.height.toFloat()
    val srcPixels = IntArray(srcBitmap.width * srcBitmap.height)
    srcBitmap.getPixels(srcPixels, 0, srcBitmap.width, 0, 0, srcBitmap.width, srcBitmap.height)
    val dstPixels = IntArray(outSize * outSize) { Color.BLACK }
    
    // Inverse mapping: for each dst pixel, find src pixel
    // Invert 2×2 submatrix of M
    val det = M[0] * M[4] - M[1] * M[3]
    val invM = floatArrayOf(M[4]/det, -M[1]/det, 0f, -M[3]/det, M[0]/det, 0f)
    for (dy in 0 until outSize) {
        for (dx in 0 until outSize) {
            val srcXf = invM[0]*(dx - M[2]) + invM[1]*(dy - M[5])
            val srcYf = invM[3]*(dx - M[2]) + invM[4]*(dy - M[5])
            val sx = srcXf.toInt(); val sy = srcYf.toInt()
            if (sx in 0 until srcBitmap.width && sy in 0 until srcBitmap.height) {
                dstPixels[dy * outSize + dx] = srcPixels[sy * srcBitmap.width + sx]
            }
        }
    }
    out.setPixels(dstPixels, 0, outSize, 0, 0, outSize, outSize)
    return out
}
```

> **Note for Claude Code:** Implement `solveLeastSquares` using Gaussian elimination
> or use the Apache Commons Math library. Do NOT use OpenCV — it is not bundled with
> the React Native project and adds ~40 MB. The above manual implementation is sufficient
> for a 5-point system.

### 3.3 MobileFaceNet Input Preprocessing

```kotlin
fun preprocessForMobileFaceNet(alignedBitmap: Bitmap): FloatArray {
    // alignedBitmap must be exactly 112×112
    assert(alignedBitmap.width == 112 && alignedBitmap.height == 112)
    val floatArray = FloatArray(1 * 3 * 112 * 112)
    val pixels = IntArray(112 * 112)
    alignedBitmap.getPixels(pixels, 0, 112, 0, 0, 112, 112)
    // Normalise: (pixel/255 - 0.5) / 0.5  ≡  (pixel - 127.5) / 127.5
    // Channel-first layout: R[0..112*112), G[112*112..2*112*112), B[...]
    for (i in 0 until 112 * 112) {
        val px = pixels[i]
        floatArray[i]               = ((px shr 16 and 0xFF) - 127.5f) / 127.5f  // R
        floatArray[112*112 + i]     = ((px shr 8  and 0xFF) - 127.5f) / 127.5f  // G
        floatArray[2*112*112 + i]   = ((px         and 0xFF) - 127.5f) / 127.5f  // B
    }
    return floatArray
}
```

### 3.4 FASNet Input Preprocessing

```kotlin
fun preprocessForFasnet(
    srcBitmap: Bitmap,
    bbox: IntArray,   // [x, y, w, h]
    scale: Float,     // 2.7f or 4.0f
    outSize: Int = 80
): FloatArray {
    // Scale the bounding box by `scale` and crop from original frame
    val cx = bbox[0] + bbox[2] / 2f
    val cy = bbox[1] + bbox[3] / 2f
    val newW = (bbox[2] * scale).toInt()
    val newH = (bbox[3] * scale).toInt()
    val x1 = maxOf(0, (cx - newW / 2f).toInt())
    val y1 = maxOf(0, (cy - newH / 2f).toInt())
    val x2 = minOf(srcBitmap.width, x1 + newW)
    val y2 = minOf(srcBitmap.height, y1 + newH)
    val crop = Bitmap.createBitmap(srcBitmap, x1, y1, x2 - x1, y2 - y1)
    val resized = Bitmap.createScaledBitmap(crop, outSize, outSize, true)
    
    // Normalise: (pixel / 255 - mean) / std
    // FASNet mean=[0.406, 0.456, 0.485], std=[0.225, 0.224, 0.229] (BGR order!)
    val mean = floatArrayOf(0.406f, 0.456f, 0.485f)  // B, G, R
    val std  = floatArrayOf(0.225f, 0.224f, 0.229f)
    val floatArray = FloatArray(3 * outSize * outSize)
    val pixels = IntArray(outSize * outSize)
    resized.getPixels(pixels, 0, outSize, 0, 0, outSize, outSize)
    for (i in 0 until outSize * outSize) {
        val px = pixels[i]
        val r = (px shr 16 and 0xFF) / 255f
        val g = (px shr 8  and 0xFF) / 255f
        val b = (px         and 0xFF) / 255f
        // FASNet is trained with BGR channel order!
        floatArray[0 * outSize * outSize + i] = (b - mean[0]) / std[0]  // B
        floatArray[1 * outSize * outSize + i] = (g - mean[1]) / std[1]  // G
        floatArray[2 * outSize * outSize + i] = (r - mean[2]) / std[2]  // R
    }
    return floatArray
}
```

⚠️ **Critical:** FASNet is trained with **BGR channel order** (OpenCV convention), not RGB.
Swapping this will cause the liveness model to output near-random scores.

### 3.5 FASNet Output Postprocessing

```kotlin
fun parseFasnetOutput(output: FloatArray): Float {
    // output shape: [1, 3]  (3 classes: real, fake_print, fake_screen)
    // Apply softmax, return probability of class 0 (real)
    val maxVal = output.max()!!
    val expVals = output.map { Math.exp((it - maxVal).toDouble()).toFloat() }
    val sumExp = expVals.sum()
    val softmax = expVals.map { it / sumExp }
    return softmax[0]  // probability of being a real face; threshold at 0.6
}
```

---

## 4. ONNX Runtime Session Initialisation (Native)

### 4.1 Android / Kotlin

```kotlin
class FaceEngineModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {

    private lateinit var env: OrtEnvironment
    private lateinit var detectorSession: OrtSession
    private lateinit var recogniserSession: OrtSession
    private lateinit var liveness27Session: OrtSession
    private lateinit var liveness40Session: OrtSession

    @ReactMethod
    fun initModels(promise: Promise) {
        Thread {
            try {
                env = OrtEnvironment.getEnvironment()
                val opts = OrtSession.SessionOptions().apply {
                    setIntraOpNumThreads(2)
                    setInterOpNumThreads(1)
                    try { addNnapi() } catch (e: Exception) { /* fallback */ }
                    addXnnpack(mapOf<String, String>())
                }

                fun loadModel(assetName: String): OrtSession {
                    val bytes = context.assets.open(assetName).readBytes()
                    return env.createSession(bytes, opts)
                }

                detectorSession   = loadModel("scrfd_500m_fixed.onnx")
                recogniserSession = loadModel("mobilefacenet_int8.onnx")
                liveness27Session = loadModel("fasnet_2_7.onnx")
                liveness40Session = loadModel("fasnet_4_0.onnx")

                promise.resolve("Models loaded")
            } catch (e: Exception) {
                promise.reject("INIT_ERROR", e.message)
            }
        }.start()
    }
}
```

### 4.2 Running Inference

```kotlin
@ReactMethod
fun getEmbedding(base64Frame: String, landmarksJson: String, promise: Promise) {
    Thread {
        try {
            val bitmap = base64ToBitmap(base64Frame)
            val landmarks = parseLandmarks(landmarksJson)  // Array<FloatArray>

            // Step 1: Align
            val M = estimateNorm(landmarks)
            val aligned = warpAffine(bitmap, M, 112)

            // Step 2: Preprocess
            val inputData = preprocessForMobileFaceNet(aligned)
            val inputShape = longArrayOf(1, 3, 112, 112)
            val tensor = OnnxTensor.createTensor(env, FloatBuffer.wrap(inputData), inputShape)

            // Step 3: Infer
            val startMs = SystemClock.elapsedRealtime()
            val result = recogniserSession.run(mapOf(recogniserSession.inputNames.first() to tensor))
            val inferMs = SystemClock.elapsedRealtime() - startMs

            // Step 4: Extract & L2-normalise embedding
            val rawEmbedding = (result[0].value as Array<FloatArray>)[0]
            val norm = Math.sqrt(rawEmbedding.map { it * it }.sum().toDouble()).toFloat()
            val embedding = rawEmbedding.map { it / norm }.toFloatArray()

            val output = Arguments.createMap().apply {
                putArray("embedding", Arguments.fromArray(embedding.map { it.toDouble() }.toTypedArray()))
                putDouble("inferenceMs", inferMs.toDouble())
            }
            promise.resolve(output)
        } catch (e: Exception) {
            promise.reject("EMBED_ERROR", e.message)
        }
    }.start()
}
```

---

## 5. Cosine Similarity (TypeScript)

```typescript
// src/utils/cosineDistance.ts

/**
 * Compute cosine similarity between two L2-normalised embeddings.
 * Both vectors must already be L2-normalised (norm = 1.0).
 * Returns value in [-1, 1]; threshold: > 0.65 = match.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('Embedding dimension mismatch');
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;  // already normalised, so ||a||=||b||=1
}

/**
 * Find best match from a list of enrolled embeddings.
 * Returns employeeId + score, or null if no match above threshold.
 */
export function findBestMatch(
  queryEmbedding: Float32Array,
  enrolled: { employeeId: string; embedding: Float32Array }[],
  threshold = 0.65
): { employeeId: string; score: number } | null {
  let bestScore = -Infinity;
  let bestId: string | null = null;
  for (const { employeeId, embedding } of enrolled) {
    const score = cosineSimilarity(queryEmbedding, embedding);
    if (score > bestScore) { bestScore = score; bestId = employeeId; }
  }
  if (bestId && bestScore >= threshold) return { employeeId: bestId, score: bestScore };
  return null;
}
```

---

## 6. Validation Script

### `scripts/validate_models.py`

```python
#!/usr/bin/env python3
"""
Smoke-test all three ONNX models and write BENCHMARKS.md.
Run: python validate_models.py
"""
import time, os
import numpy as np
import onnxruntime as ort

MODELS = {
    "SCRFD-500M":       ("../models/scrfd_500m_fixed.onnx",    (1, 3, 640, 640)),
    "MobileFaceNet":    ("../models/mobilefacenet_int8.onnx",  (1, 3, 112, 112)),
    "FASNet-2.7":       ("../models/fasnet_2_7.onnx",          (1, 3, 80, 80)),
    "FASNet-4.0":       ("../models/fasnet_4_0.onnx",          (1, 3, 80, 80)),
}

results = []

for name, (path, shape) in MODELS.items():
    if not os.path.exists(path):
        print(f"[SKIP] {name}: {path} not found")
        continue
    size_mb = os.path.getsize(path) / (1024 * 1024)
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    inp_name = sess.get_inputs()[0].name
    dummy = np.random.randn(*shape).astype(np.float32)
    
    # Warmup
    for _ in range(3): sess.run(None, {inp_name: dummy})
    
    # Benchmark 20 runs
    times = []
    for _ in range(20):
        t0 = time.perf_counter()
        sess.run(None, {inp_name: dummy})
        times.append((time.perf_counter() - t0) * 1000)
    
    avg_ms = np.mean(times)
    p95_ms = np.percentile(times, 95)
    out_shapes = [str(o.shape) for o in sess.get_outputs()]
    print(f"{name}: size={size_mb:.2f} MB, avg={avg_ms:.1f}ms, p95={p95_ms:.1f}ms, outputs={out_shapes}")
    results.append((name, size_mb, avg_ms, p95_ms))

# Write BENCHMARKS.md
with open("../BENCHMARKS.md", "w") as f:
    f.write("# BENCHMARKS.md — Model Performance\n\n")
    f.write("| Model | Size (MB) | Avg Latency (ms) | P95 Latency (ms) |\n")
    f.write("|---|---|---|---|\n")
    for name, size, avg, p95 in results:
        f.write(f"| {name} | {size:.2f} | {avg:.1f} | {p95:.1f} |\n")
    total_mb = sum(r[1] for r in results)
    total_ms = sum(r[2] for r in results[:3])  # pipeline: detect+liveness+recognise
    f.write(f"\n**Total bundle size:** {total_mb:.2f} MB\n")
    f.write(f"**Estimated pipeline latency (CPU):** ~{total_ms:.0f} ms\n")

print(f"\nBENCHMARKS.md written.")
```

---

## 7. Common Pitfalls

| Pitfall | Impact | Fix |
|---|---|---|
| Wrong channel order for FASNet (RGB vs BGR) | Liveness always fails or always passes | Use BGR: B channel first in tensor |
| Missing ArcFace alignment before MobileFaceNet | Accuracy drops to ~60% | Always align; never feed raw crop |
| Not L2-normalising embedding output | Cosine similarity values wrong | Divide by L2 norm after inference |
| Compressing ONNX files with APK aapt | Model loading fails silently | Add `noCompress "onnx"` to build.gradle |
| Running ONNX on main thread (iOS) | App freezes during inference | Dispatch to background queue (DispatchQueue.global) |
| NNAPI + INT8 model mismatch on some devices | Crash or wrong output | Test NNAPI with INT8; fall back to CPU if exception |
| Using dynamic input shapes in ONNX on mobile | Memory spike | Fix input shape at export time; use onnxsim |

---

*End of MODEL_PIPELINE.md*
