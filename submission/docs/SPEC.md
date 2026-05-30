# SPEC.md - OfflineID: Offline Facial Recognition & Liveness Detection
## Hackathon 7.0 - Datalake 3.0 Integration Module

> Every section is precise and self-contained, so an engineer can act
> on it directly - no ambiguity, no implied knowledge. Read `ARCHITECTURE.md` and
> `MODEL_PIPELINE.md` alongside this file before touching any code.

---

## 0. Quick Reference

| Item | Value |
|---|---|
| Hackathon | Hackathon 7.0 |
| Submission opens | 22 May 2026 |
| Submission closes | 05 June 2026 |
| Platform | React Native (CLI - **not** Expo Go) |
| Target OS | Android 8.0+ · iOS 12+ |
| Min RAM | 3 GB |
| Max model bundle size | 20 MB (target ≤ 12 MB) |
| Inference latency target | < 1 second end-to-end |
| Recognition accuracy | > 95 % |
| Network dependency | **Zero** - fully offline |
| Cloud sync | AWS S3 via presigned URL on reconnect |
| Primary language | TypeScript + Kotlin (Android) + Swift (iOS) |
| License constraint | Open-source only, no paid licences |

---

## 1. Problem Statement (verbatim from brief)

> "How can we accurately and securely authenticate field personnel using facial recognition
> and liveness detection on standard mid-range mobile devices without any active internet
> connection, while ensuring the AI model remains lightweight and seamlessly integrates
> with a React Native application on both Android and iOS devices?"

---

## 2. Evaluation Criteria & Score Targets

| Criterion | Marks | Our target approach |
|---|---|---|
| Innovation Level | 30 | Edge AI compression (INT8 ONNX), passive liveness, FourierSpectrum anti-spoof |
| Feasibility | 30 | Pure open-source stack, ONNX Runtime Mobile, < 1 s on Snapdragon 778G equiv. |
| Scalability & Sustainability | 20 | SQLite offline queue → AWS S3 batch sync → purge on ACK |
| Presentation & Documentation | 20 | This SPEC + ARCHITECTURE.md + MODEL_PIPELINE.md + inline JSDoc |

---

## 3. Repository Layout

```
offlineid/
├── SPEC.md                          ← this file
├── ARCHITECTURE.md                  ← system architecture deep-dive
├── MODEL_PIPELINE.md                ← AI model pipeline & preprocessing
├── BENCHMARKS.md                    ← performance benchmark results
├── README.md                        ← quick-start for evaluators
│
├── scripts/                         ← Python model preparation (offline, run once)
│   ├── requirements.txt
│   ├── export_scrfd.py              ← export SCRFD-500M to ONNX
│   ├── export_mobilefacenet.py      ← export MobileFaceNet to INT8 ONNX
│   ├── export_fasnet.py             ← export FASNet liveness model to ONNX
│   └── validate_models.py           ← smoke-test all three ONNX models
│
├── models/                          ← compiled ONNX model files (gitignored, DVC)
│   ├── scrfd_500m_fixed.onnx        ← face detector   (~1 MB)
│   ├── mobilefacenet_int8.onnx      ← face recogniser (~4 MB)
│   └── fasnet_anti_spoof.onnx       ← liveness model  (~1.2 MB)
│
├── src/
│   ├── native/                      ← native modules (Kotlin + Swift)
│   │   ├── android/
│   │   │   ├── FaceEngineModule.kt  ← ONNX Runtime Android bridge
│   │   │   └── FaceEnginePackage.kt
│   │   └── ios/
│   │       ├── FaceEngine.swift
│   │       └── FaceEngineModule.m   ← ObjC bridge header
│   │
│   ├── services/
│   │   ├── FaceEngine.ts            ← JS wrapper for native module
│   │   ├── LivenessService.ts       ← gesture & passive liveness orchestration
│   │   ├── EmbeddingStore.ts        ← SQLite CRUD for face embeddings
│   │   ├── AttendanceStore.ts       ← SQLite CRUD for attendance logs
│   │   └── SyncService.ts           ← offline queue + AWS S3 sync + purge
│   │
│   ├── hooks/
│   │   ├── useFaceAuth.ts           ← orchestration hook (detect→liveness→recognise)
│   │   └── useNetworkSync.ts        ← NetInfo listener → trigger sync
│   │
│   ├── screens/
│   │   ├── EnrollScreen.tsx         ← new-user face registration (3 captures)
│   │   ├── AuthScreen.tsx           ← attendance / authentication screen
│   │   └── SyncStatusScreen.tsx     ← offline queue viewer + manual sync trigger
│   │
│   ├── components/
│   │   ├── CameraView.tsx           ← VisionCamera wrapper + face bounding overlay
│   │   ├── LivenessPrompt.tsx       ← animated instruction widget (blink / turn head)
│   │   └── SyncBadge.tsx            ← unsynced count indicator
│   │
│   ├── db/
│   │   ├── schema.ts                ← SQLite table definitions
│   │   └── migrations.ts            ← schema version migrations
│   │
│   └── utils/
│       ├── imageUtils.ts            ← YUV→RGB, resize, normalise helpers
│       ├── cosineDistance.ts        ← typed array cosine similarity
│       ├── crypto.ts                ← AES-256 encrypt/decrypt for embeddings
│       └── logger.ts                ← structured log wrapper
│
├── android/                         ← React Native Android project
└── ios/                             ← React Native iOS project
```

