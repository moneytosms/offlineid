# FINDINGS - OfflineID, explained from zero

A complete walkthrough of this project for someone who has never seen it: what
it is, how it is built, every major technology and *why* it was chosen, and the
real engineering decisions (and bugs) that shaped it. Read top to bottom to
learn the project.

---

## 1. The problem this solves

This is a submission for "Hackathon 7.0". The brief (see `hackathon_doc7.pdf`):

> Build a **mobile, fully offline** face-recognition + liveness-detection system
> for field personnel in zero-network areas, to plug into an existing React
> Native app ("Datalake 3.0").

Hard requirements from the brief:

| Constraint | Target |
|---|---|
| Framework | React Native, Android **and** iOS |
| Model size | ~20 MB total (smaller is better) |
| Speed | recognise + liveness in **< 1 second** on mid-range phones |
| Hardware | Android 8+/iOS 12+, 3 GB RAM, **no GPU** |
| Accuracy | > 95%, robust to Indian demographics + outdoor light |
| Licensing | open-source only |
| Offline | works with **no internet**; sync to AWS later, then purge local data |
| Anti-spoof | basic offline liveness (blink/smile/turn) to beat photos/screens |

The word that drives every decision is **offline**. The phone must run the AI
itself, no server round-trip. That single constraint explains the whole
architecture below.

---

## 2. What the app actually does (user's view)

Three screens (tabs):

1. **Enroll**, register a person. Operator types ID + name, then the camera
   takes **3 photos** (front / slight-left / slight-right). Each photo is turned
   into a 512-number "faceprint" (an *embedding*). The 3 are averaged into one
   and saved, encrypted, on the phone.
2. **Authenticate**, verify a person. Camera watches for a steady face, takes a
   photo, checks it is a *live* human (not a photo/screen), asks for a couple of
   random gestures, then compares the faceprint to everyone enrolled. Match →
   "Welcome <name>" and an attendance row is written.
3. **Sync**, when internet returns, queued attendance rows upload to AWS, then
   delete locally. Fully offline until then.

---

## 3. Big-picture architecture

```
┌──────────────────────────────────────────────────────────────┐
│  React Native (TypeScript) , UI + orchestration              │
│                                                                │
│  Screens: Enroll / Auth / Sync                                 │
│  Hooks:   useFaceAuth (state machine), useNetworkSync          │
│  Services:FaceEngine (JS facade), LivenessService, Embedding-  │
│           Store, AttendanceStore, SyncService                  │
│  Data:    SQLite (records) + EncryptedStorage (AES key)        │
└───────────────┬───────────────────────────┬──────────────────┘
                │ React Native bridge        │ camera frames
                ▼                            ▼
┌───────────────────────────┐   ┌──────────────────────────────┐
│ Native module FaceEngine  │   │ VisionCamera + ML Kit face    │
│ (Kotlin, Android)         │   │ detector (worklet on GPU/CPU) │
│  runs 4 ONNX models via   │   │  → face boxes + eye/smile/yaw │
│  ONNX Runtime             │   └──────────────────────────────┘
└───────────────────────────┘
```

Two separate "vision" paths, on purpose:

- **Cheap, continuous:** the ML Kit face detector runs on every 5th camera frame
  inside a *worklet* (a tiny function that runs off the JS thread). It only
  produces face boxes + expression hints. No heavy AI, no lag.
- **Heavy, on-demand:** only when a face is steady do we take a single still
  photo and feed it to the 4 ONNX models. The expensive work runs **once per
  attempt**, not 30×/second, that is how we hit "< 1 second" on a mid-range CPU.

---

## 4. The AI pipeline (the heart of it)

Four open-source ONNX models, bundled in the APK (`android/app/src/main/assets/`).
ONNX is a portable model format; **ONNX Runtime** executes it on-device with no
GPU. Total size ≈ **9.3 MB**, well under the 20 MB budget.

| Step | Model | Size | Job |
|---|---|---|---|
| 1. Detect | SCRFD-500M | 2.5 MB | find the face box + 5 landmarks |
| 2. Align | (math, no model) | - | rotate/scale face to a canonical pose |
| 3. Recognise | MobileFaceNet (INT8) | 3.4 MB | face → 512-number embedding |
| 4. Liveness | FASNet 2.7 + 4.0 | 1.7 MB ×2 | real face vs photo/screen |

