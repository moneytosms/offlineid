# Integrating OfflineID into Datalake 3.0

How to drop the OfflineID offline face-auth module into the existing **Datalake 3.0**
React Native app. OfflineID is built as a self-contained module: **one native package +
a handful of JS screens/services + a model-asset folder**. No backend changes are required
for the offline auth path; only a presigned-URL endpoint is needed for sync.

> Audience: a Datalake 3.0 RN engineer. Assumes Datalake is RN ≥ 0.74, old or new arch,
> Hermes on. OfflineID is verified on RN 0.75.4 (old arch, Hermes).

---

## 0. What you are integrating

```
OfflineID module
├── Native (Android, Kotlin)         ← ONNX inference engine, exposed as NativeModules.FaceEngine
│   ├── FaceEngineModule.kt          (detectFace / checkLiveness / getEmbedding / initModels)
│   └── FaceEnginePackage.kt         (ReactPackage registration)
├── Native (iOS, Swift)              ← Swift port provided, see §6
├── Model assets (≈9.1 MB)           ← 4 ONNX files in android/app/src/main/assets
├── JS services (src/services)       ← FaceEngine bridge, LivenessService, Stores, SyncService
├── JS hook (src/hooks/useFaceAuth)  ← orchestration state machine
└── JS screens (src/screens)         ← Auth / Enroll / SyncStatus / People / Settings
```

The public native contract (`src/services/FaceEngine.ts`):

```ts
NativeModules.FaceEngine:
  initModels(): Promise<void>                                   // load ONNX once at app start
  releaseModels(): Promise<void>                                // free on background
  detectFace(base64Frame): Promise<{ faces:[{bbox, landmarks, score}] }>
  checkLiveness(base64Frame, [x,y,w,h], scale): Promise<{ isLive, score }>
  getEmbedding(base64Frame, landmarksJson): Promise<{ embedding:number[512], inferenceMs }>
```

Everything above the native bridge is plain RN/TS and is already cross-platform.

---

## 1. Add the native engine (Android)

1. **Copy native sources** into Datalake's Android package
   (`android/app/src/main/java/<datalake-pkg>/`):
   - `FaceEngineModule.kt`
   - `FaceEnginePackage.kt`

   Fix the `package` line at the top of both files to Datalake's applicationId.

2. **Register the package** in Datalake's `MainApplication.kt`, add one line inside
   `getPackages()`:
   ```kotlin
   override fun getPackages(): List<ReactPackage> =
       PackageList(this).packages.apply {
         add(FaceEnginePackage())          // ← OfflineID engine
       }
   ```

3. **Add the ONNX Runtime dependency** to `android/app/build.gradle`:
   ```gradle
   dependencies {
       implementation "com.microsoft.onnxruntime:onnxruntime-android:1.18.0"
   }
   ```

4. **Copy the model assets** (the 4 ONNX files) into
   `android/app/src/main/assets/`:
   ```
   scrfd_500m_fixed.onnx        (detect)   2.41 MB
   mobilefacenet_int8.onnx      (embed)    3.35 MB
   fasnet_2_7.onnx              (liveness) 1.66 MB
   fasnet_4_0.onnx              (liveness) 1.66 MB
   ```
   `FaceEngineModule.initModels()` loads them from assets at startup.

> Net add to the Datalake APK: ~9.1 MB models + ~3.5 MB ONNX Runtime AAR ≈ **12.6 MB**,
> inside the 20 MB brief budget.

---

## 2. Add the JS dependencies

OfflineID adds these (all open-source) to `package.json`. Reuse any Datalake already has:

```jsonc
"react-native-vision-camera": "^4",                 // camera + still capture
"react-native-vision-camera-face-detector": "*",    // ML Kit gesture detection (worklet)
"react-native-worklets-core": "*",                  // worklet runtime for the frame processor
"react-native-fs": "*",                             // base64 stills
"react-native-sqlite-storage": "*",                 // local DB
"react-native-encrypted-storage": "*",              // Keystore-backed key store
"@noble/ciphers": "*",                              // AES-256-GCM (pure JS, no WebCrypto)
"react-native-get-random-values": "1.11.0",         // CSPRNG polyfill (pin 1.11.0 on old arch)
"@react-native-community/netinfo": "*"              // reconnect trigger for sync
```

Then:
```bash
yarn install
cd android && ./gradlew clean      # regenerate autolinking PackageList.java
```

**Babel**, ensure the worklets plugin is present (`babel.config.js`):
```js
plugins: ['react-native-worklets-core/plugin']
```
After adding it, start Metro once with `--reset-cache`.

**Entry polyfill**, `react-native-get-random-values` must be imported **first** in
`index.js` (before any crypto use):
```js
import 'react-native-get-random-values';
```

---

## 3. Copy the JS module

Copy these folders into Datalake's `src/` (namespace under `src/offlineid/` if you prefer):

