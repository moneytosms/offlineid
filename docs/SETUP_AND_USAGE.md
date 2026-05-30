# OfflineID — Setup, Build & Usage Guide

> Offline facial recognition + liveness detection module for React Native, built for
> **Hackathon 7.0**. Plugs into the Datalake 3.0 app. Zero network dependency for
> enrollment/auth; AWS S3 sync-and-purge on reconnect.
>
> Read with `SPEC.md`, `ARCHITECTURE.md`, `MODEL_PIPELINE.md`, `BENCHMARKS.md`.

---

## 0. What This Is

| | |
|---|---|
| Platform | React Native 0.75.4 (CLI) |
| Languages | TypeScript + Kotlin (Android) + Swift (iOS) |
| AI runtime | ONNX Runtime Mobile (NNAPI / XNNPACK / CoreML) |
| Models | SCRFD-500M (detect) · MobileFaceNet-INT8 (recognise) · MiniFASNetV2 ×2 (liveness) |
| Offline | Enrollment, authentication, liveness, attendance logging — all on-device |
| Online | Batch sync of attendance logs to S3 via presigned URL, then local purge |

---

## 1. Prerequisites

Installed in this workspace already (via `scoop`); listed for reproduction on a fresh machine.

| Tool | Version | Why |
|---|---|---|
| Node.js | ≥ 18 (tested on 25) | RN CLI + Metro bundler |
| JDK | **17** (Temurin) | Android Gradle Plugin 8.6 requires JDK 17 — **not** 21/25 |
| Android SDK | platform-tools, **platforms;android-35**, **build-tools;35.0.0**, **ndk;26.1.10909125** | RN 0.75 + CameraX 1.5 build |
| Python | 3.12 | Model export (torch has no 3.14 wheels) |
| Xcode | 15+ (macOS only) | iOS build — **cannot build on Windows** |

### 1.1 Reproduce the toolchain (Windows / scoop)

```powershell
scoop bucket add java
scoop install temurin17-jdk python312 android-clt

# Android SDK packages (accept licenses, then install)
$env:ANDROID_HOME = "$HOME\scoop\apps\android-clt\current"
$sdk = "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat"
& $sdk --licenses                     # answer y to all
& $sdk "platform-tools" "platforms;android-35" "build-tools;35.0.0" "ndk;26.1.10909125"
```

### 1.2 Required environment variables (every build shell)

```powershell
$env:JAVA_HOME    = "$HOME\scoop\apps\temurin17-jdk\current"   # MUST be JDK 17
$env:ANDROID_HOME = "$HOME\scoop\apps\android-clt\current"
$env:PATH         = "$env:JAVA_HOME\bin;$env:PATH"
```

`android/local.properties` already points `sdk.dir` at the SDK; adjust if your path differs.

---

## 2. Install JS Dependencies

```bash
npm install --legacy-peer-deps
```

`--legacy-peer-deps` is required: vision-camera / worklets-core / netinfo declare
overlapping RN peer ranges.

---

## 3. Prepare the AI Models (run once, offline)

The 4 ONNX models are **not** committed (large, regenerable). Generate them, then copy
into the Android assets folder.

### 3.1 Python env + tooling (no insightface needed)

```powershell
python -m venv .venv
.\.venv\Scripts\pip install torch==2.3.0 --index-url https://download.pytorch.org/whl/cpu
.\.venv\Scripts\pip install onnx==1.16.0 onnxruntime==1.18.0 onnx-simplifier==0.4.35 numpy==1.26.0
```

### 3.2 Acquire source models

```powershell
# SCRFD + MobileFaceNet ship as ONNX inside InsightFace's buffalo_sc pack
Invoke-WebRequest "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_sc.zip" -OutFile models\buffalo_sc.zip
Expand-Archive models\buffalo_sc.zip -DestinationPath models\buffalo_sc
Copy-Item models\buffalo_sc\det_500m.onnx  models\scrfd_500m_raw.onnx
Copy-Item models\buffalo_sc\w600k_mbf.onnx models\mobilefacenet_fp32.onnx

# FASNet (liveness) weights from Silent-Face
cd scripts
git clone --depth 1 https://github.com/minivision-ai/Silent-Face-Anti-Spoofing
cd ..
```

### 3.3 Export + quantise + validate

```powershell
cd scripts
..\.venv\Scripts\python.exe export_scrfd.py          # -> models/scrfd_500m_fixed.onnx
..\.venv\Scripts\python.exe export_mobilefacenet.py  # -> models/mobilefacenet_int8.onnx (INT8)
..\.venv\Scripts\python.exe export_fasnet.py         # -> models/fasnet_2_7.onnx + fasnet_4_0.onnx
..\.venv\Scripts\python.exe validate_models.py       # -> ../BENCHMARKS.md
cd ..
```

### 3.4 Bundle into the app

```powershell
Copy-Item models\scrfd_500m_fixed.onnx,models\mobilefacenet_int8.onnx,models\fasnet_2_7.onnx,models\fasnet_4_0.onnx android\app\src\main\assets\
# iOS: add the same 4 files to ios/OfflineID/ in Xcode (Copy Bundle Resources)
```

> Without these 4 files in `assets/`, the app builds and launches but `initModels()`
> rejects → the UI shows **"AI engine unavailable"**. That is expected pre-export.

---

## 4. Build & Run (Android)

```powershell
# env vars from §1.2 must be set in this shell
cd android
.\gradlew.bat assembleDebug          # -> app/build/outputs/apk/debug/app-debug.apk
cd ..

# or run on a connected device / emulator
npx react-native run-android
```

**Debug APK is large (~260 MB)** — it bundles every ABI + uncompressed ONNX. For the
submission, ship a release build with ABI splits (≈ 10–12 MB delta, meets the SPEC cap):