---

## 4. AI Model Stack

### 4.1 Model 1 - Face Detector: SCRFD-500M

| Property | Value |
|---|---|
| Source | InsightFace - `insightface/detection/scrfd` |
| ONNX file | `scrfd_500m_fixed.onnx` |
| Input | `1 × 3 × 640 × 640` (or dynamic shape), RGB, normalised |
| Output | bounding boxes + 5 facial keypoints (landmarks) |
| Size (float32) | ~2.4 MB |
| Size after simplification | ~1 MB |
| Inference time (CPU, Cortex-A76) | ~15–25 ms |
| License | MIT (InsightFace open model) |

**Why SCRFD-500M?** It is the smallest variant in the SCRFD family. It detects faces
and outputs 5 facial keypoints (left eye, right eye, nose tip, left mouth corner,
right mouth corner) required for ArcFace alignment in a single forward pass.

**Export command (see `scripts/export_scrfd.py`):**
```python
# Already available as ONNX from InsightFace model zoo
# Download: https://github.com/deepinsight/insightface model zoo
# File: buffalo_sc/det_500m.onnx  - rename to scrfd_500m_fixed.onnx
```

---

### 4.2 Model 2 - Face Recogniser: MobileFaceNet + ArcFace

| Property | Value |
|---|---|
| Source | InsightFace `buffalo_sc` pack / `MobileFaceNet_Tutorial_Pytorch` |
| ONNX file | `mobilefacenet_int8.onnx` |
| Input | `1 × 3 × 112 × 112`, RGB, normalised [mean=(0.5,0.5,0.5), std=(0.5,0.5,0.5)] |
| Output | `1 × 512` float32 embedding |
| Size (float32) | ~4 MB |
| Size (INT8 quantised) | ~1.1 MB |
| LFW accuracy (float32) | 99.55 % |
| LFW accuracy (INT8) | 99.53 % (< 0.02 % drop) |
| Inference time (CPU, Cortex-A76) | ~18–25 ms |
| License | MIT |

**Quantisation command (see `scripts/export_mobilefacenet.py`):**
```python
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic(
    "mobilefacenet_fp32.onnx",
    "mobilefacenet_int8.onnx",
    weight_type=QuantType.QInt8,
)
```

