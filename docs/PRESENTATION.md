# OfflineID - Presentation Deck Outline
## Hackathon 7.0 · Datalake 3.0 Integration · ≤ 20 slides

> Speaker-ready outline. Each slide = title + bullets + visual cue. Export to PPTX/PDF.
> Keep ≤ 3 min for the demo video; slides support the live walkthrough.

---

### Slide 1 - Title
- **OfflineID**: Offline Facial Recognition & Liveness Detection for Field Personnel
- Team / names · Hackathon 7.0 · Datalake 3.0 module
- Visual: app logo + tagline "Authenticate anyone, anywhere, zero network."

### Slide 2 - The Problem
- Field personnel in zero-network zones must be authenticated securely.
- Cloud face-APIs fail offline; photos/screens enable attendance fraud.
- Must run on mid-range phones (3GB RAM, Android 8+/iOS 12+), < 1s, > 95% accuracy.
- Visual: remote site, no-signal icon.

### Slide 3 - Our Solution (one line)
- A **fully on-device** RN module: detect → liveness → recognise in ~50–100 ms, then **sync-and-purge** to AWS when back online.
- Visual: phone with green "✓ Authenticated" + offline badge.

### Slide 4 - Why It's Innovative
- Edge AI: **INT8-quantised** MobileFaceNet, **9.1 MB** total model bundle.
- **Two-layer liveness**: passive anti-spoof (FASNet) + active gesture (blink/turn/smile).
- Zero cloud dependency for auth; presigned-URL sync with local purge.
- Visual: 30-mark "Innovation" criterion callout.

### Slide 5 - System Architecture
- Diagram from `ARCHITECTURE.md §1`: Screens → `useFaceAuth` → FaceEngine (native ONNX) / LivenessService / Stores / SyncService.
- Visual: the boxed architecture diagram.

### Slide 6 - The AI Pipeline
- Frame → SCRFD detect (+5 landmarks) → FASNet ×2 liveness → ML Kit gesture → ArcFace align → MobileFaceNet embed → cosine match.
- Visual: the vertical pipeline from `SPEC.md §5`.

### Slide 7 - Model Stack
- SCRFD-500M (detect, 2.4MB) · MobileFaceNet INT8 (recognise, 3.35MB) · MiniFASNet V2+V1SE (liveness, 1.66MB×2).
- All MIT-licensed, open-source. ONNX Runtime Mobile (NNAPI / XNNPACK / CoreML).
- Visual: 3-model row with sizes.

### Slide 8 - Liveness / Anti-Spoof
- Passive: FASNet two-scale crops, softmax P(real) > 0.6 → blocks photos/screens/2D masks.
- Active: random gesture in 5s window via on-device ML Kit (blink EAR, yaw ±20°, smile).
- Gate: both must pass before recognition.
- Visual: spoof-rejected vs live-accepted.

### Slide 9 - Recognition & Matching
- ArcFace 5-point alignment (manual, no OpenCV) → 512-d L2-normalised embedding.
- Cosine similarity vs enrolled set; > 0.65 match, 0.45–0.65 retry, < 0.45 reject.
- Visual: embedding-space dots + threshold ring.

### Slide 10 - Offline-First Data
- SQLite on-device: `face_embeddings` (permanent, AES-256-GCM encrypted) + `attendance_log` (ephemeral).
- Works fully offline: enroll, auth, log.
- Visual: offline capability matrix (`ARCHITECTURE.md §6`).

### Slide 11 - Sync & Purge
- NetInfo reconnect → batch ≤10 → presigned S3 PUT → confirm → **local DELETE** (purge).
- Exponential backoff; 403-refresh; no AWS creds on device.
- Visual: the sync sequence diagram (`ARCHITECTURE.md §3.3`).

### Slide 12 - Security
- Embeddings AES-256-GCM at rest; key in Keystore/Secure Enclave.
- No raw images stored; only ≤20KB audit thumbnails, purged on sync.
- Presigned URLs (15-min TTL); rate-limit 30s lockout after 5 fails.
- Visual: 4-layer security stack (`ARCHITECTURE.md §4`).

### Slide 13 - Indian Demographics & Lighting
- Inference-time histogram equalisation + auto-gamma for harsh sun / low light / shadows.
- Fine-tune path on South-Asian face subset (roadmap).
- Visual: before/after lighting correction.

### Slide 14 - Performance (Benchmarks)
- Bundle **9.09 MB** (cap 20). Host-CPU pipeline **~51 ms**.
- Targets: < 1s ✅, > 95% accuracy (MobileFaceNet LFW 99.5%).
- Visual: `BENCHMARKS.md` table + budget bars.

### Slide 15 - Cross-Platform & Integration
- React Native 0.75; native Kotlin engine (Android) + documented Swift port (iOS, same contract).
- Drops into Datalake 3.0: register package, import screens, add SyncBadge, call `initModels()`. Zero backend changes.
- Visual: "plugin" puzzle-piece into Datalake.

### Slide 16 - Live Demo
- Enroll → Authenticate (live) → spoof rejected → go offline, log → reconnect, sync.
- Visual: embedded demo video / screen recording.

### Slide 17 - Tech & Quality
- Open-source only, no paid licences. TypeScript strict, 15 unit tests, typecheck clean.
- Standalone **offline release APK** built end-to-end (JS bundle embedded, runs airplane-mode).
- Visual: green CI checkmarks.

### Slide 18 - Scalability & Sustainability
- N=500 users cosine match < 5 ms; SQLite queue → batch S3 → purge keeps device lean.
- Model updates swap ONNX files (8MB headroom under cap).
- Visual: scale curve.

### Slide 19 - Roadmap
- On-device fine-tune on Indian dataset; iOS device build; per-frame GPU delegate; FAR/FRR field tuning.
- Visual: timeline.

### Slide 20 - Closing
- OfflineID = secure, lightweight, fully offline face auth that plugs into Datalake 3.0.
- Repo + docs links. Thank you / Q&A.

---

## Mapping to Evaluation Criteria
| Criterion (marks) | Slides |
|---|---|
| Innovation (30) | 4, 7, 8 |
| Feasibility (30) | 6, 14, 15, 17 |
| Scalability & Sustainability (20) | 10, 11, 18, 19 |
| Presentation & Docs (20) | whole deck + `SETUP_AND_USAGE.md`, `BENCHMARKS.md` |
