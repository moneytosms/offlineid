# OfflineID - Proposal

**Hackathon 7.0 · Develop a mobile based secure offline facial recognition and liveness
detection system for remote locations · Datalake 3.0 integration module**

---

## The problem

NHAI field personnel work in remote, **zero-network** highway zones. They must be
authenticated securely for attendance, but:
- Cloud face-recognition APIs are useless without connectivity.
- Photos and phone-screen replays enable attendance fraud.
- The solution must run on **standard mid-range phones** (3 GB RAM, Android 8+/iOS 12+),
  **without a high-end GPU**, in **under 1 second**, at **> 95 % accuracy**, across diverse
  Indian demographics and harsh outdoor lighting, and **plug into the existing Datalake 3.0
  React Native app**.

## Our solution - OfflineID

A **fully on-device** React Native module that authenticates a person in ~50–100 ms with no
internet, then **syncs-and-purges** attendance to AWS once connectivity returns.

```
Camera still → SCRFD detect (+5 landmarks)
            → FASNet ×2 passive liveness (anti-spoof)
            → ML Kit active gesture (blink / smile / turn)
            → ArcFace align → MobileFaceNet 512-d embedding
            → cosine match vs encrypted local enrolments
            → attendance row queued → auto-sync to S3 + local purge on reconnect
```

All four AI models are **open-source ONNX**, run on **ONNX Runtime Mobile** (CPU /
XNNPACK / NNAPI, no GPU required), and total **9.1 MB**, well under the 20 MB budget.

## Why it wins on the evaluation criteria

**Innovation (30).** Edge AI: INT8-quantised MobileFaceNet, 9.1 MB total bundle.
Two-layer liveness, passive FASNet anti-spoof **plus** a randomised active gesture
sequence, defeats printed photos and screen replays. Zero cloud dependency for auth.

**Feasibility (30).** Drops into Datalake 3.0 as one native package + JS screens + an
asset folder (see `02-DATALAKE-3.0-INTEGRATION.md`); no backend change for the offline
path. ~51 ms host-CPU pipeline → sub-second on mid-range ARM.

**Scalability & Sustainability (20).** Offline-first SQLite queue → batch presigned-S3
sync → local purge keeps devices lean. 500-user match < 5 ms. Models update by swapping
ONNX files (8 MB headroom). Inference-time lighting normalisation for sun/low-light/shadow.

**Presentation & Documentation (20).** Open-source only, TypeScript strict, unit-tested,
typecheck-clean. Full architecture, model pipeline, benchmarks, and an exact Datalake
integration guide ship in this package.

## Security

AES-256-GCM-encrypted faceprints at rest (key in Android Keystore); **raw face images are
never persisted**. Presigned-URL sync means **no AWS credentials on device**. 30-second
lockout after repeated failures.

## Current status

- **Android**: complete working prototype, standalone **offline release APK** (arm64-v8a,
  ~58 MB), full pipeline verified on real hardware.
- **iOS**: shares the entire RN/JS + UI layer; the native ONNX engine is now **written in
  Swift** (`ios/FaceEngine/`, `FaceEngine.swift`, `RGBAImage.swift`, `FaceEngine.m`),
  a 1:1 port of the Kotlin engine with identical models, channel order, and ArcFace math.
  Remaining work is the Xcode build wiring (Podfile + bundle resources + bridging header,
  documented in `ios/FaceEngine/README.md`), which needs a Mac. Android is the
  build-and-run-verified prototype for this submission.
- **Accuracy/demographics**: backbone (MobileFaceNet, LFW 99.5%) + lighting normalisation
  today; on-device fine-tune on an Indian face subset is the field-hardening roadmap.

## Demo video

➡️ **[ADD YOUR DEMO VIDEO LINK HERE]**, ≤ 3 min: enroll → live auth → spoof rejected →
offline attendance log → reconnect + sync.

## Deliverable artifacts

- **Offline release APK:** `OfflineID-release.apk` (arm64-v8a, standalone, runs airplane-mode).
  Built via `android/ && ./gradlew assembleRelease`. **Too large for the 25 MB proposal zip**,
  so ship it through the form's **"Link for the proposal"** slot (attach to a GitHub Release
  or Drive). See `03-BUILD-OFFLINE-APK.md`.
- **iOS native engine source:** `ios/FaceEngine/` (Swift port; build wiring in its README).

## Links

- **Source code (open-source):** https://github.com/moneytosms/offlineid
- **Offline release APK (v1.0.0):** https://github.com/moneytosms/offlineid/releases/tag/v1.0.0
- **Demo video:** ➡️ [ADD YOUR DEMO VIDEO LINK]
