# OfflineID - Setup, Build & Usage Guide

> Offline facial recognition + liveness detection module for React Native, built for
> **Hackathon 7.0**. Plugs into the Datalake 3.0 app. Zero network dependency for
> enrolment/auth; AWS S3 sync-and-purge on reconnect.
>
> Read with `SPEC.md`, `ARCHITECTURE.md`, `MODEL_PIPELINE.md`, `BENCHMARKS.md`.
> For hot reload, on-device logs, and diagnosing "Not recognised", see
> [`HOT_RELOAD_AND_DEBUGGING.md`](HOT_RELOAD_AND_DEBUGGING.md).

---

## 0. What this is

| | |
|---|---|
| Platform | React Native 0.75.4 (CLI) |
| Languages | TypeScript + Kotlin (Android) + Swift (iOS) |
| AI runtime | ONNX Runtime Mobile (CPU / XNNPACK / NNAPI / CoreML) |
| Models | SCRFD-500M (detect) · MobileFaceNet-INT8 (recognise) · MiniFASNet V2 + V1SE (liveness) |
| Offline | Enrolment, authentication, liveness, attendance logging, all on-device |
| Online | Batch sync of attendance logs to S3 via presigned URL, then local purge |

The 4 ONNX models (9.1 MB total) are committed in `android/app/src/main/assets/`, so the
Android app builds and runs straight after clone. Section 3 (model export) is only needed to
regenerate or update them.

---

## 1. Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | ≥ 18 | RN CLI + Metro bundler |
| JDK | **17** (Temurin) | Android Gradle Plugin 8.6 requires JDK 17 (not 21/25) |
| Android SDK | platform-tools, **platforms;android-35**, **build-tools;35.0.0**, **ndk;26.1.10909125** | RN 0.75 + CameraX build |
| Python | 3.12 | Model export only (optional) |
| Xcode | 15+ (macOS only) | iOS build, cannot build on Windows |

### 1.1 Toolchain (Windows example, via scoop)

```powershell
scoop bucket add java
scoop install temurin17-jdk python312 android-clt

$env:ANDROID_HOME = "$HOME\scoop\apps\android-clt\current"
$sdk = "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat"
& $sdk --licenses                     # answer y to all
& $sdk "platform-tools" "platforms;android-35" "build-tools;35.0.0" "ndk;26.1.10909125"
```

### 1.2 Environment variables (every build shell)

```powershell
$env:JAVA_HOME    = "$HOME\scoop\apps\temurin17-jdk\current"   # MUST be JDK 17
$env:ANDROID_HOME = "$HOME\scoop\apps\android-clt\current"
$env:PATH         = "$env:JAVA_HOME\bin;$env:PATH"
```

`android/local.properties` points `sdk.dir` at the SDK; adjust if your path differs.

---

## 2. Install JS dependencies

```bash
npm install --legacy-peer-deps
```

`--legacy-peer-deps` is required: vision-camera / worklets-core / netinfo declare
overlapping RN peer ranges.

---

## 3. (Optional) Regenerate the AI models

The 4 final ONNX files are already in `android/app/src/main/assets/`. Run this section only
to rebuild them from source. The large source models (`buffalo_sc.zip`, FP32 weights) are
gitignored.

### 3.1 Python env (uv)

