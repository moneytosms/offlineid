# scripts/

Helper scripts: dependency management, model export, benchmarking, and the slide deck.
Run them with the repo's Python (`.venv\Scripts\python.exe` on Windows, or system `python`).

---

## Dependency management

### `install_deps.py` - set up a machine

| Flag | Effect |
|---|---|
| _(none)_ | Create `.venv` with the Python deps + run `npm install --legacy-peer-deps` |
| `--with-toolchain` | Also install **JDK 17, Python 3.12, Node.js LTS, Android cmdline-tools + SDK** (platform 35, build-tools 35, NDK 26) via scoop (preferred) or winget |
| `--full` | `--clean` + `--with-toolchain` + python + node |
| `--clean` | Remove local deps first (calls `uninstall_deps.py`) |
| `--skip-python` / `--skip-node` | Skip that step |
| `--no-uv` | Use stock `venv` + `pip` instead of `uv` |

Details:
- Prefers [`uv`](https://github.com/astral-sh/uv) for the Python venv + installs (faster,
  reproducible); installs `uv` via scoop/winget/pip if missing, and falls back to `venv`+`pip`.
- Torch is always the **CPU wheel** (`download.pytorch.org/whl/cpu`) to avoid multi-GB GPU builds.
- Writes `android/local.properties` (`sdk.dir`) pointing at the detected Android SDK.

```bash
python scripts/install_deps.py                  # day-to-day: venv + npm
python scripts/install_deps.py --with-toolchain # fresh machine: also JDK/Python/Node/Android SDK
python scripts/install_deps.py --full           # clean + everything
```

### `uninstall_deps.py` - clean a machine

Layers (opt in; `--full` = all). **Always start with `--dry-run`.**

| Flag | Removes |
|---|---|
| _(none)_ | `.venv`, `node_modules`, Android/Gradle/Pods build dirs, `__pycache__` |
| `--purge-caches` | pip + npm caches; stops Gradle daemons |
| `--include-user-caches` | `~/.gradle` caches, Android build-cache, npm-cache |
| `--include-android-sdk` | the detected Android SDK folder(s) |
| `--include-toolchains` | uninstall **JDK 17, Python 3.12, Node.js LTS, uv, Android cmdline-tools** from scoop/winget |
| `--include-android-studio` | with `--include-toolchains`, also Android Studio |
| `--full` | everything above |
| `--dry-run` | print what would be removed, change nothing |

```bash
python scripts/uninstall_deps.py                   # just local build artifacts
python scripts/uninstall_deps.py --full --dry-run  # preview a complete wipe
python scripts/uninstall_deps.py --full            # remove everything this project added
```

> Safety: local paths are checked to be inside the repo before deletion; toolchain/SDK
> removal only runs under the explicit `--include-*` / `--full` flags.

---

## Model pipeline

The 4 final ONNX models are already committed in `android/app/src/main/assets/`. These
scripts only regenerate them (see `../docs/SETUP_AND_USAGE.md` §3 for acquiring source models).

| Script | Output |
|---|---|
| `export_scrfd.py` | `models/scrfd_500m_fixed.onnx` (fixed 640×640 input) |
| `export_mobilefacenet.py` | `models/mobilefacenet_int8.onnx` (INT8 dynamic quant) |
| `export_fasnet.py` | `models/fasnet_2_7.onnx` + `models/fasnet_4_0.onnx` |
| `validate_models.py` | runs each model, writes `../docs/BENCHMARKS.md` (size + latency) |

```bash
cd scripts
..\.venv\Scripts\python.exe export_scrfd.py
..\.venv\Scripts\python.exe export_mobilefacenet.py
..\.venv\Scripts\python.exe export_fasnet.py
..\.venv\Scripts\python.exe validate_models.py
```

---

## Presentation

| Script | Output |
|---|---|
| `build_pptx.py` | `../submission/OfflineID_Hackathon7.pptx` (16-slide themed deck) |
| `md_to_pdf.py` | render any Markdown to a clean PDF (e.g. `../submission/READMEFIRST.pdf`) |

```bash
.venv\Scripts\python.exe scripts/build_pptx.py
.venv\Scripts\python.exe scripts/md_to_pdf.py submission/READMEFIRST.md
```

---

## `requirements.txt`

Python deps for the model pipeline + deck: `onnx`, `onnxruntime`, `onnx-simplifier`,
`insightface`, `torch` (CPU), `opencv-python`, `numpy`, `scikit-image`, `python-pptx`,
`markdown`, `xhtml2pdf` (Markdown to PDF).
Installed by `install_deps.py` (Torch is pulled from the CPU index separately).
