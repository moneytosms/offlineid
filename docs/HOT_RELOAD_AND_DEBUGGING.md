# OfflineID - Hot Reload & Debugging Guide

> How to run OfflineID in **dev (hot reload)** mode, read its logs on a real device or
> emulator, and diagnose the most common field failure: **enrolment works but Scan says
> "Not recognised"**.
>
> Read with `SETUP_AND_USAGE.md` (build/run), `SPEC.md` §9/§11 (liveness + recognition
> thresholds), `MODEL_PIPELINE.md` (model details).

All commands are PowerShell (Windows). On macOS/Linux swap `Select-String` for `grep` and
`.\gradlew.bat` for `./gradlew`.

---

## 0. Two run modes — know which you are in

| | Debug (hot reload) | Release (the APK you ship) |
|---|---|---|
| JS source | streamed live from **Metro** | embedded in the APK |
| Needs dev server | yes (`npm start`) | no |
| Needs network | yes (to reach Metro) | **no — fully offline** |
| Fast Refresh / hot reload | ✅ | ❌ |
| Log verbosity (`logger`) | `debug` and up | `info` and up (see §3) |
| Built with | `run-android` | `assembleRelease` |

**Most "it isn't working on my friend's phone" reports are about the release APK.** A debug
APK shows a red Metro error screen if it cannot reach a dev server — if your friend sees
that, give them the **release** APK instead (see `SETUP_AND_USAGE.md` §4.2).

---

## 1. Prerequisites (one-time)

Set the build env in **every** new shell (from `SETUP_AND_USAGE.md` §1.2):

```powershell
$env:JAVA_HOME    = "$HOME\scoop\apps\temurin17-jdk\current"   # MUST be JDK 17
$env:ANDROID_HOME = "$HOME\scoop\apps\android-clt\current"
$env:PATH         = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"
```

Phone: enable Developer Options → USB debugging, connect, accept the RSA prompt. Confirm:

```powershell
adb devices        # exactly one entry, state "device" (not "unauthorized")
```

---

## 2. Hot reload (Fast Refresh) workflow

Use this while editing JS/TS — edits apply in ~1 s without losing app state.

**Terminal 1 — Metro dev server:**

```powershell
npm start                 # or:  npm start -- --reset-cache  after dep/babel changes
```

**Terminal 2 — build + install the debug app once:**

```powershell
npx react-native run-android
```

If the device cannot reach Metro (no preview, "Could not connect to development server"):

```powershell
adb reverse tcp:8081 tcp:8081
```

(`adb reverse` forwards the phone's `localhost:8081` to your PC's Metro. Re-run it after
re-plugging USB.)

### In-app controls

| Action | How |
|---|---|
| Open dev menu | shake device, or `adb shell input keyevent 82` |
| Full reload JS | press **r** in the Metro terminal, or dev menu → Reload |
| Toggle Fast Refresh | dev menu → "Enable/Disable Fast Refresh" (on by default) |
| Element inspector | dev menu → "Show Inspector" |

### What hot reload does **not** reload

Fast Refresh only swaps **JS/TS**. If you change any of these you must rebuild
(`run-android` again):

- Native Kotlin/Swift (`FaceEngine*.kt`, `FaceEngineModule.swift`).
- The ONNX model assets in `android/app/src/main/assets/`.
- `babel.config.js`, `metro.config.js`, native deps, permissions.

> Threshold constants (`MATCH_THRESHOLD`, `PASSIVE_LIVENESS_THRESHOLD`, …) are plain TS, so
> tuning them **is** hot-reloadable — handy when calibrating against your lighting (§5).

---

## 3. Logging — what prints, and where

The app logs through `src/utils/logger.ts`. Levels: `debug < info < warn < error`.

```ts
// logger.ts:18 — level is chosen by build type
export const LOG_LEVEL = __DEV__ ? 'debug' : 'info';
```

So in a **release** APK, `debug` lines are dropped; `info`/`warn`/`error` still print.

`babel.config.js` does **not** include `transform-remove-console`, so `console.*` (and
therefore `logger.*`) **survives in release** and is bridged to Android logcat under the
tag `ReactNativeJS`. You can debug the shipped APK on a real device.

### Tail the logs

Full firehose (debug build):

```powershell
adb logcat | Select-String -Pattern "OfflineID|FaceEngine|ReactNativeJS|VisionCamera|onnx"
```

Just the app's JS logs (works on release too):

```powershell
adb logcat -c                              # clear backlog first
adb logcat *:S ReactNativeJS:V | Select-String "OfflineID"
```

Every app line is prefixed `[OfflineID][<tag>]`, e.g. `[OfflineID][FaceAuth]`.

---

## 4. Diagnosing "Not recognised — No enrolled match or liveness failed"

That on-screen message is the **single generic FAIL text** for *both* reject paths
(liveness/gesture reject **and** recognition below threshold). The UI can't tell you which
one fired — **the log can**. Reproduce once with logcat running and match the line:

| Log line (tag `FaceAuth`/`Liveness`) | Level | Meaning | Likely fix |
|---|---|---|---|
| `liveness reject` | info | passive FASNet score ≤ 0.6 | even lighting; not backlit. See §5. |
| `gesture reject (BLINK/SMILE/...)` | info | active gesture not completed in window | perform the prompted gesture from a **neutral** face first (§4.1) |
| `uncertain score=0.5x retry=N` | info | genuine match landed in 0.45–0.65 band | **threshold too strict — §5** |
| `SUCCESS <id> score=0.7x` | info | matched | working |
| `Native module "FaceEngine" is not available` | error | native engine not linked / wrong ABI | rebuild; on emulator see §6 |
| `pipeline error` | error | exception mid-pipeline (camera/still/model) | read the attached stack |

