<div align="center">

# OFFLINE·ID

### Secure offline facial recognition & liveness detection for field personnel in zero-network zones

**NHAI Hackathon 7.0 · Datalake 3.0 integration module**

`React Native` · `ONNX Runtime` · `100% on-device` · `Android + iOS`

</div>

---

OfflineID authenticates field personnel with **face recognition + liveness detection
entirely offline**, no internet, no cloud API. Four lightweight ONNX models run on-device
(detect → liveness → recognise) in well under a second, attendance is logged to an encrypted
local database, and records **sync-and-purge** to AWS S3 automatically when connectivity
returns.

Built to drop into the existing **Datalake 3.0** React Native app as a self-contained module.

---

## Highlights

- **Fully offline**: recognition + liveness run on-device; zero network dependency for auth.
- **Two-layer liveness**: passive FASNet anti-spoof **plus** a randomised active gesture
  challenge (blink · smile · turn) to defeat photos and screen replays.
- **Tiny footprint**: 9.1 MB total model bundle (cap: 20 MB); CPU-only, no GPU.
- **Fast**: ~51 ms host-CPU pipeline; sub-second on mid-range ARM.
- **Secure**: AES-256-GCM-encrypted faceprints; raw images never stored; presigned-URL sync
  (no AWS credentials on device).
- **Cross-platform**: RN + TypeScript UI; native ONNX engine in Kotlin (Android) and Swift (iOS).
- **Open-source only**: MIT/Apache stack, no paid licences.

---

## Pipeline

```
 Camera still
     │
     ▼
 SCRFD-500M ──────────►  face box + 5 landmarks
     │
     ▼
 FASNet ×2 (2.7 / 4.0) ►  passive liveness  (anti-spoof)
     │
     ▼
 ML Kit gesture ───────►  active liveness  (blink / smile / turn)
     │
     ▼
 ArcFace align → MobileFaceNet INT8 ►  512-d faceprint
     │
     ▼
 cosine match vs enrolled  ►  attendance row (encrypted, local)
     │
     ▼
 reconnect → presigned S3 PUT → local purge
```

---

## Tech stack

| Layer | Technology | Size |
|---|---|---|
| Face detection | SCRFD-500M (ONNX) | 2.41 MB |
| Passive liveness | MiniFASNet V2 + V1SE (ONNX) | 1.66 MB × 2 |
| Face recognition | MobileFaceNet + ArcFace, INT8 (ONNX) | 3.35 MB |
| Inference runtime | ONNX Runtime Mobile (CPU / XNNPACK / NNAPI / CoreML) | ~3.5 MB |
| Active gesture | ML Kit Face Detection (VisionCamera worklet) | - |
| Local storage | SQLite + AES-256-GCM (`@noble/ciphers`) | - |
| Cloud sync | AWS S3 via presigned URL + NetInfo | - |
| Framework | React Native 0.75 + TypeScript (strict) | - |
| **Total model bundle** | | **9.1 MB** |

---

## Repository structure

```
.
├── App.tsx                 # 5-tab shell (Scan · Enrol · People · Sync · System)
├── index.js                # entry + get-random-values polyfill
├── src/
│   ├── screens/            # Auth, Enroll, People, Sync, Settings, About
│   ├── components/         # CameraView, LivenessPrompt, SyncBadge
│   ├── hooks/              # useFaceAuth orchestration state machine
│   ├── services/           # FaceEngine bridge, Liveness, Stores, Sync
│   ├── ui/                 # design system (theme + components)
│   └── utils/              # crypto, cosine distance, logger
├── android/                # native Kotlin FaceEngine + ONNX assets
│   └── app/src/main/java/com/offlineid/FaceEngineModule.kt
├── ios/
│   └── FaceEngine/         # native Swift FaceEngine (1:1 Kotlin port)
├── models/                 # ONNX models + export scripts source
├── scripts/                # Python model export / validation
├── submission/             # Hackathon 7.0 proposal package (zip this)
└── docs/                   # architecture, spec, benchmarks, pipeline, findings
```

---

## Dependencies