Python deps are managed with [uv](https://github.com/astral-sh/uv)
(`winget install astral-sh.uv`, or `scoop install uv`).

```powershell
uv venv
uv pip install torch==2.3.0 --index-url https://download.pytorch.org/whl/cpu
uv pip install -r scripts\requirements.txt
```

Or let the script do it: `uv run scripts/install_deps.py` (falls back to venv + pip with
`--no-uv`).

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

### 3.3 Export, quantise, validate

```powershell
cd scripts
..\.venv\Scripts\python.exe export_scrfd.py          # -> models/scrfd_500m_fixed.onnx
..\.venv\Scripts\python.exe export_mobilefacenet.py  # -> models/mobilefacenet_int8.onnx (INT8)
..\.venv\Scripts\python.exe export_fasnet.py         # -> models/fasnet_2_7.onnx + fasnet_4_0.onnx
..\.venv\Scripts\python.exe validate_models.py       # -> ../docs/BENCHMARKS.md
cd ..
```

### 3.4 Bundle into the app

```powershell
Copy-Item models\scrfd_500m_fixed.onnx,models\mobilefacenet_int8.onnx,models\fasnet_2_7.onnx,models\fasnet_4_0.onnx android\app\src\main\assets\
# iOS: add the same 4 files to the OfflineID target's Copy Bundle Resources in Xcode
```

> If the 4 files are missing from `assets/`, the app still launches but `initModels()`
> rejects and the UI reports the AI engine as unavailable.

---

## 4. Build & run (Android)

### 4.1 Development (hot reload)

```powershell
# env vars from 1.2 must be set in this shell
npm start                              # Metro dev server (separate terminal)
npx react-native run-android           # debug build on a connected device
```

Debug builds stream JS from Metro, so they need a running dev server and are **not** offline.

> Full hot-reload workflow (Fast Refresh, `adb reverse`, dev menu) and a debugging
> playbook are in [`HOT_RELOAD_AND_DEBUGGING.md`](HOT_RELOAD_AND_DEBUGGING.md).

### 4.2 Standalone offline release APK (what you ship)

The release build embeds the JS bundle and runs with no Metro and no network.

```powershell
cd android
.\gradlew.bat assembleRelease -PreactNativeArchitectures=arm64-v8a
cd ..
adb install -r android\app\build\outputs\apk\release\app-release.apk
```

Output: `app-release.apk` (~62 MB). The `arm64-v8a` ABI filter keeps the APK small;
a universal build bundles four ABIs of ONNX Runtime + ML Kit and balloons to ~167 MB. arm64
covers effectively every field device since 2017. For an x86_64 emulator pass
`-PreactNativeArchitectures=x86_64`.

### 4.3 Emulator (optional)

```powershell
& $sdk "system-images;android-34;google_apis;x86_64"
$avd = "$env:ANDROID_HOME\cmdline-tools\latest\bin\avdmanager.bat"
& $avd create avd -n offlineid -k "system-images;android-34;google_apis;x86_64"
& "$env:ANDROID_HOME\emulator\emulator.exe" -avd offlineid
```

> Measure recognition latency on a real mid-range device (Snapdragon 7-series) for
> representative numbers; emulator CPU figures are not comparable.

---

## 5. Build & run (iOS, macOS only)

The native engine is implemented in Swift under `ios/FaceEngine/` (`FaceEngine.swift`,
`RGBAImage.swift`, `FaceEngine.m`), a 1:1 port of the Kotlin engine with the same models,
channel order, and ArcFace alignment, plus the `ScreenBrightness` module (`ScreenBrightness.swift`
/ `.m`). The Xcode wiring (Podfile pod, compile sources, bundle resources, bridging header,
camera permission) is **already applied** to `OfflineID.xcodeproj`; only `pod install` and the
Mac build below remain. Details in `ios/FaceEngine/README.md`.

```bash
cd ios && pod install && cd ..
npx react-native run-ios --configuration Release
```

> The Swift engine has not been compiled yet (no macOS/Xcode in the build environment), so
> Android is the build-and-run-verified prototype for this submission.

---

## 6. Using the app

Five tabs (bottom bar): **Scan · Enrol · People · Sync · System**.

### 6.1 Enrol a person
1. Open **Enrol**, enter Employee ID / Name / Department.
2. The camera captures **3 angles** (frontal, slight left, slight right); wait for the lock.
3. Embeddings are averaged + L2-normalised, AES-256-GCM encrypted, stored in SQLite.

### 6.2 Authenticate (Scan)
1. Open **Scan**. Hold the face still inside the reticle.
2. Pipeline: SCRFD detect → FASNet passive liveness → random gesture (blink/turn/smile) → MobileFaceNet embed → cosine match.
3. Result: **match > 0.65** → access granted + attendance row (`synced=0`); 0.45–0.65 → retry; < 0.45 or spoof → reject + logged failure. 5 fails → 30 s lockout.

### 6.3 People
- Browse enrolled persons, see the count, delete an enrolment.

### 6.4 Sync
- Auto-fires when connectivity returns (NetInfo), or tap **Sync now**.
- Flow: pull ≤ 10 pending → request presigned URLs → PUT each to S3 → confirm → **delete locally** (purge).
- The header badge shows the unsynced count.

### 6.5 System / Settings
- **Display** subview: fill-light brightness, ambient lux threshold lowered to 15 activation / 35 deactivation), screen wake-lock, camera zoom level.
- **Technical** subview: model + matching thresholds, haptic feedback toggle, auto-restart on result.
- **Help** subview: gesture explainers (blink / smile / turn), tips for best results, data privacy info.
- Device info, factory reset, and the in-app About screen are also accessible from System.

