# Android Phone Testing

## Status

This repo is a buildable Android prototype with a wired end-to-end face path.

What is ready:

- Android debug APK builds successfully; JS bundles clean (`npx react-native bundle`).
- Four ONNX model assets are bundled in `android/app/src/main/assets/`.
- Native Android `FaceEngine` module is registered.
- `CameraView` streams ML Kit faces (`react-native-vision-camera-face-detector`)
  for presence/bbox/gestures and exposes `capture()` (VisionCamera `takePhoto`
  + `react-native-fs`) for the on-demand base64 still fed to the ONNX engine.
- Enrolment, auth (detect → passive liveness → active gesture → recognise),
  and sync screens are wired to that pipeline.
- Unit tests and TypeScript checks pass.

Anti-spoofing reality (measured on-device):

- Passive FASNet reliably accepts live faces (~0.93) and the active gesture
  sequence blocks static photos and casual replays.
- A high-quality **screen replay video scores the same as a live face**
  (~0.85–0.94), FASNet at an 80×80 crop cannot see the screen. Passive
  liveness alone does not stop a tailored video. The ordered random-gesture
  sequence (with neutral→gesture transitions) raises the bar but a looping
  video of all gestures can still beat a challenge-response scheme. Defeating
  that needs depth/IR hardware or a server nonce, out of scope for "basic
  offline anti-spoofing".

Remaining caveats (test on a physical device):

- Pipeline is verified to build/bundle, not yet validated on real faces, run the
  on-device checks below and tune thresholds (SPEC §9/§11) against your lighting.
- bbox overlay uses the detector's auto-scaled bounds; pixel alignment vs the
  preview may need per-device adjustment (cosmetic only).
- Sync uses placeholder backend URL `https://api.datalake.example.com`
  (`app.json` → `extra.syncBaseUrl`), so offline auth works but real upload needs
  a live endpoint. Point `extra.syncBaseUrl` at the real backend to enable sync.

## Full Clean Install

From repo root:

```powershell
python scripts\uninstall_deps.py --full
python scripts\install_deps.py --full
```

Restart terminal after toolchain install if `java`, `adb`, or `sdkmanager` are not found.

Set build env in every new terminal:

```powershell
$env:JAVA_HOME = "$HOME\scoop\apps\temurin17-jdk\current"
$env:ANDROID_HOME = "$HOME\scoop\apps\android-clt\current"
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"
```

## Phone Setup

1. Enable Developer Options on phone.
2. Enable USB debugging.
3. Connect phone over USB.
4. Accept RSA debugging prompt on phone.
5. Verify ADB sees device:

```powershell
adb devices
```

Expected: one device listed as `device`, not `unauthorized`.

## Verify Build

```powershell
npm test -- --runInBand
npm run typecheck
cd android
.\gradlew.bat assembleDebug
cd ..
```

APK path:

```text
android\app\build\outputs\apk\debug\app-debug.apk
```

## Install APK Directly

```powershell
adb install -r android\app\build\outputs\apk\debug\app-debug.apk
```

Open `OfflineID` on phone.

Expected current behavior:

- App launches; ONNX models load.
- Camera permission prompt appears; preview shows after granting.
- Enrol: green box locks when face is steady → 3 captures → "Enrolled".
- Auth: hold still → passive liveness → gesture prompt (blink/turn/smile) →
  recognise → welcome card, or "Not recognised" / lockout after 3 fails.

## Run With Metro

Use this while actively editing JS/TS:

Terminal 1:

```powershell
npm start -- --reset-cache
```

Terminal 2:

```powershell
npx react-native run-android
```

If device cannot reach Metro:

```powershell
adb reverse tcp:8081 tcp:8081
```

## Useful Debug Commands

Device logs:

```powershell
adb logcat | Select-String -Pattern "OfflineID|FaceEngine|ReactNativeJS|VisionCamera|onnx"
```

Clear app data:

```powershell
adb shell pm clear com.offlineid
```

Uninstall app:

```powershell
adb uninstall com.offlineid
```

Stop Gradle daemon:

```powershell
cd android
.\gradlew.bat --stop
cd ..
```

## Completion Checklist

Before calling this product complete:

- [done] Frame-to-base64 via `takePhoto` + `react-native-fs` (`CameraView.capture`).
- [done] Wire `react-native-vision-camera-face-detector` into active liveness.
- Replace placeholder sync base URL (`app.json` → `extra.syncBaseUrl`) with real backend.
- Test enrolment of one person on physical phone.
- Test auth success, auth failure, liveness rejection, and lockout.
- Test offline attendance queue, reconnect sync, and local purge.
- Port the capture/face-detector path to iOS (Swift `FaceEngine` + pod) for parity.
- Create release signing config; current release build uses debug key.
