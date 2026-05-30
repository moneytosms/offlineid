# ARCHITECTURE.md - System Architecture
## OfflineID · Hackathon 7.0

> Read alongside `SPEC.md` and `MODEL_PIPELINE.md`.

---

## 1. High-Level System View

```
┌─────────────────────────────────────────────────────────────┐
│                   Datalake 3.0 React Native App             │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │               OfflineID Module                      │   │
│  │                                                     │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │   │
│  │  │  Enroll  │  │  Auth    │  │   Sync Status    │  │   │
│  │  │  Screen  │  │  Screen  │  │   Screen         │  │   │
│  │  └────┬─────┘  └────┬─────┘  └────────┬─────────┘  │   │
│  │       │              │                 │             │   │
│  │       └──────────────┴─────────────────┘             │   │
│  │                      │                               │   │
│  │              ┌───────▼──────────┐                    │   │
│  │              │  useFaceAuth()   │                    │   │
│  │              └───────┬──────────┘                    │   │
│  │                      │                               │   │
│  │     ┌────────────────┼───────────────────┐          │   │
│  │     │                │                   │           │   │
│  │     ▼                ▼                   ▼           │   │
│  │  FaceEngine     LivenessService     EmbeddingStore   │   │
│  │  (Native)       (TS + ML Kit)       (SQLite+AES)    │   │
│  │     │                │                   │           │   │
│  │     ▼                │                   ▼           │   │
│  │  ┌──────────┐        │           AttendanceStore     │   │
│  │  │ ONNX RT  │        │           (SQLite)            │   │
│  │  │ Mobile   │        │                   │           │   │
│  │  │ Android  │        │           SyncService         │   │
│  │  │ / iOS    │        │           (on reconnect)      │   │
│  │  └──────────┘        │                   │           │   │
│  │     │                │                   │           │   │
│  └─────┼────────────────┼───────────────────┼───────────┘   │
│        │                │                   │               │
│  ONNX Models       ML Kit               AWS S3             │
│  (bundled in       (bundled)            (when online)      │
│   app assets)                                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Native Module Architecture

### 2.1 Android (Kotlin) - FaceEngineModule

```
android/app/src/main/
├── java/com/offlineid/
│   ├── FaceEngineModule.kt        ← main module
│   └── FaceEnginePackage.kt       ← RN registration
└── assets/
    ├── scrfd_500m_fixed.onnx
    ├── mobilefacenet_int8.onnx
    └── fasnet_anti_spoof.onnx
```

**Threading model:**
- All ONNX inference runs on a dedicated `HandlerThread` named `OrtInference`
- Results are marshalled back to JS via `Promise` resolve/reject
- OrtEnvironment and OrtSession are singletons, created once in `initModels()`
- Each inference call gets its own `OrtSession.run()` invocation (thread-safe)

**NNAPI execution provider:**
```kotlin
val opts = OrtSession.SessionOptions()
try {
    opts.addNnapi()  // only available on Android 8.1+
} catch (e: OrtException) {
    // NNAPI not available, silently fall back to CPU
}
opts.addXnnpack(mapOf())  // always add XNNPACK as CPU accelerator
```

### 2.2 iOS (Swift) - FaceEngineModule

```
ios/OfflineID/
├── FaceEngine.swift          ← main module
├── FaceEngineModule.m              ← ObjC bridge header (required for RN)
├── scrfd_500m_fixed.onnx
├── mobilefacenet_int8.onnx
└── fasnet_anti_spoof.onnx
```

**CoreML execution provider:**
```swift
let coreMLOptions = try OrtSessionOptions()
try coreMLOptions.appendCoreMLExecutionProvider(
    with: ORTCoreMLExecutionProviderOptions()
)
// CoreML compiles the model on first run (~2s), cached thereafter
```

**Memory management:**
- `OrtEnv` and all three `OrtSession` objects are stored as class properties
- `initModels()` is called from `AppDelegate` to pre-warm on launch
- `releaseModels()` is called in `applicationDidEnterBackground` to free memory

---

## 3. Data Flow Diagrams

### 3.1 Enrollment Flow

```
User (field admin)
    │
    │  Opens EnrollScreen
    ▼
CameraView (VisionCamera)
    │  streams frames
    ▼
useFrameProcessor (JS Worklet)
    │  every 5th frame: detectFace()
    ▼
FaceEngineModule.detectFace (Kotlin/Swift)
    │  runs SCRFD-500M
    │  returns bbox + landmarks
    ▼
UI: shows green bounding box overlay
    │  when stable (3 frames): shows "Capture" button
    ▼
User taps Capture (3 times, at different angles)
    │
    ▼
For each capture:
    FaceEngineModule.getEmbedding()
    │  ArcFace alignment (5-point similarity transform)
    │  MobileFaceNet INT8 → 512-dim embedding
    ▼
Average 3 embeddings → L2 normalise
    │
    ▼
EmbeddingStore.enrol(employeeId, name, avgEmbedding)
    │  AES-256-GCM encrypt embedding BLOB
    │  INSERT INTO face_embeddings
    ▼
Success screen → navigate back
```

### 3.2 Authentication Flow

```
Camera Frame
    │
    ▼ (every 5th frame)