**Face alignment, ArcFace 5-point similarity transform (critical preprocessing):**
```python
# Reference landmark destinations in 112×112 space
ARCFACE_DST = np.array([
    [38.2946, 51.6963],   # left eye
    [73.5318, 51.5014],   # right eye
    [56.0252, 71.7366],   # nose tip
    [41.5493, 92.3655],   # left mouth
    [70.7299, 92.2041],   # right mouth
], dtype=np.float32)
# Use skimage.transform.SimilarityTransform → cv2.warpAffine(img, M, (112,112))
```
This alignment MUST be replicated in the native module. See `MODEL_PIPELINE.md §3`.

---

### 4.3 Model 3 - Liveness / Anti-Spoof: FASNet (Silent-Face)

| Property | Value |
|---|---|
| Source | `minivision-ai/Silent-Face-Anti-Spoofing` |
| ONNX file | `fasnet_anti_spoof.onnx` |
| Input | Two crops at scales 2.7 and 4.0 of the face bounding box |
| Output | `[real_score, fake_score]` - take softmax, threshold real_score > 0.6 |
| Size | ~1.2 MB (MiniFASNet-v2) |
| Inference time | ~20 ms per scale call |
| License | MIT |

**Passive liveness (FASNet) detects:**
- Printed photo attacks
- Screen replay attacks
- Basic 2D mask attacks

**Active liveness (gesture, layered on top):**
- Blink detection (eye aspect ratio via ML Kit landmarks, on-device, free)
- Head turn (left/right) via yaw angle from ML Kit
- Smile prompt (mouth aspect ratio via ML Kit)

**Liveness gate logic:**
1. Run FASNet passive check first. If score < 0.6 → reject immediately.
2. Show one random gesture prompt (blink / turn head / smile).
3. Detect gesture completion within 5-second window.
4. Only if both pass → proceed to face recognition.

---

### 4.4 Model Bundle Size Budget

| Component | Size |
|---|---|
| SCRFD-500M (detector) | ~1.0 MB |
| MobileFaceNet INT8 (recogniser) | ~1.1 MB |
| FASNet (liveness) | ~1.2 MB |
| ONNX Runtime Mobile (Android AAR) | ~3.5 MB |
| ONNX Runtime Mobile (iOS pod) | ~3.5 MB |
| **Total add to Datalake app** | **≈ 10–11 MB** |

> ✅ Safely under the 20 MB cap. Leave ~8 MB headroom for future model updates.

---

## 5. Inference Pipeline (Step-by-Step)

```
Camera Frame (YUV/NV21 from VisionCamera)
          │
          ▼
[imageUtils] YUV → RGB, resize to 640×640
          │
          ▼
[SCRFD-500M] Detect face bounding box + 5 keypoints
          │ (if no face → show "No face detected" prompt)
          ▼
[FASNet × 2] Passive liveness at scale 2.7 and 4.0
          │ (if fake → reject, log attempt)
          ▼
[ML Kit] Active gesture check (blink / yaw / smile)
          │ (if timeout → retry, max 3 attempts)
          ▼
[ArcFace align] 5-point similarity transform → 112×112 RGB crop
Normalise: pixel = (pixel/255.0 - 0.5) / 0.5  per channel
          │
          ▼
[MobileFaceNet INT8] → 512-dim L2-normalised embedding
          │
          ▼
[EmbeddingStore] Load enrolled embeddings from SQLite (AES-256 decrypted)
          │
          ▼
[cosineDistance] Compare against all enrolled users
  cosine_similarity = dot(a, b) / (||a|| × ||b||)
  threshold: similarity > 0.65 → MATCH (tune on validation set)
          │
     ┌────┴────┐
   MATCH    NO MATCH
     │          │
     ▼          ▼
Log attendance  Log failed attempt + face crop thumbnail
to SQLite       to SQLite (for audit)
(synced=0)
```

**Total pipeline latency budget on Snapdragon 778G-class CPU:**

| Stage | Budget |
|---|---|
| YUV→RGB + resize | ~5 ms |
| SCRFD face detect | ~25 ms |
| FASNet × 2 liveness | ~40 ms |
| ArcFace alignment | ~5 ms |
| MobileFaceNet embed | ~25 ms |
| Cosine similarity (N=500 users) | ~5 ms |
| **Total** | **~105 ms** ✅ |

