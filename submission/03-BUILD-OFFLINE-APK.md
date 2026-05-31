# Building the Standalone Offline APK (not debug / Metro)

**Short answer to "is the app finished, or only running in debug mode?"**

During development the app runs in **debug mode**: the JavaScript is served live from the
**Metro** dev server over USB/Wi-Fi, and dev tooling is on. That is *not* a deliverable -
it needs a computer running Metro and is not truly offline.

The **finished, standalone, fully-offline app** is the **release build**. The release build
**embeds the JavaScript bundle inside the APK**, strips dev tooling, and runs with **no
Metro and no network**. That is the artifact you ship and demo in airplane mode.

The native ONNX models are already packaged as Android **assets** in both build types, so
all inference is on-device either way, the difference is purely the JS bundle + dev server.

| | Debug (`assembleDebug` / `npx react-native run-android`) | **Release (`assembleRelease`)** |
|---|---|---|
| JS source | Live from Metro dev server | **Embedded in APK** |
| Needs a PC running Metro | Yes | **No** |
| Works in airplane mode | No (JS won't load) | **Yes** |
| Dev menu / debugging | On | Off |
| Ship / demo / submit | ✗ | **✓** |

---

## Build it

From the repo root:

```powershell
cd android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --console=plain
cd ..
```

Output APK (arm64-v8a, ~62 MB):
```
android/app/build/outputs/apk/release/app-release.apk
```

**Why the `-PreactNativeArchitectures=arm64-v8a` flag:** the project enables an ABI split
(`android/app/build.gradle`) so the APK ships only `arm64-v8a`, without it, the prebuilt
ONNX Runtime + ML Kit `.so` for all four ABIs balloon the APK to ~167 MB. The flag also
restricts the native CMake build to arm64, sidestepping a flaky `react-native-vision-camera`
`armeabi-v7a` CMake error (`ninja: manifest 'build.ninja' still dirty`) on Windows paths
with spaces. arm64-v8a covers effectively every field device since 2017. To build for an
x86_64 **emulator**, pass `-PreactNativeArchitectures=x86_64` instead.

Install on a device and pull the USB cable / turn on airplane mode, it runs standalone:
```powershell
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

> The project's `release` build type is configured to sign with the bundled debug keystore
> (see `android/app/build.gradle`), so `assembleRelease` produces an **installable signed
> APK** directly - good enough for the hackathon prototype.

---

## (Optional) Ship with your own signing key

For a production-grade artifact, generate a release keystore instead of the debug key:

```powershell
keytool -genkeypair -v -storetype PKCS12 -keystore offlineid-release.keystore `
  -alias offlineid -keyalg RSA -keysize 2048 -validity 10000
```
Then in `android/app/build.gradle`, add a `signingConfigs.release` block pointing at that
keystore (keep the password out of git, use `~/.gradle/gradle.properties`) and set
`buildTypes.release.signingConfig signingConfigs.release`. The brief does not require this;
the debug-signed release APK is sufficient to demonstrate the offline prototype.

---

## (Optional) Smaller APK - split per ABI

ONNX Runtime ships native libs for several ABIs. To shrink the demo APK, enable ABI splits
in `android/app/build.gradle`:
```gradle
android {
  splits { abi { enable true; reset(); include "arm64-v8a", "armeabi-v7a"; universalApk false } }
}
```
Produces one APK per ABI under `outputs/apk/release/`. Use the `arm64-v8a` APK for modern
devices.

---

## Verify it is truly offline

1. Install `app-release.apk`.
2. **Stop Metro** (close the dev server) and **enable airplane mode**.
3. Launch the app, it must open and run enroll + authenticate normally.
   - If it shows a red "Unable to load script / Metro" screen, you installed the **debug**
     APK by mistake, rebuild with `assembleRelease`.
4. Enroll → authenticate → spoof-reject all work with **zero connectivity**. ✅

---

## iOS standalone build (after the Swift engine port - see `02 §6`)

```bash
cd ios && pod install && cd ..
npx react-native run-ios --configuration Release
# or Archive in Xcode for a distributable .ipa
```
Until the iOS native `FaceEngine` module is ported, the iOS build runs the UI but face
inference is unavailable, Android is the working prototype for this submission.
