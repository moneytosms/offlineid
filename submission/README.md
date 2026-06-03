<div align="center">
<img src="../brand_logo.png" alt="OfflineID" width="200" />
</div>

# OfflineID

**NHAI Hackathon 7.0** entry for *"Develop a mobile based secure offline facial recognition
and liveness detection system for remote locations."*

OfflineID is a React Native module that authenticates field personnel with **face
recognition + liveness detection, fully offline** (no internet, no cloud API), then
**syncs-and-purges** attendance to AWS S3 when connectivity returns. It is built to drop
into the existing **Datalake 3.0** app. Four open-source ONNX models (9.1 MB total) run
on-device in about 51 ms on a host CPU.

- **Source code:** https://github.com/moneytosms/offlineid
- **Offline release APK (v1.4.0):** https://github.com/moneytosms/offlineid/releases/tag/v1.4.0

---

## What is in this package

| File | What it is |
|---|---|
| `README.md` | This orientation page, start here. |
| `OfflineID_Hackathon7.pptx` | The presentation, a 16-slide themed deck (mandatory deliverable). |
| `01-PROPOSAL.md` | Solution overview mapped to Innovation / Feasibility / Scalability / Presentation. |
| `02-DATALAKE-3.0-INTEGRATION.md` | Exact steps to drop OfflineID into the Datalake 3.0 app, including the iOS engine. |
| `03-BUILD-OFFLINE-APK.md` | How the standalone offline release APK is built (not debug / Metro). |
| `docs/ARCHITECTURE.md` | System design, data flows, and the security model. |
| `docs/MODEL_PIPELINE.md` | The AI pipeline: detection, alignment, liveness, recognition, preprocessing. |
| `docs/BENCHMARKS.md` | Model sizes and measured latencies. |
| `docs/SPEC.md` | Full functional and technical specification. |
| `docs/SETUP_AND_USAGE.md` | Build, run, and demo walkthrough. |
| `docs/HOT_RELOAD_AND_DEBUGGING.md` | Hot reload, on-device logcat, diagnosing "Not recognised", threshold tuning, emulator caveats. |

---

## How it satisfies the brief

| Constraint | Status |
|---|---|
| React Native, Android + iOS | RN UI shared; Android native engine ships an offline APK; iOS engine written in Swift (`ios/FaceEngine/`), Xcode wiring pending. |
| Model footprint ~20 MB | **9.1 MB** total model bundle. |
| < 1 s recognise + liveness | ~51 ms host-CPU pipeline; sub-second on mid-range ARM. |
| Android 8+ / iOS 12+, 3 GB RAM, no GPU | CPU-only ONNX Runtime (XNNPACK / NNAPI). |
| > 95% accuracy | MobileFaceNet (LFW 99.5%) + inference-time lighting normalisation. |
| Offline liveness (blink/smile/turn) | Passive FASNet anti-spoof plus active gesture sequence. |
| Sync & purge to AWS | Presigned-S3 batch upload, then local purge. |
| Open-source only | MIT / Apache stack, full source shared. |
| Low-light operation | Ambient light sensor (TYPE_LIGHT) activates fill-light overlay at < 15 lux (configurable); screen brightness maximised to illuminate face. |

---

## Feature Reference (v1.4.0)

> Every feature works fully offline unless noted otherwise.

### 1. Core AI Pipeline

| Feature | Detail |
|---|---|
| **Face Detection** | SCRFD-500M (2.41 MB) - detects face + 5 landmarks in a single forward pass at 640×640 |
| **Anti-Spoofing (Passive)** | MiniFASNetV2 + MiniFASNetV1SE - two-scale (2.7× and 4.0×) crop inference in BGR; P(real) > 0.6 to pass |
| **Active Liveness** | ML Kit on-device: random gesture selected per session - **blink** (EAR), **head turn** (yaw ±20°), or **smile**; 5-second window |
| **Face Recognition** | MobileFaceNet INT8 (3.35 MB) - 512-dim L2-normalised embedding; ArcFace 5-point alignment (no OpenCV, manual similarity transform) |
| **Matching** | Cosine similarity vs all enrolled embeddings; > 0.65 = match, 0.45–0.65 = retry, < 0.45 = reject |
| **Model Bundle** | 4 ONNX models, **9.09 MB** total (cap: 20 MB); ~51 ms host-CPU pipeline |

### 2. Enrolment

- **3-angle capture**: frontal + slight left + slight right; embeddings averaged and L2-normalised
- **Fields stored**: Employee ID, Name, Department
- **Storage**: AES-256-GCM encrypted embedding BLOB in SQLite (`face_embeddings` table)
- **Key management**: Android Keystore (hardware-backed on supported devices)
- **No raw images stored** - only the encrypted 512-float embedding

### 3. Authentication (Scan)