---

## 6. Native Module Specification

### 6.1 Interface Contract (TypeScript)

```typescript
// src/services/FaceEngine.ts

export interface DetectionResult {
  found: boolean;
  bbox?: { x: number; y: number; w: number; h: number };
  landmarks?: [number, number][];  // 5 points [[x,y], ...]
  confidence?: number;
}

export interface LivenessResult {
  isLive: boolean;
  score: number;                    // 0.0 – 1.0
}

export interface EmbeddingResult {
  embedding: number[];              // length 512, L2-normalised
  inferenceMs: number;
}

// Native module methods (implemented in Kotlin + Swift):
export interface IFaceEngineNative {
  detectFace(base64Frame: string): Promise<DetectionResult>;
  checkLiveness(base64Frame: string, bbox: [number,number,number,number]): Promise<LivenessResult>;
  getEmbedding(base64Frame: string, landmarks: [number,number][]): Promise<EmbeddingResult>;
  initModels(): Promise<void>;      // call once at app start
  releaseModels(): Promise<void>;   // call in component cleanup
}
```

### 6.2 Android Native Module (Kotlin)

**File:** `src/native/android/FaceEngineModule.kt`

```kotlin
// Key responsibilities:
// 1. Load all three ONNX models from assets/ on initModels()
// 2. Decode base64 → Bitmap → YUV/RGB ByteArray as needed
// 3. Run SCRFD inference via OrtSession
// 4. Run FASNet inference (two scales)
// 5. Run MobileFaceNet inference after alignment
// 6. Return results as WritableMap to JS

// Dependencies in android/app/build.gradle:
// implementation("com.microsoft.onnxruntime:onnxruntime-android:1.18.0")

// Model loading pattern:
val env = OrtEnvironment.getEnvironment()
val opts = OrtSession.SessionOptions().apply {
    addNnapi()          // use NNAPI accelerator if available
    setIntraOpNumThreads(2)
}
val session = env.createSession(modelBytes, opts)
```

**ONNX Runtime execution providers (Android priority order):**
1. NNAPI (Android Neural Networks API), on devices with DSP/NPU
2. XNNPACK (optimised ARM CPU kernels), fallback
3. CPU (plain OrtCPU), last resort

### 6.3 iOS Native Module (Swift)

**File:** `ios/FaceEngine/FaceEngine.swift`

```swift
// Key responsibilities:
// 1. Load models from Bundle on initModels()
// 2. Decode base64 → UIImage → CVPixelBuffer
// 3. Run OrtSession inference for all three models
// 4. Return results via RCTPromise

// CocoaPods in ios/Podfile:
// pod 'onnxruntime-objc', '1.18.0'

// Execution providers (iOS priority order):
// 1. CoreML (Apple Neural Engine + GPU)
// 2. CPU fallback
```

### 6.4 Frame Processing Strategy

- Use `react-native-vision-camera` v4 for camera frames.
- Do NOT run inference on every frame (too slow). Use a frame gate:
  - Process every **5th frame** (~6 FPS analysis at 30 FPS camera).
  - Once a stable face is detected for 3 consecutive sampled frames, lock in and run
    the full liveness + recognition pipeline.
- Use `useFrameProcessor` with `react-native-worklets-core` for the detection-only pass.
- Run liveness + recognition in the Kotlin/Swift native module asynchronously.

---

## 7. Database Schema