```
src/services/   FaceEngine.ts  LivenessService.ts  EmbeddingStore.ts
                AttendanceStore.ts  SyncService.ts
src/hooks/      useFaceAuth.ts
src/components/ CameraView.tsx  LivenessPrompt.tsx  SyncBadge.tsx
src/screens/    AuthScreen.tsx  EnrollScreen.tsx  SyncStatusScreen.tsx
                PeopleScreen.tsx  SettingsScreen.tsx  AboutScreen.tsx
src/ui/         theme.ts  components.tsx          (or map onto Datalake's design system)
src/utils/      crypto.ts  cosineDistance.ts  logger.ts
src/config.ts
```

---

## 4. Wire it into Datalake navigation

OfflineID screens are ordinary RN components. Mount them in Datalake's navigator.

**Init models once at app start** (Datalake root, e.g. `App.tsx`):
```tsx
import { FaceEngine, isFaceEngineAvailable } from './offlineid/services/FaceEngine';
import { openDatabase } from './offlineid/services/db';   // your DB bootstrap

useEffect(() => {
  (async () => {
    await openDatabase();                 // local SQLite ready
    if (isFaceEngineAvailable()) await FaceEngine.initModels();   // load ONNX
  })();
}, []);
```

**Authenticate a field worker**, drop `AuthScreen` behind a Datalake route/button:
```tsx
<AuthScreen
  deviceId={datalakeDeviceId}            // your existing device identifier
  locationLat={gps?.lat}
  locationLon={gps?.lon}
/>
// On SUCCESS the screen writes an attendance record to the local queue;
// surface matchedEmployee.name / score in your Datalake UI as needed.
```

**Enroll** uses `EnrollScreen`; **sync status / manual sync** uses `SyncStatusScreen`;
drop `SyncBadge` into any Datalake header to show the queued count.

If Datalake owns identity, replace `EmbeddingStore`'s `employeeId/name/department` with
your user model, the store is the only coupling point.

---

## 5. Sync & purge endpoint (the only backend touchpoint)

OfflineID never holds AWS credentials. To enable sync, Datalake's backend must expose a
**presigned-URL** endpoint; point `SYNC_BASE_URL` in `src/config.ts` at it:

```
POST  {SYNC_BASE_URL}/attendance/presign   →  { url, fields }   // short-TTL S3 PUT
```

Flow (`SyncService.ts`): NetInfo reports reconnect → batch ≤10 unsynced rows → request
presigned PUT → upload JSON to S3 → on 200 **delete the local row (purge)**. Exponential
backoff; 403 → re-request URL. Until `SYNC_BASE_URL` is set it runs in placeholder mode and
records simply queue locally (offline path fully works).

No other Datalake backend change is required for the offline auth path.

---

## 6. iOS native engine (Swift) - provided

The Swift port of the engine is **already written** in `ios/FaceEngine/`:
- `FaceEngine.swift`, `initModels / releaseModels / detectFace / checkLiveness /
  getEmbedding`, SCRFD FPN decode + NMS, ArcFace 5-point align (manual least-squares),
  FASNet softmax, a 1:1 port of `FaceEngineModule.kt`.
- `RGBAImage.swift`, CoreGraphics pixel helper (top-left-origin RGBA), replaces Android
  `Bitmap`; identical resize/crop/normalise behaviour.
- `FaceEngine.m`, `RCT_EXTERN_MODULE` bridge; method signatures match `IFaceEngineNative`
  in `src/services/FaceEngine.ts` exactly, so **no JS changes** are needed.
- `OfflineID-Bridging-Header.h`, exposes React's ObjC headers to Swift.

What remains is **Xcode build wiring** (one-time, needs a Mac), see
`ios/FaceEngine/README.md`:
1. `pod 'onnxruntime-objc', '~> 1.18.0'` in `ios/Podfile` → `pod install`.
2. Add the 3 source files to the `OfflineID` (or Datalake) target.
3. Set the Objective-C Bridging Header build setting (or merge its imports).
4. Add the 4 ONNX files to *Copy Bundle Resources* (same files as Android assets).
5. Add `NSCameraUsageDescription` to `Info.plist`.

Because the contract is identical, once the module is linked `isFaceEngineAvailable()` flips
true on iOS and every screen works as-is. CoreML execution provider is optional, the CPU
provider already meets the < 1 s target.

---

## 7. Verify the integration

```bash
# Android, standalone offline build (no Metro, airplane mode)
cd android && ./gradlew assembleRelease
# install android/app/build/outputs/apk/release/app-release.apk on a device
```
Smoke test on-device, **with networking off**:
1. Enroll a person (Enroll screen) → encrypted embedding stored locally.
2. Authenticate (Auth screen) → passive liveness + gesture + match → SUCCESS.
3. Photo/screen of the person → rejected (anti-spoof).
4. Attendance row appears queued in Sync screen.
5. Re-enable network → auto-sync drains queue → local rows purged.

All five pass fully offline except step 5, which needs `SYNC_BASE_URL` configured.
