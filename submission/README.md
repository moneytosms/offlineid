<div align="center">
<img src="brand_logo.png" alt="OfflineID" width="200" />
</div>

# OfflineID - Hackathon 7.0 Submission Package

**Programme:** Develop a mobile based secure offline facial recognition and liveness
detection system for remote locations
**Module:** OfflineID, an offline face-recognition + liveness module for the
**Datalake 3.0** React Native app.

This folder is the **proposal package** you upload to the registration form. The full
source code, signed APK, and demo video are delivered via the **"Link for the proposal"**
field (your GitHub repo / Google Drive).

---

## What's in this folder

| File | Purpose | Maps to deliverable |
|---|---|---|
| `READMEFIRST.md` / `.pdf` | Start-here orientation: what this is + what each doc is | - |
| `README.md` | This index + how to submit | - |
| `01-PROPOSAL.md` | Solution overview: problem → approach → why it wins | Presentation |
| `02-DATALAKE-3.0-INTEGRATION.md` | **Exact steps to drop OfflineID into Datalake 3.0** | Feasibility / Integration steps |
| `03-BUILD-OFFLINE-APK.md` | Build the standalone **offline** release APK (not debug/Metro) | Working Prototype |
| `OfflineID_Hackathon7.pptx` | **Ready-to-present 16-slide deck** (themed) | **Presentation (mandatory)** |
| `PRESENTATION.md` | Slide outline / speaker notes behind the deck | Presentation |
| `docs/ARCHITECTURE.md` | System + data-flow architecture | Technical Documentation |
| `docs/MODEL_PIPELINE.md` | AI pipeline + model details | Technical Documentation |
| `docs/BENCHMARKS.md` | Size + latency benchmarks | Performance benchmarks |
| `docs/SPEC.md` | Full functional/technical spec | Technical Documentation |
| `docs/SETUP_AND_USAGE.md` | Build + run + demo walkthrough | Technical Documentation |
| `docs/HOT_RELOAD_AND_DEBUGGING.md` | Hot reload, on-device `logcat`, diagnosing "Not recognised", threshold tuning, emulator caveats | Technical Documentation |

> The **PPTX presentation is a mandatory deliverable** and is already built:
> `OfflineID_Hackathon7.pptx` (16 themed slides). Regenerate any time with
> `.venv/Scripts/python.exe scripts/build_pptx.py`. Open it once in PowerPoint/Google
> Slides to add your team names (slide 1) and tweak as you like.

---

## How to submit (registration form)

The form has two delivery slots, use both:

### 1. "Upload proposal (.zip/.rar, max 25 MB)"
Zip **this `submission/` folder** (after adding the exported `.pptx` and a demo-video
link). Do **not** include `node_modules`, `.git`, `.venv`, or build artifacts, those
go via the link below.

**Zip it (PowerShell, from repo root):**
```powershell
# Export PRESENTATION.md to PPTX first and drop it into submission/ as Presentation.pdf or .pptx
Compress-Archive -Path submission\* -DestinationPath OfflineID_Hackathon7_Proposal.zip -Force
"{0:N2} MB" -f ((Get-Item OfflineID_Hackathon7_Proposal.zip).Length / 1MB)   # confirm < 25 MB
```

**Filename rule (from the form):** *"Filename should not contain special characters
(^, &, %, .) except the extension dot."* So `OfflineID_Hackathon7_Proposal.zip` is valid
(underscores OK, no spaces, single dot before `zip`). Avoid `v1.0`, `&`, `%`, spaces.

### 2. "Link for the proposal"
A public link to the **full deliverable** that won't fit in 25 MB:
- **Working prototype source code** (this whole repo, open-source), push to GitHub.
- **Signed offline APK**, `app-release.apk` (see `03-BUILD-OFFLINE-APK.md`), attach to a
  GitHub Release or Drive folder.
- **Demo video** (≤ 3 min): enroll → live auth → spoof rejected → offline log → reconnect
  + sync. YouTube unlisted or Drive.

Recommended: one GitHub repo, with the APK + video on a tagged **Release**, and paste that
Release URL into the form.

### Other form fields
Name · Email (+verify) · Mobile · Team Leader name · Team Size · Captcha, fill as your team.

---

## Submission checklist

- [x] Themed **PPTX** built: `OfflineID_Hackathon7.pptx` (add team names on slide 1)
- [ ] Demo video recorded + link added (in `01-PROPOSAL.md` and the form link)
- [ ] Full source pushed to a **public** GitHub repo (open-source only, no paid licences)
- [ ] **Release** (offline) APK built and attached to repo Release, see `03-BUILD-OFFLINE-APK.md`
- [ ] Proposal zip built, **filename has no `^ & % .` except the `.zip`**, and is **< 25 MB**
- [ ] "Link for the proposal" = the GitHub Release URL
- [ ] Submit before **Last date: 5 June 2026** (official closure 05.06.2026)

---

## Brief compliance at a glance

| Constraint (brief) | Status |
|---|---|
| React Native, Android + iOS | RN ✅ · Android native engine ✅ (offline APK) · iOS native engine **written in Swift** (`ios/FaceEngine/`), Xcode build wiring pending (needs a Mac) |
| Model footprint ~20 MB | ✅ **9.1 MB** total model bundle |
| < 1 s recognise + liveness | ✅ ~51 ms host-CPU pipeline; sub-second on mid-range ARM |
| Android 8+ / iOS 12+, 3 GB RAM, no high-end GPU | ✅ CPU-only ONNX Runtime (XNNPACK/NNAPI) |
| > 95 % accuracy, Indian demographics, varied lighting | MobileFaceNet (LFW 99.5%) + inference-time normalisation + ambient-lux fill-light overlay (activates < 22 lux via TYPE_LIGHT sensor, configurable); field fine-tune = roadmap |
| Open-source only, share source | ✅ MIT-licensed stack, full source in repo |
| Offline liveness (blink/smile/turn) | ✅ passive FASNet + active gesture sequence |
| Sync & purge to AWS after reconnect | ✅ presigned-S3 batch sync + local purge |