SCRFD detect
    │
    ├── No face → "Position your face" prompt
    │
    └── Face found:
        │
        ▼
        FASNet passive liveness
        │
        ├── Fake (score < 0.6) → "Spoof detected" alert, log attempt
        │
        └── Live (score ≥ 0.6):
            │
            ▼
            ML Kit gesture prompt (random)
            │
            ├── Timeout (5s) → retry (max 3) → fail
            │
            └── Gesture confirmed:
                │
                ▼
                MobileFaceNet embedding
                │
                ▼
                Load all enrolled embeddings from SQLite
                (decrypt AES-256-GCM)
                │
                ▼
                Cosine similarity vs each enrolled user
                │
                ├── Best match > 0.65 → AUTH SUCCESS
                │   ├── Write attendance_log (synced=0)
                │   └── Show: "Welcome, <name>! ✓"
                │
                ├── Best match 0.45–0.65 → UNCERTAIN
                │   └── "Please try again" (max 3 retries)
                │
                └── Best match < 0.45 → REJECTED
                    ├── Write failed_attempt log
                    └── Show: "Not recognised"
```

### 3.3 Sync Flow

```
NetInfo detects internet restored
    │
    ▼
useNetworkSync → SyncService.syncPendingRecords()
    │
    ▼
SELECT * FROM attendance_log WHERE synced=0 LIMIT 50
    │
    ├── 0 records → done
    │
    └── N records:
        │
        ▼
        POST /sync/presigned-urls
        Body: { count: N, device_id }
        │
        ▼ (receive [{id, presigned_url, fields}, ...])
        │
        For each record (parallel, max 5 concurrent):
            PUT <presigned_url>
            Body: JSON.stringify(attendance_record)
            Headers: { Content-Type: application/json }
            │
            ├── 200 OK → add to confirmedIds
            └── Error → increment sync_attempt, leave synced=0
        │
        ▼
        POST /sync/confirm
        Body: { confirmed_ids: [...] }
        │
        ▼
        DELETE FROM attendance_log WHERE id IN (confirmed_ids)
        UPDATE sync_meta SET value=NOW() WHERE key='last_sync_ts'
        │
        ▼
        Emit 'sync_complete' event → update SyncBadge
```

---

## 4. Security Architecture

```
┌────────────────────────────────────────────────┐
│              Security Layers                    │
│                                                │
│  Layer 4: Transport (HTTPS + S3 presigned)     │
│  ─────────────────────────────────────────     │
│  Layer 3: Record payload (JSON, encrypted?)    │
│           (Recommendation: encrypt at app      │
│            layer too before upload)            │
│  ─────────────────────────────────────────     │
│  Layer 2: SQLite embedding BLOB (AES-256-GCM)  │
│           Key: device HW ID → PBKDF2          │
│           Nonce: random 12-byte per record     │
│  ─────────────────────────────────────────     │
│  Layer 1: Key storage (Keystore / Secure Encl) │
│           react-native-encrypted-storage       │
└────────────────────────────────────────────────┘
```

**AES-256-GCM encryption in TypeScript:**
```typescript
// src/utils/crypto.ts
import EncryptedStorage from 'react-native-encrypted-storage';

const KEY_ALIAS = 'offlineid_embedding_key';

export async function getOrCreateKey(): Promise<CryptoKey> {
  let keyBase64 = await EncryptedStorage.getItem(KEY_ALIAS);
  if (!keyBase64) {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    keyBase64 = Buffer.from(keyBytes).toString('base64');
    await EncryptedStorage.setItem(KEY_ALIAS, keyBase64);
  }
  return crypto.subtle.importKey(
    'raw', Buffer.from(keyBase64, 'base64'), 'AES-GCM', false, ['encrypt', 'decrypt']
  );
}

export async function encryptEmbedding(embedding: Float32Array): Promise<Uint8Array> {
  const key = await getOrCreateKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    embedding.buffer
  );
  // Prepend IV to ciphertext
  const result = new Uint8Array(12 + encrypted.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), 12);
  return result;
}
```

---

## 5. Integration with Datalake 3.0

The OfflineID module is designed as a **self-contained plugin** that plugs into the
existing Datalake 3.0 app with minimal changes.

**Required changes to Datalake 3.0:**
1. Add OfflineID's `android/` and `ios/` native module files
2. Register `FaceEnginePackage` in `MainApplication.kt` (Android)
3. Add pod references in existing `Podfile` (iOS)
4. Import `AuthScreen` and `EnrollScreen` into the Datalake 3.0 navigation stack
5. Add `SyncBadge` to the Datalake 3.0 header/toolbar
6. Call `FaceEngine.initModels()` in the app's root `useEffect`

**Zero changes to:** Datalake 3.0 API layer, authentication backend, user directory.

---

## 6. Offline Capability Matrix

| Feature | Offline | Online |
|---|---|---|
| Face enrollment | ✅ Full | ✅ Full |
| Face authentication | ✅ Full | ✅ Full |
| Liveness detection | ✅ Full | ✅ Full |
| Attendance logging | ✅ Local SQLite | ✅ Local SQLite |
| Sync to S3 | ❌ Queued | ✅ Batch upload |
| Employee directory lookup | ✅ Cached SQLite | ✅ Refreshed |
| Model inference | ✅ Always (bundled) | ✅ Always (bundled) |

---

## 7. Error Handling Strategy

| Error | Behaviour |
|---|---|
| ONNX session init fails | Show "AI engine unavailable" screen; log to Sentry/Crashlytics |
| No face detected for 10s | Auto-timeout; show "Try better lighting" hint |
| Liveness spoofing detected | Hard reject; lock for 30s; log with thumbnail |
| Embedding store corrupt | Offer re-enrollment; DO NOT delete existing records silently |
| Sync network failure | Exponential backoff (1s, 2s, 4s, 8s, max 60s); keep records in SQLite |
| S3 presigned URL expired | Detect 403; re-request URL batch; retry upload |
| SQLite disk full | Alert user; do NOT write attendance record (prevents silent data loss) |

---

*End of ARCHITECTURE.md*