```sql
-- Enrolled face embeddings (permanent on-device)
CREATE TABLE IF NOT EXISTS face_embeddings (
  id          TEXT PRIMARY KEY,          -- UUID v4
  employee_id TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  department  TEXT,
  embedding   BLOB NOT NULL,             -- AES-256 encrypted Float32Array (512 × 4 bytes)
  enrolled_at INTEGER NOT NULL,          -- Unix timestamp ms
  version     INTEGER DEFAULT 1
);

-- Attendance log (ephemeral, purged after S3 sync)
CREATE TABLE IF NOT EXISTS attendance_log (
  id              TEXT PRIMARY KEY,      -- UUID v4
  employee_id     TEXT NOT NULL,
  event_type      TEXT NOT NULL,         -- 'check_in' | 'check_out' | 'failed_attempt'
  timestamp       INTEGER NOT NULL,      -- Unix timestamp ms
  location_lat    REAL,
  location_lon    REAL,
  device_id       TEXT NOT NULL,
  confidence      REAL,                  -- cosine similarity score
  liveness_score  REAL,
  face_thumbnail  BLOB,                  -- JPEG, max 20 KB, for audit trail
  synced          INTEGER DEFAULT 0,     -- 0 = pending, 1 = synced
  sync_attempt    INTEGER DEFAULT 0,     -- retry counter
  created_at      INTEGER NOT NULL
);

-- Sync metadata
CREATE TABLE IF NOT EXISTS sync_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Keys: 'last_sync_ts', 'device_id', 'sync_endpoint'
```

**Encryption:** Face embeddings are AES-256-GCM encrypted before writing to SQLite.
Key is derived from device hardware ID using PBKDF2 with 100,000 iterations.
Use `react-native-encrypted-storage` for the key itself.

---

## 8. AWS S3 Sync & Purge Mechanism

### 8.1 Architecture

```
Mobile App                    Your Backend (Node.js/Lambda)         AWS S3
    │                                    │                             │
    │──── GET /sync/presigned-urls ──────▶│                             │
    │         (batch, up to 50 records)  │──── s3.createPresignedPost ─▶│
    │◀─── [{url, fields, record_id}, ...]│                             │
    │                                    │                             │
    │──── PUT <presigned_url> ───────────────────────────────────────▶│
    │     (JSON: attendance_record)                                    │
    │◀─── 200 OK ────────────────────────────────────────────────────│
    │                                    │                             │
    │──── POST /sync/confirm ────────────▶│                             │
    │     {confirmed_ids: [...]}         │── mark records confirmed ───│
    │◀─── 200 OK ────────────────────────│                             │
    │                                    │                             │
    │  [LOCAL PURGE: DELETE FROM attendance_log WHERE id IN (...)]
```

### 8.2 SyncService Implementation Contract

```typescript
// src/services/SyncService.ts

class SyncService {
  // Called by useNetworkSync when connectivity is restored
  async syncPendingRecords(): Promise<SyncResult> {
    // 1. SELECT * FROM attendance_log WHERE synced=0 LIMIT 50
    // 2. Request presigned URLs from backend (batch)
    // 3. For each record: PUT JSON to presigned URL
    // 4. On 200: add to confirmedIds[]
    // 5. POST /sync/confirm with confirmedIds
    // 6. On confirm success: DELETE FROM attendance_log WHERE id IN (confirmedIds)
    // 7. UPDATE sync_meta SET value=NOW() WHERE key='last_sync_ts'
  }

  async getSyncStats(): Promise<{ pending: number; lastSync: Date | null }> { ... }
}
```

### 8.3 S3 Bucket Structure

```
s3://datalake-attendance/
  {device_id}/
    {YYYY-MM-DD}/
      {record_id}.json    ← attendance log record
```

### 8.4 Network Detection

```typescript
// src/hooks/useNetworkSync.ts
import NetInfo from '@react-native-community/netinfo';

// Subscribe to network changes
const unsubscribe = NetInfo.addEventListener(state => {
  if (state.isConnected && state.isInternetReachable) {
    SyncService.syncPendingRecords();
  }
});
```

---

## 9. Liveness Detection Detail

### 9.1 Passive Liveness (FASNet)

