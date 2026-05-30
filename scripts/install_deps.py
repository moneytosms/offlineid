#!/usr/bin/env python3
"""
install_deps.py - one command to set up everything OfflineID needs.

What it can install:
  - System toolchain (--with-toolchain): JDK 17, Python 3.12, Node.js LTS, the Android
    command-line tools, and the Android SDK packages (platform 35, build-tools 35,
    NDK 26). Uses scoop if present, else winget.
  - Python deps: a local `.venv` with the model-export + tooling packages from
    scripts/requirements.txt (Torch pinned to the CPU wheel). Uses `uv` when available
    for speed/reliability, falling back to venv + pip.
  - Node deps: `npm install --legacy-peer-deps`.

Examples:
  python scripts/install_deps.py                 # python venv + npm only
  python scripts/install_deps.py --with-toolchain # also install JDK/Python/Node/Android SDK
  python scripts/install_deps.py --full           # clean, then toolchain + python + node
  python scripts/install_deps.py --no-uv          # force venv+pip instead of uv

Counterpart: scripts/uninstall_deps.py removes all of this.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REQ = ROOT / "scripts" / "requirements.txt"
VENV = ROOT / ".venv"

ANDROID_PACKAGES = [
    "platform-tools",
    "platforms;android-35",
    "build-tools;35.0.0",
    "ndk;26.1.10909125",
]
TORCH_CPU = ["torch==2.3.0", "--index-url", "https://download.pytorch.org/whl/cpu"]

# scoop apps (preferred on Windows). android-clt lives in the `extras` bucket,
# temurin in `java`.
SCOOP_BUCKETS = ["java", "extras"]
SCOOP_TOOLCHAIN = ["temurin17-jdk", "python312", "nodejs-lts", "android-clt"]
# winget package ids (fallback when scoop is absent).
WINGET_TOOLCHAIN = [
    "EclipseAdoptium.Temurin.17.JDK",
    "Python.Python.3.12",
    "OpenJS.NodeJS.LTS",
    "Google.AndroidStudio",  # bundles the Android SDK + cmdline-tools
]
WINGET_ARGS = ["-e", "--accept-source-agreements", "--accept-package-agreements"]


def run(cmd: list[str], cwd: Path = ROOT, input_text: str | None = None, check: bool = True) -> None:
    print(f"> {' '.join(cmd)}")
    subprocess.run(cmd, cwd=cwd, input=input_text, text=input_text is not None, check=check)


def existing(cmd: str) -> bool:
    return shutil.which(cmd) is not None


def scoop_prefix() -> Path:
    return Path.home() / "scoop" / "apps"


def android_home() -> Path:
    env_home = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if env_home:
        return Path(env_home)
    scoop_sdk = scoop_prefix() / "android-clt" / "current"
    if scoop_sdk.exists():
        return scoop_sdk
    return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "Android" / "Sdk"


def sdkmanager() -> Path:
    sdk = android_home()
    candidates = [
        sdk / "cmdline-tools" / "latest" / "bin" / "sdkmanager.bat",
        sdk / "cmdline-tools" / "bin" / "sdkmanager.bat",
        sdk / "tools" / "bin" / "sdkmanager.bat",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise FileNotFoundError(f"Could not find sdkmanager under {sdk}")


def write_local_properties() -> None:
    sdk = android_home()
    local_properties = ROOT / "android" / "local.properties"
    local_properties.write_text(f"sdk.dir={str(sdk).replace(chr(92), '/')}\n", encoding="utf-8")


def install_toolchain() -> None:
    if existing("scoop"):
        for bucket in SCOOP_BUCKETS:
            run(["scoop", "bucket", "add", bucket], check=False)
        run(["scoop", "install", *SCOOP_TOOLCHAIN])
    elif existing("winget"):
        for pkg in WINGET_TOOLCHAIN:
            run(["winget", "install", "--id", pkg, *WINGET_ARGS], check=False)
    else:
        raise RuntimeError("Install scoop or winget first, then rerun with --with-toolchain")

    sdk = sdkmanager()
    run([str(sdk), "--licenses"], input_text="y\n" * 100)
    run([str(sdk), *ANDROID_PACKAGES])
    write_local_properties()


def venv_python() -> Path:
    if os.name == "nt":
        return VENV / "Scripts" / "python.exe"
    return VENV / "bin" / "python"


def requirements_without_torch() -> list[str]:
    deps: list[str] = []
    for line in REQ.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.lower().startswith("torch"):
            continue
        deps.append(stripped)
    return deps


def ensure_uv() -> str | None:
    """Return a path to `uv`, installing it via scoop/winget/pip if missing."""
    uv = shutil.which("uv")
    if uv:
        return uv
    if existing("scoop"):
        run(["scoop", "install", "uv"], check=False)
    elif existing("winget"):
        run(["winget", "install", "--id", "astral-sh.uv", *WINGET_ARGS], check=False)
    if not shutil.which("uv"):
        run([sys.executable, "-m", "pip", "install", "--user", "uv"], check=False)
    return shutil.which("uv")


def install_python(use_uv: bool) -> None:
    if not REQ.exists():
        raise FileNotFoundError(f"Missing requirements file: {REQ}")

    uv = ensure_uv() if use_uv else None
    deps = requirements_without_torch()

    if uv:
        # uv: fast, reliable resolver. Torch from the CPU index, the rest from PyPI.
        run([uv, "venv", str(VENV)])
        py = str(venv_python())
        run([uv, "pip", "install", "--python", py, *TORCH_CPU])
        if deps:
            run([uv, "pip", "install", "--python", py, *deps])
        return

    # Fallback: stock venv + pip.
    if not VENV.exists():
        run([sys.executable, "-m", "venv", str(VENV)])
    py = str(venv_python())
    run([py, "-m", "pip", "install", "--upgrade", "pip"])
    run([py, "-m", "pip", "install", *TORCH_CPU])
    if deps:
        run([py, "-m", "pip", "install", *deps])


def install_node() -> None:
    if not (ROOT / "package.json").exists():
        return
    if not existing("npm"):
        print("! npm not found - install Node.js (rerun with --with-toolchain) then `npm install`")
        return
    run(["npm", "install", "--legacy-peer-deps"])


def clean_local() -> None:
    run([sys.executable, str(ROOT / "scripts" / "uninstall_deps.py")])


def main() -> None:
    parser = argparse.ArgumentParser(description="Install all project dependencies.")
    parser.add_argument(
        "--full",
        action="store_true",
        help="Clean local deps, install the toolchain, then Python and Node deps",
    )
    parser.add_argument("--clean", action="store_true", help="Remove local deps before installing")
    parser.add_argument(
        "--with-toolchain",
        action="store_true",
        help="Install JDK 17, Python 3.12, Node.js LTS, Android cmdline-tools + SDK packages",
    )
    parser.add_argument("--skip-python", action="store_true", help="Skip .venv setup")
    parser.add_argument("--skip-node", action="store_true", help="Skip npm install")
    parser.add_argument("--no-uv", action="store_true", help="Use venv + pip instead of uv")
    args = parser.parse_args()

    if args.full:
        args.clean = True
        args.with_toolchain = True

    if args.clean:
        clean_local()
    if args.with_toolchain:
        install_toolchain()
    if not args.skip_python:
        install_python(use_uv=not args.no_uv)
    if not args.skip_node:
        install_node()
    if (ROOT / "android").exists():
        write_local_properties()


if __name__ == "__main__":
    main()