### Step 1 - Detection (SCRFD)
Takes the 640×640 image, outputs candidate face boxes at 3 scales, keeps the
most confident one after NMS (non-max suppression, removes overlapping boxes).
Also returns 5 keypoints (eyes, nose, mouth corners) used next.

### Step 2 - Alignment (ArcFace similarity transform)
Faces in photos are tilted/rotated. Recognition only works if every face is in
the same canonical position. We compute a 2×3 affine matrix that maps the 5
detected keypoints onto fixed reference positions, then warp the crop to
112×112. **Done by hand in Kotlin** (least-squares solve via Gaussian
elimination) to avoid an OpenCV dependency, OpenCV would add ~30 MB.

### Step 3 - Recognition (MobileFaceNet)
The aligned 112×112 face becomes a **512-dimensional vector** (the "embedding").
Key idea: the *same* person's photos produce vectors that point in nearly the
same direction; different people point elsewhere. We compare with **cosine
similarity** (dot product of unit vectors). Above 0.65 → match.
- Enrollment stores the average of 3 embeddings (more robust).
- The vector is **L2-normalised** so cosine similarity is just a dot product.

### Step 4 - Liveness (FASNet / Silent-Face anti-spoofing)
Crops the face at two zoom levels (2.7× and 4.0×), each fed to a small CNN that
outputs 3 class scores. We softmax and read the "real" probability, average the
two scales, threshold at 0.6. Catches static photos well; see §9 for the honest
limits against video.

---

## 5. Technology choices, and why

| Tech | Why it's here | Alternative rejected |
|---|---|---|
| **React Native 0.75** | brief mandates RN, cross-platform | native-only (fails brief) |
| **ONNX Runtime (android)** | runs models on CPU, no GPU, small | TF Lite (heavier toolchain), full PyTorch (huge) |
| **SCRFD / MobileFaceNet / FASNet** | SOTA-ish, tiny, open-source, fit 20 MB | RetinaFace+ArcFace full (too big), MediaPipe (Apache but heavier) |
| **react-native-vision-camera v4** | modern camera with frame processors | RN built-in camera (no frame access) |
| **vision-camera-face-detector** | ML Kit face boxes inside a worklet | rolling our own detector worklet |
| **react-native-worklets-core** | runs frame logic off the JS thread | reanimated worklets (heavier dep) |
| **react-native-fs** | read the captured photo file as base64 | native file bridge (more code) |
| **@noble/ciphers** | pure-JS AES-256-GCM, no native build | WebCrypto (absent on Hermes - see §8) |
| **react-native-get-random-values** | crypto RNG polyfill for uuid + keys | none - Hermes has no secure RNG |
| **react-native-sqlite-storage** | local relational store for records | AsyncStorage (no queries) |
| **react-native-encrypted-storage** | Android Keystore-backed secret store | plain storage (insecure for the key) |
| **axios** | HTTP for the S3 presigned-URL sync | fetch (fine, axios just nicer errors) |

---

## 6. Data, encryption, and sync

- **SQLite** holds three tables (`face_embeddings`, `attendance_log`,
  `sync_meta`). Embeddings are permanent; attendance is ephemeral (deleted after
  upload).
- **Embeddings are encrypted at rest** with AES-256-GCM. The 32-byte key is
  generated once and kept in `EncryptedStorage` (Android Keystore). Even with
  the DB file, faceprints are unreadable without the device key.
- **Sync** (`SyncService`): when connectivity returns, request presigned S3 PUT
  URLs in small batches, upload up to 5 in parallel, confirm, then **purge**
  uploaded rows. Exponential backoff on failure. Backend URL is configurable in
  `app.json` → `extra.syncBaseUrl` (currently a placeholder for offline testing).

---

## 7. The one decision that shaped the most code: how to get pixels into ONNX

The native engine needs **JPEG bytes** (base64) of a still. VisionCamera frames
do **not** expose `.toBase64()`. Two options:

- **A) Snapshot:** when a face is steady, call `camera.takePhoto()`, read the
  file with `react-native-fs`, base64 it, feed ONNX. **Chosen.**
- **B) Native frame plugin:** write Kotlin+Swift to convert every frame's YUV
  buffer to JPEG. More native code, heavier per-frame, two platforms.