> Set your sync backend base URL in `src/config.ts` (`SYNC_BASE_URL`).

---

## 7. Integrating into Datalake 3.0

See `submission/02-DATALAKE-3.0-INTEGRATION.md` for the full guide. In short (zero changes to
Datalake's API / auth / user directory):

1. Copy `src/`, `android/app/src/main/java/com/offlineid/FaceEngine*.kt`, and `ios/FaceEngine/`
   into the host project.
2. **Android:** register the package in `MainApplication.kt` (`add(FaceEnginePackage())`) and
   in `android/app/build.gradle`:
   ```gradle
   implementation("com.microsoft.onnxruntime:onnxruntime-android:1.18.0")
   androidResources { noCompress += ["onnx"] }   // minSdk 26
   ```
3. **iOS:** add `pod 'onnxruntime-objc'` to the Podfile; add the 4 `.onnx` to the bundle.
4. Import `AuthScreen` / `EnrollScreen` / `SyncStatusScreen` into Datalake's navigation.
5. Add `<SyncBadge />` to the Datalake header.
6. Call `FaceEngine.initModels()` in the app root `useEffect` (see `App.tsx`).

---

## 8. Tests & verification

```bash
npm test            # Jest unit tests (utils, crypto, stores)
npx tsc --noEmit    # TypeScript typecheck, must be clean
```

| Check | Status |
|---|---|
| `tsc --noEmit` | clean |
| `npm test` | 15/15 |
| `gradlew assembleRelease` | arm64-v8a APK produced (~62 MB) |
| Models bundled | 4 ONNX in `android/app/src/main/assets/` (9.1 MB) |
| On-device run | enroll + authenticate verified offline on Android hardware |

---

## 9. Troubleshooting

> Deeper failure diagnosis (read `adb logcat`, decode "Not recognised", tune thresholds,
> emulator ABI traps): [`HOT_RELOAD_AND_DEBUGGING.md`](HOT_RELOAD_AND_DEBUGGING.md).

| Symptom | Cause | Fix |
|---|---|---|
| AI engine unavailable on launch | 4 ONNX files not in `assets/` | redo 3.4 |
| Gradle: requires AGP 8.6 / compileSdk 35 | CameraX (vision-camera 4.x) | ensure SDK 35 installed |
| Gradle: invalid source release: 17 | `JAVA_HOME` not JDK 17 | export JDK 17 (1.2) |
| `ninja: build.ninja still dirty` on release | vision-camera v7a CMake on a path with spaces | build with `-PreactNativeArchitectures=arm64-v8a` |
| Red Metro screen on the release APK | installed the debug APK | install `OfflineID-v1.4.0-arm64-v8a.apk` |
| Liveness always fails | FASNet expects **BGR** channel order | see MODEL_PIPELINE 3.4 |
| Recognition accuracy low | missing ArcFace 5-point alignment | align before MobileFaceNet (native, implemented) |

---

## 10. Mapping to Hackathon 7.0 deliverables

| Deliverable | Where |
|---|---|
| Working prototype + source (Android + iOS RN) | this repo; release APK on the GitHub Release |
| Offline liveness (blink/smile/turn + anti-spoof) | `LivenessService.ts` + FASNet + ML Kit gestures |
| Sync & purge to AWS | `SyncService.ts` |
| Lightweight model ≤ 20 MB | 4 ONNX = 9.1 MB; see `BENCHMARKS.md` |
| < 1 s recognition | host-CPU pipeline ≈ 51 ms; see `BENCHMARKS.md` |
| Technical documentation | `SPEC.md`, `ARCHITECTURE.md`, `MODEL_PIPELINE.md`, this guide |
| Performance benchmarks | `BENCHMARKS.md` (generated by `validate_models.py`) |
| Presentation (pptx) | `submission/OfflineID_Hackathon7.pptx` |