- Full pipeline: SCRFD detect → FASNet×2 passive liveness → ML Kit gesture → MobileFaceNet embed → cosine match
- **Result tiers**: Granted (> 0.65) / Retry (0.45–0.65) / Rejected (< 0.45)
- **Rate limiting**: 5 failures → 30-second lockout
- **Attendance row** written to SQLite on success (`synced = 0`, purged after sync)

### 4. Security

| Feature | Implementation |
|---|---|
| Embedding encryption | AES-256-GCM, key in Android Keystore / iOS Secure Enclave |
| No raw image persistence | Audit thumbnails ≤ 20 KB, purged after sync |
| No cloud credentials on device | Presigned S3 URLs (15-min TTL) - server holds the key |
| Failure lockout | 30 s lockout after 3 consecutive rejections |
| Two-layer liveness | Passive anti-spoof (FASNet) + active gesture - defeats printed photos, screen replays, 2D masks |

### 5. Offline-First Data

- **Fully offline**: enrolment, authentication, liveness, attendance logging - all on-device
- **SQLite on-device**: `face_embeddings` (permanent, encrypted) + `attendance_log` (ephemeral, purged on sync)
- **Sync queue**: unsynced rows batched ≤ 10 per request
- **Auto-sync**: NetInfo reconnect event triggers `SyncService`
- **Manual sync**: "Sync now" button on the Sync tab
- **Purge on ACK**: local attendance rows deleted after S3 confirms receipt

### 6. Sync & Cloud

- Reconnect → batch ≤ 10 pending rows → request presigned PUT URLs → upload to S3 → confirm → **local DELETE**
- Exponential backoff on failure; 403 triggers presigned-URL refresh
- `SyncBadge` in header shows live unsynced count

### 7. Low-Light & Outdoor Handling

| Feature | Detail |
|---|---|
| Ambient sensor | Android `TYPE_LIGHT` sensor polled continuously during scanning |
| Fill-light activation | Screen brightness → maximum; 4 white overlay panels frame the face oval at **< 15 lux** (configurable) |
| Fill-light deactivation | Hysteresis: turns off at **28 lux** (configurable) to avoid flicker |
| Zero hardware | Screen acts as ring light - no external flash or LEDs needed |
| Inference normalisation | Histogram equalisation + auto-gamma applied at inference time for harsh sun, deep shadow, and back-lit scenes |

### 8. Configurable Preferences

All preferences persist across app restarts.

| Preference | Default | Where |
|---|---|---|
| Lux activation threshold | 15 lux | Settings → Display |
| Lux deactivation threshold | 28 lux | Settings → Display |
| Fill-light brightness | 100 % | Settings → Display |
| Screen wake-lock | On | Settings → Display |
| Camera zoom level | 1.0× | Settings → Display |
| Haptic feedback | On | Settings → Technical |
| Auto-restart on result | Off | Settings → Technical |
| Match / liveness thresholds | 0.65 / 0.6 | Settings → Technical |

### 9. Settings Subviews

- **Display** - fill-light, lux thresholds, screen wake-lock, zoom
- **Technical** - model thresholds, haptic, auto-restart
- **Help** - in-app gesture explainers (blink/smile/turn), tips for best results, data privacy info

### 10. In-App Help Guide

- Gesture explainers with visual cues for each liveness prompt
- Tips for positioning, lighting, and re-enrolment
- Data privacy summary (no images stored, on-device processing, what syncs to S3)
- No external docs required - self-contained

### 11. Navigation (5 Tabs)

| Tab | Purpose |
|---|---|
| **Scan** | Authenticate a person - runs full pipeline, logs attendance |
| **Enrol** | Register a new person - 3-angle capture, encrypted storage |
| **People** | Browse enrolled persons, view count, delete enrolments |
| **Sync** | Manual sync trigger, unsynced count, sync status |
| **System** | Settings subviews (Display/Technical/Help), device info, about screen, factory reset |

### 12. App Quality

| Item | Status |
|---|---|
| TypeScript strict | ✅ clean `tsc --noEmit` |
| Unit tests | ✅ 15/15 (Jest) |
| Release APK | ✅ arm64-v8a, ~62 MB, runs airplane-mode |
| Open-source only | ✅ MIT / Apache stack, no paid licences |
| Datalake 3.0 drop-in | ✅ register package + import screens + call `initModels()` |

### 13. Platform Support

| Platform | Status |
|---|---|
| Android 8.0+ (arm64-v8a) | ✅ Full native engine, release APK verified on hardware |
| iOS 12+ | Swift engine written (`ios/FaceEngine/FaceEngine.swift`), identical models + ArcFace math; Xcode wiring pending (needs Mac) |
| React Native 0.75 | Shared JS/TS layer across both platforms |
| ONNX Runtime | CPU / XNNPACK / NNAPI (Android) · CPU / CoreML (iOS) |