A won because: zero extra native code, works on Android **and** iOS for free,
and the heavy ONNX runs once per attempt (matches the "< 1 s" budget) instead of
30×/second. This is why the continuous path uses only the cheap ML Kit detector,
and the photo is captured on lock-in.

---

## 8. The debugging journey (where the real learning is)

The skeleton compiled and the APK built, but **nothing ran end-to-end** until a
chain of runtime bugs was fixed on a real phone. Each is a transferable lesson.

### 8.1 The database was never opened
`getDb()` threw "Database not initialised" forever. Root cause: `App.tsx` never
called `openDatabase()`. **Lesson:** a singleton with a lazy `get()` needs an
explicit `init()` at startup; gate the UI on it (`dbReady`).

### 8.2 SQLite "enablePromise is not a function"
`import { enablePromise } from 'react-native-sqlite-storage'` gave `undefined`.
The library uses `module.exports = SQLite` (one CommonJS object), so **named
imports don't exist**, only the default. Fixed by destructuring from the
default. **Lesson:** CJS default-export libraries + Hermes ≠ ES named imports.

### 8.3 The camera crashed: "invalid empty parentheses '( )'"
The frame-processor *worklet* failed to compile. Two parts:
- We referenced a separate `'worklet'` function inside the processor and used an
  empty-arrow fallback, worklets-core serialised that to malformed JS. Fix:
  **inline** the mapping, no separate worklet.
- Even after that, it persisted, because **Metro had cached** the bundle from
  *before* the `react-native-worklets-core/plugin` was added to `babel.config.js`.
  A babel-plugin change is invisible to a hot reload. Fix: `npm start --reset-cache`.
**Lesson:** worklets are compiled JS strings; keep them self-contained, and
**always reset Metro cache after touching babel config.**

### 8.4 ONNX: "ORT_NOT_IMPLEMENTED ConvInteger(10)"
The recognition model wouldn't load. It had been quantised with
`weight_type=QInt8`, which emits `ConvInteger` nodes with **signed int8**
weights, ONNX Runtime's Android CPU kernel only implements the **uint8** combo.
Fix: re-quantise with `QuantType.QUInt8` (`scripts/export_mobilefacenet.py`),
ship the new 3.4 MB model. **Lesson:** model "compression" must match the
runtime's supported op/type set, not just be small.
> *Quantisation = storing weights as 8-bit ints instead of 32-bit floats: ~4×
> smaller, slightly less precise. The win that keeps us under 20 MB.*

### 8.5 Liveness rejected every real face (score ≈ 0.025)
We assumed FASNet's "real" class was index 1 (true for the original Silent-Face
repo). A diagnostic log of the **full softmax** showed live faces peaking hard at
**index 2** (0.88–0.98) on *this* exported model. Fix: read index 2.
**Lesson:** never assume a model's class order, **log the raw distribution and
let the data tell you.** Adding that one log turned guesswork into a one-line fix.