```typescript
// src/services/LivenessService.ts

async function passiveLivenessCheck(
  frame: Base64Frame,
  bbox: BoundingBox
): Promise<{ isLive: boolean; score: number }> {
  // Two-scale check as per Silent-Face-Anti-Spoofing paper
  const scale1 = cropAndResize(frame, bbox, 2.7, 80);  // 80×80 crop at 2.7× scale
  const scale2 = cropAndResize(frame, bbox, 4.0, 80);
  const [score1, score2] = await Promise.all([
    FaceEngine.checkLiveness(scale1),
    FaceEngine.checkLiveness(scale2),
  ]);
  const finalScore = (score1 + score2) / 2;
  return { isLive: finalScore > 0.6, score: finalScore };
}
```

### 9.2 Active Liveness (Gesture)

```typescript
// Gesture prompts, randomly select one per session
const GESTURES = ['BLINK', 'TURN_LEFT', 'TURN_RIGHT', 'SMILE'] as const;

// Detection via Google ML Kit Face Detection (on-device, offline-capable)
// - BLINK: leftEyeOpenProbability < 0.2 for at least 2 consecutive frames
// - TURN_LEFT: headEulerAngleY > 20 degrees
// - TURN_RIGHT: headEulerAngleY < -20 degrees
// - SMILE: smilingProbability > 0.7
// Timeout: 5 seconds, max 3 retries before hard fail
```

---

## 10. Enrollment Flow

```
EnrollScreen
│
├── Step 1: Capture 3 face images (different angles: frontal, slight left, slight right)
│   - Each capture: full pipeline up to embedding
│   - Show green bounding box when face is stable
│
├── Step 2: Average the 3 embeddings → single enrolment embedding
│   enrolled_vec = L2_normalize((e1 + e2 + e3) / 3)
│
├── Step 3: Encrypt embedding → store in face_embeddings table
│   (include employee_id, name from Datalake 3.0 user directory)
│
└── Step 4: Confirm on screen → ready for auth
```

---

## 11. Authentication Flow (AuthScreen)

```
1. Camera opens → SCRFD runs every 5th frame
2. On stable face detected (3 consecutive frames):
   a. Show "Hold still…" overlay
   b. Run FASNet passive liveness
   c. If live: show gesture prompt
   d. On gesture success: run MobileFaceNet → get embedding
   e. Compare against enrolled embeddings
   f. If similarity > 0.65: AUTHENTICATED
      → Write attendance_log record (synced=0)
      → Show success overlay with employee name
   g. If similarity < 0.65 but > 0.45: UNCERTAIN
      → Prompt retry (max 3)
   h. If similarity < 0.45 OR liveness fail: REJECTED
      → Log failed attempt → show rejection message

3. After auth: stay on screen for next personnel or navigate
```

---

## 12. Security Requirements

| Requirement | Implementation |
|---|---|
| Embeddings at rest | AES-256-GCM encrypted in SQLite BLOB |
| Encryption key storage | `react-native-encrypted-storage` (Android Keystore / iOS Secure Enclave) |
| No raw images stored permanently | Only 20 KB JPEG thumbnails in failed_attempt logs; purged on sync |
| Model files | Stored in app bundle (Android assets / iOS Bundle); not user-accessible |
| S3 upload | Presigned URL (15-min TTL); no permanent AWS credentials on device |
| Attendance records | Encrypted JSON payload in S3 |
| Failed attempt rate limiting | Lock auth screen for 30 s after 5 consecutive failures |

---

## 13. Dependencies & Versions

### 13.1 npm / yarn

```json
{
  "dependencies": {
    "react-native": "0.75.x",
    "react-native-vision-camera": "^4.5.0",
    "react-native-worklets-core": "^1.3.0",
    "onnxruntime-react-native": "^1.20.0",
    "@react-native-community/netinfo": "^11.3.0",
    "react-native-sqlite-storage": "^6.0.1",
    "react-native-encrypted-storage": "^4.0.3",
    "react-native-vision-camera-face-detector": "^1.7.0",
    "@react-native-ml-kit/face-detection": "^0.1.0",
    "react-native-fs": "^2.20.0",
    "uuid": "^9.0.0",
    "axios": "^1.6.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "@types/react-native": "^0.73.0",
    "jest": "^29.0.0",
    "@testing-library/react-native": "^12.0.0"
  }
}
```

