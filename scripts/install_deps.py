#!/usr/bin/env python3
"""Install project dependencies and optional Android toolchain."""

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
SCOOP_TOOLCHAIN = ["temurin17-jdk", "python312", "android-clt"]


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
        run(["scoop", "bucket", "add", "java"], check=False)
        run(["scoop", "install", *SCOOP_TOOLCHAIN])
    elif existing("winget"):
        winget_args = ["--accept-source-agreements", "--accept-package-agreements"]
        run(["winget", "install", "--id", "EclipseAdoptium.Temurin.17.JDK", "-e", *winget_args])
        run(["winget", "install", "--id", "Python.Python.3.12", "-e", *winget_args])
        run(["winget", "install", "--id", "Google.AndroidStudio", "-e", *winget_args])
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


def install_python() -> None:
    if not REQ.exists():
        raise FileNotFoundError(f"Missing requirements file: {REQ}")

    if not VENV.exists():
        run([sys.executable, "-m", "venv", str(VENV)])

    py = str(venv_python())
    run([py, "-m", "pip", "install", "--upgrade", "pip"])

    # Keep Torch CPU-only. Default PyPI wheels can waste many GB on GPU builds.
    run(
        [
            py,
            "-m",
            "pip",
            "install",
            "torch==2.3.0",
            "--index-url",
            "https://download.pytorch.org/whl/cpu",
        ]
    )

    deps = requirements_without_torch()
    if deps:
        run([py, "-m", "pip", "install", *deps])


def install_node() -> None:
    if not (ROOT / "package.json").exists():
        return
    run(["npm", "install", "--legacy-peer-deps"])


def clean_local() -> None:
    run([sys.executable, str(ROOT / "scripts" / "uninstall_deps.py")])


def main() -> None:
    parser = argparse.ArgumentParser(description="Install all project dependencies.")
    parser.add_argument(
        "--full",
        action="store_true",
        help="Clean local deps, install Android toolchain, then install Python and Node deps",
    )
    parser.add_argument("--clean", action="store_true", help="Remove local deps before installing")
    parser.add_argument(
        "--with-toolchain",
        action="store_true",
        help="Install JDK 17, Python 3.12, Android command-line tools, and Android SDK packages",
    )
    parser.add_argument("--skip-python", action="store_true", help="Skip .venv setup")
    parser.add_argument("--skip-node", action="store_true", help="Skip npm install")
    args = parser.parse_args()

    if args.full:
        args.clean = True
        args.with_toolchain = True

    if args.clean:
        clean_local()
    if args.with_toolchain:
        install_toolchain()
    if not args.skip_python:
        install_python()
    if not args.skip_node:
        install_node()
    if (ROOT / "android").exists():
        write_local_properties()


if __name__ == "__main__":
    main()