### 8.6 uuid + encryption: "crypto.getRandomValues() not supported"
Hermes (RN's JS engine) has **no WebCrypto**: no `crypto.getRandomValues`, no
`crypto.subtle`. Two fixes:
- `uuid` needs `getRandomValues` → added `react-native-get-random-values`
  polyfill, imported **first** in `index.js`.
- `crypto.ts` used `crypto.subtle` (AES) which simply does not exist on device.
  Replaced WebCrypto with **`@noble/ciphers`** (pure-JS AES-256-GCM), key stored
  as hex in EncryptedStorage. Jest needed `@noble` (ESM-only) added to
  `transformIgnorePatterns`.
**Lesson:** the browser/Node crypto API is not on React Native; plan for a
polyfill or a pure-JS implementation.

### 8.7 The polyfill wouldn't link: "RNGetRandomValues could not be found"
Installed `react-native-get-random-values@2.0.0`, but `npx react-native config`
showed `platforms.android: null`. **v2.0.0 is New-Architecture-only**; this app
runs the **old architecture** (`bridgeless: false`), so it didn't autolink.
Fix: pin **`1.11.0`** and **clean-rebuild** so autolinking regenerates
`PackageList.java`. **Lesson:** native deps must match your RN architecture; when
a native module "isn't found", check `react-native config` and do a clean build.

### 8.8 Anti-spoof: video replay is not separable
With everything working, a **video of the user doing the gestures** still passed.
The logs showed why: the replay scored passive liveness **0.85–0.94, identical
to a live face**. FASNet at an 80×80 crop cannot see that it's a screen. We added
an **ordered random gesture sequence** with neutral→gesture transitions (defeats
static photos and wrong-order replays), but a looping video can still satisfy a
timed challenge. **Lesson:** passive CNN liveness has a hard ceiling; true
video-replay defence needs depth/IR hardware or a server-issued nonce, beyond
"basic offline anti-spoof". Documented honestly rather than faked.

### 8.9 The app force-quit on rejection and on enrolment capture

**Symptom.** Two specific moments reliably killed the app:
1. Complete a full auth attempt that ends in rejection ("Not recognised").
2. Tap the Capture button on the Enrolment screen.

No error screen, no JS exception — the process just died silently.

**What the native engine does with a photo.**
Every time a model needs to run, the Kotlin code decodes the camera photo from
its compressed JPEG into a raw grid of pixels held in memory — Android calls this
a *bitmap*. A single 1280×720 photo becomes a ~3.5 MB block of memory. One
complete auth session does this four times:

| Call | Why | Memory |
|---|---|---|
| `detectFace` | find the face box | 3.5 MB bitmap |
| `checkLiveness` × 2 | passive anti-spoof at two crop scales | 3.5 MB × 2 |
| `getEmbedding` | produce the 512-number face vector | 3.5 MB bitmap + tiny aligned crop |

Total: roughly **14 MB** of raw bitmaps created during a single attempt.

**The first bug: nobody returned the memory.**
When the Kotlin code finished with each bitmap it simply moved on. It never told
Android "I'm done, you can have this memory back." Android's garbage collector
*will* eventually reclaim it, but if the next decode request arrives before it
does, Android has nowhere to put the new bitmap and throws an
`OutOfMemoryError`.

> *This is why the crash happened specifically at rejection and at capture:
> those are the first moments after the full pipeline has run and all four
> bitmaps are simultaneously alive in memory. Any single photo would have been
> fine; the combination pushed it over the edge.*

**The second bug: the crash was invisible.**
The Kotlin code had error-catching in the right place:

```kotlin
} catch (e: Exception) {
    promise.reject("DETECT_ERROR", e.message, e)
}
```

This looks correct, but `OutOfMemoryError` is not an `Exception`. In Java/Kotlin
there are two families of "something went wrong":

- `Exception` — things a program can normally handle (file not found, bad input,
  network timeout).
- `Error` — serious system-level failures. `OutOfMemoryError` is one of these.

Both are subtypes of `Throwable`. Catching only `Exception` means
`OutOfMemoryError` flies right past the catch block, reaches the inference thread
unhandled, and Android kills the entire app process — which is exactly what
"force exit" looks like.

**The fix.**
Two changes to `FaceEngineModule.kt`:

1. After each bitmap is no longer needed, call `bitmap.recycle()`. This
   immediately releases the memory rather than hoping the garbage collector gets
   to it in time. Guards like `if (resized !== original) resized.recycle()` are
   added where Android might return the same object you passed in — you cannot
   recycle something you didn't create.

2. Change every `catch (e: Exception)` to `catch (e: Throwable)` so that
   `OutOfMemoryError` (and any other system-level failure) is caught, turned into
   a JS-readable error message, and surfaced as a normal rejection rather than
   a silent process kill.

**Lesson.** Memory leaks in native code don't surface during development on a
fast Wi-Fi debug build; they only appear under the load of a real release build
running the full pipeline. The rule is: if you allocate a native resource
(bitmap, file, session), explicitly free it when you are done. Never rely on the
garbage collector to do it in time. And when catching errors in a background
thread, catch `Throwable`, not `Exception` — leaving `Error` subclasses
uncaught terminates the whole process with no user-visible reason.

### Meta-lesson
Most of these were **integration/runtime** issues invisible to `tsc` and `jest`
(which all passed throughout). Type-checks and unit tests prove logic, not that
the app *runs on the device*. The fastest path was: build, run on hardware, read
`adb logcat`, add a targeted diagnostic, fix, repeat.

---

## 9. Anti-spoofing: honest status

| Attack | Stopped? | By what |
|---|---|---|
| Printed/static photo | ✅ | gesture (can't blink/turn) + FASNet |
| Still face on a screen | ✅ mostly | gestures + transitions |
| Casual replay, wrong gesture order | ✅ | random ordered sequence |
| Tailored looping video of all gestures | ❌ | needs depth/IR or server nonce |

This matches the brief's "**basic** offline anti-spoofing". The limitation is
written down, not hidden.

---

## 10. How to build, run, and test (Android)

Set toolchain env in every new terminal (paths are this machine's scoop install):

```powershell
$env:JAVA_HOME = "$HOME\scoop\apps\temurin17-jdk\current"
$env:ANDROID_HOME = "$HOME\scoop\apps\android-clt\current"
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"
```

Build the APK:

```powershell
cd android
.\gradlew.bat assembleDebug      # APK → app\build\outputs\apk\debug\app-debug.apk
cd ..
```

Run (two terminals):

```powershell
# 1) Metro (JS server). --reset-cache after any babel/dep change.
npm start -- --reset-cache

# 2) install + launch + log
adb install -r android\app\build\outputs\apk\debug\app-debug.apk
adb reverse tcp:8081 tcp:8081
adb shell am start -n com.offlineid/.MainActivity
adb logcat ReactNativeJS:V FaceEngine:D AndroidRuntime:E *:S
```

Checks before trusting it:

```powershell
npm run typecheck     # tsc
npm test              # jest
```

---

## 11. Where things live (file map)

```
App.tsx                         app shell, tabs, DB+engine startup
index.js                        entry; imports the RNG polyfill FIRST
src/
  components/CameraView.tsx     camera + ML Kit worklet + capture() ref
  components/LivenessPrompt.tsx animated gesture instruction
  screens/EnrollScreen.tsx      3-capture enrollment
  screens/AuthScreen.tsx        live auth state UI
  hooks/useFaceAuth.ts          the auth state machine (detect→live→gesture→match)
  hooks/useNetworkSync.ts       auto-sync on reconnect
  services/FaceEngine.ts        typed JS facade over the native module
  services/LivenessService.ts   passive + active (gesture sequence) liveness
  services/EmbeddingStore.ts    enrol/query embeddings (encrypted)
  services/AttendanceStore.ts   attendance rows
  services/SyncService.ts       S3 presigned-URL upload + purge
  db/schema.ts, db/migrations.ts SQLite tables + open/migrate
  utils/crypto.ts               AES-256-GCM via @noble/ciphers
  utils/cosineDistance.ts       embedding match math
android/app/src/main/java/com/offlineid/FaceEngineModule.kt
                                the native ONNX engine (all 4 models)
android/app/src/main/assets/*.onnx   the bundled models
scripts/export_*.py             model export/quantisation scripts
models/                         source + exported ONNX models
```

The native module contract is the seam: `FaceEngine.ts` (TypeScript types) ⇄
`FaceEngineModule.kt` (Kotlin). `detectFace`, `checkLiveness`, `getEmbedding`,
`initModels`, `releaseModels`. Everything crosses as base64 strings + plain
arrays to keep the bridge payload primitive.

---

## 12. Jargon glossary

- **Embedding**, a fixed-length number vector representing a face; similar faces
  → similar vectors.
- **Cosine similarity**, angle-based closeness of two vectors; 1 = identical
  direction.
- **ONNX / ONNX Runtime**, portable model format / the engine that runs it
  on-device.
- **Quantisation (INT8)**, store weights as 8-bit ints; ~4× smaller model.
- **Worklet**, a small function compiled to run on a separate (non-JS) thread,
  used for per-frame camera work.
- **Hermes**, React Native's JavaScript engine; lacks some browser APIs
  (WebCrypto).
- **Autolinking**, RN's mechanism to wire native modules into the build; depends
  on the RN architecture (old vs new).
- **NMS**, non-max suppression; keep the best of overlapping detections.
- **Presigned URL**, a time-limited S3 link that lets the phone upload without
  AWS credentials.

---

## 13. What's done vs. left

**Working on-device (Android):** enrol, encrypted storage, passive liveness,
gesture sequence, recognition (match scores ~0.81–0.89), offline queue, stable
memory use across repeated auth and enrolment sessions (all native bitmaps
explicitly recycled; §8.9).

**Not done:**
- iOS parity (Swift `FaceEngine` + pod; the JS/capture path is already
  cross-platform).
- Real sync backend (placeholder URL) and end-to-end purge test.
- Accuracy validation across many faces / lighting for the >95% claim.
- Release signing (debug key today).
- Stronger anti-spoof (hardware/nonce), documented limitation.
```