### 13.2 Android (android/app/build.gradle)

```gradle
dependencies {
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.18.0")
    // NNAPI and XNNPACK are bundled in the AAR above
}

android {
    defaultConfig {
        minSdkVersion 26  // Android 8.0
    }
    aaptOptions {
        noCompress "onnx"  // prevent asset compression of model files
    }
}
```

### 13.3 iOS (ios/Podfile)

```ruby
pod 'onnxruntime-objc', '1.18.0'
pod 'onnxruntime-react-native', :path => '../node_modules/onnxruntime-react-native'
```

### 13.4 Python (scripts/requirements.txt)

```
onnx==1.16.0
onnxruntime==1.18.0
onnxruntime-tools==1.7.0
onnx-simplifier==0.4.35
insightface==0.7.3
torch==2.3.0
opencv-python==4.10.0
numpy==1.26.0
scikit-image==0.23.0
```

---

## 14. Performance Benchmarks (Target)

| Metric | Target | Measurement device |
|---|---|---|
| Face detection (SCRFD) | < 30 ms | Snapdragon 778G, 1 thread |
| Liveness check (FASNet × 2) | < 50 ms | Snapdragon 778G, 1 thread |
| Face embedding (MobileFaceNet) | < 30 ms | Snapdragon 778G, 1 thread |
| End-to-end pipeline | **< 200 ms** | Snapdragon 778G, 3 GB RAM |
| Recognition accuracy (LFW) | > 99 % | float32 baseline |
| Recognition accuracy (INT8) | > 99 % | quantised model |
| False Accept Rate | < 0.1 % | at threshold 0.65 |
| False Reject Rate | < 5 % | at threshold 0.65 |
| App size delta | < 12 MB | over base Datalake 3.0 |

Run `scripts/validate_models.py` to generate a `BENCHMARKS.md` with actual numbers.

---

## 15. Indian Demographics & Outdoor Lighting Handling

### 15.1 Preprocessing Augmentations (at inference time)

```typescript
// src/utils/imageUtils.ts

function preprocessFrame(frame: Uint8Array, targetSize: number): Float32Array {
  // Step 1: Histogram equalisation (handles harsh sunlight / low light)
  const equalised = histogramEqualise(frame);

  // Step 2: Gamma correction (compensates for shadows)
  const gamma = estimateGamma(equalised);  // auto-gamma based on mean luminance
  const corrected = applyGamma(equalised, gamma);

  // Step 3: Resize to target (640×640 for detector, 112×112 for recogniser)
  const resized = bilinearResize(corrected, targetSize);

  // Step 4: Normalise to [-1, 1]
  return new Float32Array(resized).map(v => (v / 255.0 - 0.5) / 0.5);
}
```

### 15.2 Model Fine-tuning (offline, before submission)

- Fine-tune MobileFaceNet on a curated Indian face dataset:
  - **MS1M-ArcFace** subset filtered for South/South-East Asian faces (~50K identities)
  - **IITB-Kinship** dataset (publicly available)
  - Augmentations: random brightness ±30 %, colour jitter, Gaussian blur, JPEGcompression at 60–90 quality
- Target: ≥ 97 % accuracy on a held-out Indian faces validation set of 500 identities.
- See `scripts/export_mobilefacenet.py` for fine-tuning hooks.

---

## 16. Mandatory Deliverables Checklist

```
[ ] Working prototype APK (Android debug + release)
[ ] Working prototype IPA (iOS simulator + device build)
[ ] Source code (this repository, public GitHub)
[ ] SPEC.md (this file)
[ ] ARCHITECTURE.md
[ ] MODEL_PIPELINE.md
[ ] BENCHMARKS.md (auto-generated by validate_models.py)
[ ] README.md (quick-start for evaluators in < 5 minutes)
[ ] Presentation slide deck (PPTX or PDF, ≤ 20 slides)
[ ] Demo video (< 3 minutes, screen recording of auth + sync)
```