```powershell
cd android && .\gradlew.bat assembleRelease
```

### 4.1 Emulator (optional)

```powershell
& $sdk "system-images;android-34;google_apis;x86_64"
$avd = "$env:ANDROID_HOME\cmdline-tools\latest\bin\avdmanager.bat"
& $avd create avd -n offlineid -k "system-images;android-34;google_apis;x86_64"
& "$env:ANDROID_HOME\emulator\emulator.exe" -avd offlineid
```

> Note: NNAPI behaves differently on emulators. Test recognition latency on a real
> mid-range device (Snapdragon 7-series) for representative numbers.

---

## 5. Build & Run (iOS — macOS only)

```bash
cd ios && pod install && cd ..
npx react-native run-ios --simulator "iPhone 14"
```

> The Swift module (`src/native/ios/FaceEngineModule.swift`) is written but **unverified**
> — it was authored on Windows where no iOS toolchain exists. SCRFD post-processing on iOS
> currently defers to the TS layer; reconcile with the Kotlin native decode before an iOS demo.

---

## 6. Using the App

Three tabs (bottom bar): **Authenticate · Enroll · Sync**.

### 6.1 Enroll a person
1. Open **Enroll**, enter Employee ID / Name / Department.
2. Camera captures **3 angles** (frontal, slight left, slight right) — wait for the green box.
3. Embeddings are averaged + L2-normalised, AES-256-GCM encrypted, stored in SQLite.

### 6.2 Authenticate (attendance)
1. Open **Authenticate**. Hold face still inside the frame.
2. Pipeline: SCRFD detect → FASNet passive liveness → random gesture (blink/turn/smile) → MobileFaceNet embed → cosine match.
3. Result: **match > 0.65** → success + attendance row (`synced=0`); 0.45–0.65 → retry; < 0.45 or spoof → reject + logged failed attempt. 5 fails → 30 s lockout.

### 6.3 Sync
- Auto-fires when connectivity returns (NetInfo), or tap **Sync now**.
- Flow: pull ≤10 pending → request presigned URLs → PUT each to S3 → confirm → **delete locally** (purge).
- The header badge shows the unsynced count.

> Set your sync backend base URL in `src/services/SyncService.ts` (`SYNC_BASE_URL`).

---

## 7. Integrating into Datalake 3.0

The module is a self-contained plugin. Required host-app changes (zero changes to
Datalake's API/auth/user-directory):

1. Copy `src/`, `android/app/src/main/java/com/offlineid/FaceEngine*.kt`, and
   `src/native/ios/FaceEngine*` into the host project.
2. **Android:** register the package in `MainApplication.kt`:
   ```kotlin
   add(FaceEnginePackage())
   ```
   and in `android/app/build.gradle`:
   ```gradle
   implementation("com.microsoft.onnxruntime:onnxruntime-android:1.18.0")
   androidResources { noCompress += ["onnx"] }   // minSdk 26
   ```
3. **iOS:** add `pod 'onnxruntime-mobile-c'` to the Podfile; add the 4 `.onnx` to the bundle.
4. Import `AuthScreen` / `EnrollScreen` / `SyncStatusScreen` into Datalake's navigation.
5. Add `<SyncBadge />` to the Datalake header.
6. Call `FaceEngine.initModels()` in the app root `useEffect` (see `App.tsx`).

---

## 8. Tests & Verification

```bash
npm test            # Jest unit tests (utils, crypto, stores) — 16 tests
npx tsc --noEmit    # TypeScript typecheck — must be clean
```

| Check | Status |
|---|---|
| `tsc --noEmit` | ✅ clean |
| `npm test` | ✅ 16/16 |
| `gradlew assembleDebug` | ✅ APK produced |
| Models exported | see §3 |
| On-device run | requires device/emulator + bundled models |

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `AI engine unavailable` on launch | 4 ONNX files not in `assets/` | Do §3.4 |
| Gradle: `requires AGP 8.6 / compileSdk 35` | CameraX 1.5 (vision-camera 4.5) | already set; ensure SDK 35 installed |
| Gradle: `invalid source release: 17` / toolchain | `JAVA_HOME` not JDK 17 | export JDK 17 (§1.2) |
| `onnxruntime-android:latest.integration` resolve fail | stale `onnxruntime-react-native` dep | removed; we use the AAR directly |
| `@react-native-ml-kit/face-detection@^0.1.0` ETARGET | spec version wrong | use `^2.0.1` (already in package.json) |
| Liveness always fails | FASNet expects **BGR** channel order | see MODEL_PIPELINE §3.4 |
| Recognition ~60% accuracy | missing ArcFace 5-point alignment | align before MobileFaceNet (native, implemented) |

---

## 10. Mapping to Hackathon 7.0 Deliverables

| Deliverable | Where |
|---|---|
| Working prototype + source (Android+iOS RN) | this repo; `app-debug.apk` |
| Offline liveness (blink/smile/turn + anti-spoof) | `LivenessService.ts` + FASNet + ML Kit gestures |
| Sync & purge to AWS | `SyncService.ts` + `useNetworkSync.ts` |
| Lightweight model ≤ 20 MB | 4 ONNX ≈ 4.4 MB; see `BENCHMARKS.md` |
| < 1 s recognition | pipeline budget ≈ 105 ms; see `BENCHMARKS.md` |
| Technical documentation | `SPEC.md`, `ARCHITECTURE.md`, `MODEL_PIPELINE.md`, this guide |
| Performance benchmarks | `BENCHMARKS.md` (generated by `validate_models.py`) |
| Presentation (pptx/pdf) | **TODO** — build from these docs (≤ 20 slides) |
