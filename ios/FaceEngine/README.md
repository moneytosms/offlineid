# iOS native FaceEngine (Swift)

Swift port of the Android `FaceEngineModule.kt`. Same ONNX models, same preprocessing math
(ported byte-for-byte from `MODEL_PIPELINE.md §3`), same JS contract
(`src/services/FaceEngine.ts`). Once linked, `NativeModules.FaceEngine` resolves on iOS and
**every screen works unchanged**, `isFaceEngineAvailable()` flips `true`.

## Files
| File | Role |
|---|---|
| `FaceEngine.swift` | The module: `initModels / releaseModels / detectFace / checkLiveness / getEmbedding`, SCRFD decode + NMS, ArcFace align (manual least-squares), FASNet softmax. |
| `RGBAImage.swift` | CoreGraphics pixel helper (replaces Android `Bitmap`): decode, resize, crop, top-left-origin RGBA buffer. |
| `FaceEngine.m` | `RCT_EXTERN_MODULE` bridge exposing the Swift FaceEngine methods to RN. |
| `ScreenBrightness.swift` | Display fill-light + keep-awake: `setBrightness / restore / getLux / acquireWakeLock / releaseWakeLock`. Swift port of `ScreenBrightnessModule.kt` (same JS contract). |
| `ScreenBrightness.m` | `RCT_EXTERN_MODULE` bridge exposing the Swift ScreenBrightness methods to RN. |
| `OfflineID-Bridging-Header.h` | Imports React's ObjC headers into Swift (shared by both Swift modules). |

## Build wiring — **already applied to the Xcode project**

The Podfile, `OfflineID.xcodeproj/project.pbxproj`, and `Info.plist` are already wired, so no
manual Xcode clicking is needed. What was done, for reference:

1. **ONNX Runtime pod** added to `ios/Podfile` inside `target 'OfflineID'`:
   `pod 'onnxruntime-objc', '~> 1.18.0'`.

2. **Source files** added to the `OfflineID` target's *Compile Sources* phase:
   `FaceEngine.swift`, `RGBAImage.swift`, `FaceEngine.m`, `ScreenBrightness.swift`,
   `ScreenBrightness.m` (grouped under a `FaceEngine` group).

3. **Bridging header**: `SWIFT_OBJC_BRIDGING_HEADER = FaceEngine/OfflineID-Bridging-Header.h`
   set on both Debug and Release configs of the `OfflineID` target.

4. **Models** added to *Copy Bundle Resources*: `scrfd_500m_fixed.onnx`,
   `mobilefacenet_int8.onnx`, `fasnet_2_7.onnx`, `fasnet_4_0.onnx`. To avoid duplicating
   ~9 MB in the repo, the file references point at the existing
   `android/app/src/main/assets/*.onnx` (single source of truth). `initModels()` still loads
   them via `Bundle.main.path(forResource:ofType:"onnx")` since Xcode flattens them into the
   app bundle root at build time.

5. **Camera permission**: `NSCameraUsageDescription` added to `Info.plist` (VisionCamera).

### Remaining (requires a Mac — cannot be done on this machine)
```bash
cd ios && pod install && cd ..
npx react-native run-ios --configuration Release
```
`pod install` resolves `onnxruntime-objc` and regenerates the workspace; then build/run.
Once linked, `NativeModules.FaceEngine` + `NativeModules.ScreenBrightness` resolve on iOS and
every screen works unchanged (`isFaceEngineAvailable()` flips `true`).

## Parity notes
- **Channel order**: SCRFD/MobileFaceNet RGB, FASNet **BGR**, identical to Kotlin.
- **Normalisation**: SCRFD `(px-127.5)/128`; MobileFaceNet `(px-127.5)/127.5`; FASNet
  per-channel mean/std in BGR, identical constants.
- **Live class index = 2** in the FASNet softmax (same as the device-verified Android value).
- **Pixel origin**: `RGBAImage` renders top-left-origin to match `Bitmap.getPixels`, so
  alignment + crops line up with the Android results.
- **Execution provider**: CPU only (meets the < 1 s budget). CoreML EP is optional later.