---

## 17. Build & Run Instructions

### 17.1 Prerequisites

```bash
# Node 20+, Ruby 3.2+ (iOS), Java 17+ (Android), Xcode 15+ (macOS only)
node --version   # ≥ 20
ruby --version   # ≥ 3.2
java --version   # ≥ 17
```

### 17.2 Install Dependencies

```bash
npm install
cd ios && pod install && cd ..
```

### 17.3 Prepare Models (Python, run once)

```bash
cd scripts
pip install -r requirements.txt
python export_scrfd.py           # → ../models/scrfd_500m_fixed.onnx
python export_mobilefacenet.py   # → ../models/mobilefacenet_int8.onnx
python export_fasnet.py          # → ../models/fasnet_anti_spoof.onnx
python validate_models.py        # → ../BENCHMARKS.md
cd ..

# Copy models to platform assets
cp models/*.onnx android/app/src/main/assets/
cp models/*.onnx ios/OfflineID/
```

### 17.4 Run on Android

```bash
npx react-native run-android
```

### 17.5 Run on iOS (macOS only)

```bash
npx react-native run-ios --simulator "iPhone 14"
```

### 17.6 Run Tests

```bash
npm test                        # Jest unit tests
npm run test:e2e               # Detox E2E (requires device/emulator)
```

---

## 18. Open Questions / Known Risks

| Risk | Mitigation |
|---|---|
| ONNX Runtime RN v1.20 may have uint8 tensor issues on iOS | Pin to 1.18.0; use float32 for iOS tensors |
| VisionCamera v4 frame processor pixel format mismatch | Request `yuv` format on Android, `native` on iOS; convert in native module |
| FASNet model original is PyTorch - ONNX export may need opset patching | Use `torch.onnx.export(..., opset_version=11)` |
| ArcFace alignment implemented in native (no OpenCV on device) | Implement similarity transform manually in Kotlin/Swift (2×3 matrix) |
| SQLite encryption overhead | Encrypt only the embedding BLOB, not entire DB |
| Presigned URL expiry during large batch sync | Request URLs in batches of 10, not 50; refresh if 403 received |

---

## 19. File Ownership Map

| File | Language | Priority | Depends on |
|---|---|---|---|
| `scripts/export_*.py` | Python | P0 | Requirements.txt |
| `src/native/android/FaceEngineModule.kt` | Kotlin | P0 | ONNX RT AAR |
| `ios/FaceEngine/FaceEngine.swift` | Swift | P0 | ONNX RT pod |
| `src/services/FaceEngine.ts` | TypeScript | P0 | Native modules |
| `src/db/schema.ts` | TypeScript | P0 | - |
| `src/services/EmbeddingStore.ts` | TypeScript | P0 | schema.ts |
| `src/services/AttendanceStore.ts` | TypeScript | P0 | schema.ts |
| `src/services/LivenessService.ts` | TypeScript | P1 | FaceEngine.ts |
| `src/hooks/useFaceAuth.ts` | TypeScript | P1 | All services |
| `src/screens/AuthScreen.tsx` | TypeScript/React | P1 | useFaceAuth.ts |
| `src/screens/EnrollScreen.tsx` | TypeScript/React | P1 | useFaceAuth.ts |
| `src/services/SyncService.ts` | TypeScript | P2 | AttendanceStore.ts |
| `src/hooks/useNetworkSync.ts` | TypeScript | P2 | SyncService.ts |
| `src/screens/SyncStatusScreen.tsx` | TypeScript/React | P2 | SyncService.ts |
| `src/utils/imageUtils.ts` | TypeScript | P0 | - |
| `src/utils/cosineDistance.ts` | TypeScript | P0 | - |
| `src/utils/crypto.ts` | TypeScript | P0 | encrypted-storage |

---

*End of SPEC.md*
