# OfflineID — Offline Facial Recognition & Liveness Detection
### Hackathon 7.0 · Datalake 3.0 Integration Module

> **Evaluator quick-start:** Get the demo running in under 5 minutes.

---

## What it does

OfflineID authenticates field personnel using facial recognition and liveness detection
**entirely without an internet connection**. It runs three lightweight ONNX models
on-device (Android 8+ / iOS 12+), logs attendance to encrypted local SQLite, and
batch-syncs to AWS S3 automatically when connectivity is restored.

---

## Tech Stack

| Component | Technology | Size |
|---|---|---|
| Face detection | SCRFD-500M (ONNX) | ~1 MB |
| Liveness (passive) | FASNet / Silent-Face (ONNX) | ~1.2 MB |
| Face recognition | MobileFaceNet + ArcFace INT8 (ONNX) | ~1.1 MB |
| Inference runtime | ONNX Runtime Mobile (XNNPACK / CoreML) | ~3.5 MB |
| Local storage | SQLite + AES-256-GCM | — |
| Cloud sync | AWS S3 via presigned URL | — |
| Framework | React Native 0.75 + TypeScript | — |
| **Total model bundle add** | | **≤ 12 MB** |

---

## Quick Start (Evaluator)

### Android

```bash
# 1. Clone and install
git clone https://github.com/<org>/offlineid && cd offlineid
npm install

# 2. Prepare models (Python 3.10+)
cd scripts && pip install -r requirements.txt
python export_scrfd.py && python export_mobilefacenet.py && python export_fasnet.py
cd ..

# 3. Copy models to Android assets
cp models/*.onnx android/app/src/main/assets/

# 4. Build and run
npx react-native run-android
```

### iOS (requires macOS + Xcode 15)

```bash
cd ios && pod install && cd ..
cp models/*.onnx ios/OfflineID/
npx react-native run-ios --simulator "iPhone 14"
```

---

## Demo Flow

1. Open app → tap **Enroll** → scan face 3× → save
2. Tap **Authenticate** → live camera → blink when prompted → authenticated ✓
3. Turn on Airplane Mode → repeat auth → still works ✓
4. Turn Airplane Mode off → watch **Sync** badge clear automatically ✓

---

## Performance Numbers

| Metric | Result |
|---|---|
| End-to-end latency | < 200 ms |
| LFW accuracy (MobileFaceNet INT8) | 99.53 % |
| App size delta | ≤ 12 MB |
| Offline capability | 100 % |

See `BENCHMARKS.md` for device-specific numbers.

---

## Document Index

| File | Purpose |
|---|---|
| `SPEC.md` | Full technical specification (start here for Claude Code) |
| `ARCHITECTURE.md` | System architecture, data flows, security model |
| `MODEL_PIPELINE.md` | AI model pipeline, preprocessing, export scripts |
| `BENCHMARKS.md` | Auto-generated performance benchmark results |
| `README.md` | This file — evaluator quick-start |

---

## Licences

All components are open-source (MIT / Apache 2.0). No paid licences required.

- InsightFace / SCRFD / MobileFaceNet — MIT
- Silent-Face-Anti-Spoofing (FASNet) — MIT  
- ONNX Runtime — MIT
- react-native-vision-camera — MIT
- react-native-sqlite-storage — MIT
