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
| `FaceEngine.m` | `RCT_EXTERN_MODULE` bridge exposing the Swift methods to RN. |
| `OfflineID-Bridging-Header.h` | Imports React's ObjC headers into Swift. |

## Build wiring (do once in Xcode - code is build-agnostic)

1. **Add ONNX Runtime** to `ios/Podfile` inside `target 'OfflineID'`:
   ```ruby
   pod 'onnxruntime-objc', '~> 1.18.0'
   ```
   then `cd ios && pod install`.

2. **Add these 4 source files** to the `OfflineID` target (drag into the Xcode project, or
   they're picked up if under the target's source root): `FaceEngine.swift`,
   `RGBAImage.swift`, `FaceEngine.m`.

3. **Bridging header**: set Build Settings → *Objective-C Bridging Header* to
   `FaceEngine/OfflineID-Bridging-Header.h` (or merge its two imports into an existing one).
   Xcode also offers to create one automatically the first time you add a Swift file to an
   ObjC project, accept, then paste the imports.

4. **Bundle the models**: add the 4 ONNX files to *Build Phases → Copy Bundle Resources*:
   `scrfd_500m_fixed.onnx`, `mobilefacenet_int8.onnx`, `fasnet_2_7.onnx`, `fasnet_4_0.onnx`
   (same files as `android/app/src/main/assets/`). `initModels()` loads them via
   `Bundle.main.path(forResource:ofType:"onnx")`.

5. **Camera permission**: add `NSCameraUsageDescription` to `Info.plist` (VisionCamera).

Build/run on a Mac: `cd ios && pod install && cd .. && npx react-native run-ios --configuration Release`.

## Parity notes
- **Channel order**: SCRFD/MobileFaceNet RGB, FASNet **BGR**, identical to Kotlin.
- **Normalisation**: SCRFD `(px-127.5)/128`; MobileFaceNet `(px-127.5)/127.5`; FASNet
  per-channel mean/std in BGR, identical constants.
- **Live class index = 2** in the FASNet softmax (same as the device-verified Android value).
- **Pixel origin**: `RGBAImage` renders top-left-origin to match `Bitmap.getPixels`, so
  alignment + crops line up with the Android results.
- **Execution provider**: CPU only (meets the < 1 s budget). CoreML EP is optional later.