Python tooling is managed with **[uv](https://github.com/astral-sh/uv)**; JavaScript with
npm. Two scripts wrap both so you can provision or fully clean a machine.

```bash
# 1. install uv once
#    Windows:      winget install astral-sh.uv      (or: scoop install uv)
#    macOS/Linux:  curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. install everything for development (uv-managed .venv + npm packages)
uv run scripts/install_deps.py

# also install the system toolchain (JDK 17, Python 3.12, Node LTS, Android SDK)
uv run scripts/install_deps.py --with-toolchain

# uninstall: preview a complete removal, then do it
uv run scripts/uninstall_deps.py --full --dry-run
uv run scripts/uninstall_deps.py --full
```

`install_deps.py` builds the `.venv` with `uv` (Torch pinned to the CPU wheel) and runs
`npm install`. Prefer doing the Python side by hand?

```bash
uv venv
uv pip install -r scripts/requirements.txt
```

`uninstall_deps.py` removes local build dirs, user caches, the Android SDK, and the
scoop/winget toolchains. Full flag list: [scripts/README.md](scripts/README.md).

> Day to day you only need `npm install` (JS); the 4 ONNX models are already in the repo.
> No uv? The scripts fall back to `python -m venv` + `pip` (`python scripts/install_deps.py --no-uv`).

---

## Build & run

### Your own offline release APK (Android)

The **release** build embeds the JS bundle and runs with no Metro and no network. This is the
real offline app, and the artifact you ship and demo.

```bash
npm install --legacy-peer-deps
cd android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
cd ..
adb install -r android/app/build/outputs/apk/release/app-arm64-v8a-release.apk
```

Output: `app-arm64-v8a-release.apk` (~58 MB). Enable airplane mode; enrol and authenticate
work fully offline. The `arm64-v8a` flag keeps the APK small (a universal build is ~167 MB)
and avoids a flaky vision-camera CMake step on Windows paths with spaces. Full notes:
[docs/SETUP_AND_USAGE.md](docs/SETUP_AND_USAGE.md).

### Debug / hot reload

Debug builds stream JS from the Metro dev server, so they need a connected PC and are **not**
offline. Use them only for development.

```bash
npm install --legacy-peer-deps
npm start                 # Metro dev server (one terminal)
npm run android           # debug build on a connected device (another terminal)
```

### iOS (needs macOS + Xcode)

The native Swift engine lives in [ios/FaceEngine/](ios/FaceEngine/) (a 1:1 port of the Kotlin
engine, same models, same math). One-time Xcode wiring (Podfile pod, bundle resources,
bridging header) is documented in [ios/FaceEngine/README.md](ios/FaceEngine/README.md).

```bash
cd ios && pod install && cd ..
npx react-native run-ios --configuration Release
```

---

## Demo flow

1. **Enrol** → scan a face 3× → encrypted faceprint stored locally.
2. **Scan** → live camera → passive liveness + prompted gesture → **Access granted** with name + match %.
3. Photo / screen of the person → **rejected** (anti-spoof).
4. Enable airplane mode → authenticate again → still works; attendance queues in **Sync**.
5. Reconnect → queue auto-syncs to S3 and local rows are purged.

---

## Documentation

| Doc | What's inside |
|---|---|
| [`docs/SPEC.md`](docs/SPEC.md) | Full functional + technical specification |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System design, data flows, security model |
| [`docs/MODEL_PIPELINE.md`](docs/MODEL_PIPELINE.md) | AI pipeline, preprocessing, export scripts |
| [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) | Size + latency benchmarks |
| [`docs/SETUP_AND_USAGE.md`](docs/SETUP_AND_USAGE.md) | Build, run, and demo walkthrough |
| [`docs/ANDROID_PHONE_TESTING.md`](docs/ANDROID_PHONE_TESTING.md) | On-device testing notes |
| [`docs/FINDINGS.md`](docs/FINDINGS.md) | Project explainer + debugging journey |
| [`docs/PRESENTATION.md`](docs/PRESENTATION.md) | Slide deck outline |
| [`submission/`](submission/) | Hackathon proposal package + Datalake integration guide |

---

## Brief compliance

| Constraint | Status |
|---|---|
| React Native, Android + iOS | RN ✅ · Android engine ✅ (offline APK) · iOS engine written in Swift, build wiring pending |
| Model footprint ~20 MB | ✅ 9.1 MB |
| < 1 s recognise + liveness | ✅ ~51 ms host CPU |
| Android 8+ / iOS 12+, 3 GB RAM, no GPU | ✅ CPU-only ONNX Runtime |
| > 95 % accuracy | MobileFaceNet LFW 99.5% + lighting normalisation |
| Offline liveness (blink/smile/turn) | ✅ passive + active |
| Sync & purge to AWS | ✅ presigned S3 + local purge |
| Open-source only | ✅ MIT / Apache |

---

## Licence

All components are open-source (MIT / Apache 2.0), no paid licences:
InsightFace · SCRFD · MobileFaceNet (MIT) · Silent-Face / FASNet (MIT) · ONNX Runtime (MIT) ·
react-native-vision-camera (MIT) · react-native-sqlite-storage (MIT) · @noble/ciphers (MIT).