> The passive FASNet **numeric** score is logged at `debug` (`Liveness.ts:145`) so it is
> **not** visible in a release APK. If you need that number, run a **debug** build.

### 4.1 The liveness state machine (why a smiling, eyes-shut face can fail)

The active step (`LivenessService.ts`) requires a **neutral → gesture transition**: it must
first see a frame that does *not* satisfy the gesture, then the gesture. BLINK additionally
needs the eyes-closed condition on **2 consecutive** frames. So a face that is already
mid-smile / squinting when the prompt appears never registers the transition and times out
→ `gesture reject`. Tell the user: relax to a neutral face, then perform the prompt.

---

## 5. Tuning recognition thresholds

If the log shows `uncertain score=0.5x` for the **genuine** person, recognition is
mis-calibrated, not broken. MobileFaceNet genuine-pair cosine commonly lands **0.4–0.65**,
while impostors stay **~0.0–0.3**, so the default `0.65` gate can reject real users under
beard/lighting/pose variance with a wide safety margin still intact.

Constants live in `src/hooks/useFaceAuth.ts`:

```ts
export const MATCH_THRESHOLD     = 0.65;  // > this  → SUCCESS
export const UNCERTAIN_THRESHOLD = 0.45;  // [this, MATCH] → retry; below → reject
```

and the passive-liveness gate in `src/services/LivenessService.ts`:

```ts
export const PASSIVE_LIVENESS_THRESHOLD = 0.6;   // averaged two-scale FASNet
```

Suggested calibration loop:

1. Run a **debug** build with logcat (so you see `score=` numbers).
2. Have the genuine person Scan 5–10×; note the typical `score=`.
3. Set `MATCH_THRESHOLD` a little below that cluster (e.g. `0.50`) and
   `UNCERTAIN_THRESHOLD` ~0.15 lower (e.g. `0.35`).
4. Confirm an **un-enrolled** person still scores below the new gate (no false accepts).
5. Hot-reload re-applies the change instantly; re-test.

> Lowering the gate trades security for tolerance. Validate against impostors before
> shipping a looser value. SPEC §11 documents the intended bands.

---

## 6. Emulator caveats (Android Studio + just the APK)

Running the release APK on an emulator is useful but **may not reproduce a phone bug**:

1. **ABI mismatch.** Emulators are usually **x86_64**; phones are **arm64-v8a**. The shipped
   APK is built arm64-only (`-PreactNativeArchitectures=arm64-v8a`, ~58 MB). On an x86_64
   emulator the native ONNX `FaceEngine` lib won't load → `Native module "FaceEngine" is
   not available` — a *different* failure from the phone's recognition reject. For the
   emulator, build an x86_64 APK:

   ```powershell
   cd android
   .\gradlew.bat assembleRelease -PreactNativeArchitectures=x86_64
   cd ..
   ```

   Verify which ABIs an APK actually contains:

   ```powershell
   # lists the bundled native libs; look for x86_64/ vs arm64-v8a/
   & "$env:JAVA_HOME\bin\jar.exe" tf android\app\build\outputs\apk\release\app-x86_64-release.apk |
     Select-String "lib/.*\.so"
   ```

2. **No real camera.** The emulator's camera is a synthetic/webcam feed, so face detection,
   FASNet liveness and the blink/turn/smile gestures behave differently or not at all. You
   can exercise the **threshold** path on an emulator, but **liveness** must be validated on
   a physical device.

**Bottom line:** debug a phone failure *on the phone* via `adb logcat`. Use the emulator
only for the recognition/threshold path, and only with an x86_64 build.

---

## 7. Quick command reference

```powershell
adb devices                                   # device connected & authorized?
adb logcat -c                                 # clear log backlog
adb logcat *:S ReactNativeJS:V | Select-String "OfflineID"   # app JS logs (debug+release)
adb reverse tcp:8081 tcp:8081                 # let device reach Metro (debug)
adb shell input keyevent 82                   # open RN dev menu
adb shell pm clear com.offlineid              # wipe app data (DB, enrolments)
adb uninstall com.offlineid                   # remove app
cd android; .\gradlew.bat --stop; cd ..       # stop a stuck Gradle daemon
```

---

## 8. Failure quick-reference

| Symptom | Likely cause | Action |
|---|---|---|
| Red Metro screen on the release APK | installed the **debug** APK | install `OfflineID-v1.4.0-arm64-v8a.apk` |
| "Could not connect to development server" (debug) | device can't reach Metro | `adb reverse tcp:8081 tcp:8081`; same network |
| Enrol works, Scan always "Not recognised" | threshold too strict **or** liveness reject | read logcat (§4): `uncertain score=` → §5; `gesture/liveness reject` → §4.1 |
| `Native module "FaceEngine" is not available` | engine not linked / wrong ABI | rebuild; on emulator build x86_64 (§6) |
| Liveness always fails on a real live face | FASNet channel order / backlight | even frontal lighting; see MODEL_PIPELINE §3.4 |
| Edits to `.kt`/models don't apply | only JS hot-reloads | rebuild with `run-android` |
