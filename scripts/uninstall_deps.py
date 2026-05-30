#!/usr/bin/env python3
"""Remove project deps, Android build caches, and optional toolchains."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


LOCAL_DEP_PATHS = [
    ROOT / ".venv",
    ROOT / "node_modules",
    ROOT / "android" / ".gradle",
    ROOT / "android" / "build",
    ROOT / "android" / "app" / "build",
    ROOT / "ios" / "Pods",
    ROOT / "vendor" / "bundle",
]
SCOOP_TOOLCHAIN = ["android-clt", "temurin17-jdk", "python312"]
WINGET_TOOLCHAIN = [
    "Google.AndroidStudio",
    "EclipseAdoptium.Temurin.17.JDK",
    "Python.Python.3.12",
]


def run(cmd: list[str], check: bool = False, cwd: Path = ROOT) -> None:
    print(f"> {' '.join(cmd)}")
    subprocess.run(cmd, cwd=cwd, check=check)


def ensure_inside_repo(path: Path) -> Path:
    resolved = path.resolve()
    resolved.relative_to(ROOT.resolve())
    return resolved


def remove_path(path: Path, dry_run: bool) -> None:
    if not path.exists():
        return
    target = ensure_inside_repo(path)
    if dry_run:
        print(f"Would remove {target}")
        return
    print(f"Removing {target}")
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()


def remove_user_path(path: Path, dry_run: bool) -> None:
    if not path.exists():
        return
    target = path.resolve()
    if dry_run:
        print(f"Would remove {target}")
        return
    print(f"Removing {target}")
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()


def remove_pycache(dry_run: bool) -> None:
    removed_roots = [path.resolve() for path in LOCAL_DEP_PATHS if path.exists()]
    for path in ROOT.rglob("__pycache__"):
        resolved = path.resolve()
        if any(resolved == root or root in resolved.parents for root in removed_roots):
            continue
        remove_path(path, dry_run)


def stop_gradle() -> None:
    gradlew = ROOT / "android" / "gradlew.bat"
    if gradlew.exists():
        run([str(gradlew), "--stop"], cwd=ROOT / "android")
        return
    run(["gradle", "--stop"])


def android_home_candidates() -> list[Path]:
    candidates: list[Path] = []
    for env_name in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        value = os.environ.get(env_name)
        if value:
            candidates.append(Path(value))
    candidates.extend(
        [
            Path.home() / "scoop" / "apps" / "android-clt" / "current",
            Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "Android" / "Sdk",
        ]
    )
    seen: set[Path] = set()
    unique: list[Path] = []
    for path in candidates:
        resolved = path.resolve()
        if resolved not in seen:
            seen.add(resolved)
            unique.append(path)
    return unique


def user_cache_paths(include_android_sdk: bool, include_scoop_sdk: bool) -> list[Path]:
    local = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    roaming = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    paths = [
        Path.home() / ".gradle" / "caches",
        Path.home() / ".gradle" / "wrapper" / "dists",
        Path.home() / ".gradle" / "daemon",
        Path.home() / ".gradle" / "native",
        Path.home() / ".android" / "build-cache",
        local / "Gradle",
        local / "Android" / "cache",
        roaming / "npm-cache",
    ]
    if include_android_sdk:
        for path in android_home_candidates():
            if not include_scoop_sdk and Path.home() / "scoop" in path.resolve().parents:
                continue
            paths.append(path)
    return paths


def purge_caches() -> None:
    run([sys.executable, "-m", "pip", "cache", "purge"])
    run(["npm", "cache", "clean", "--force"])
    stop_gradle()


def uninstall_toolchains(include_android_studio: bool) -> None:
    if shutil.which("scoop"):
        packages = [*SCOOP_TOOLCHAIN]
        if include_android_studio:
            packages.append("android-studio")
        run(["scoop", "uninstall", *packages])

    if shutil.which("winget"):
        packages = [*WINGET_TOOLCHAIN]
        if not include_android_studio:
            packages.remove("Google.AndroidStudio")
        for package in packages:
            run(["winget", "uninstall", "--id", package, "-e", "--silent"])


def main() -> None:
    parser = argparse.ArgumentParser(description="Uninstall local project dependencies.")
    parser.add_argument(
        "--full",
        action="store_true",
        help="Remove local deps, user caches, Android SDK, JDK/Python/Android toolchains, and Android Studio",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print what would be removed")
    parser.add_argument(
        "--purge-caches",
        action="store_true",
        help="Also clear user-level pip/npm caches and stop Gradle daemons",
    )
    parser.add_argument(
        "--include-user-caches",
        action="store_true",
        help="Remove Gradle, Android build, and npm cache folders under your user profile",
    )
    parser.add_argument(
        "--include-android-sdk",
        action="store_true",
        help="Also remove detected Android SDK folders such as android-clt/current or AppData/Local/Android/Sdk",
    )
    parser.add_argument(
        "--include-toolchains",
        action="store_true",
        help="Uninstall JDK 17, Python 3.12, and Android command-line tools from scoop/winget",
    )
    parser.add_argument(
        "--include-android-studio",
        action="store_true",
        help="With --include-toolchains, also uninstall Android Studio",
    )
    args = parser.parse_args()

    if args.full:
        args.purge_caches = True
        args.include_user_caches = True
        args.include_android_sdk = True
        args.include_toolchains = True
        args.include_android_studio = True

    for path in LOCAL_DEP_PATHS:
        remove_path(path, args.dry_run)
    remove_pycache(args.dry_run)

    if args.purge_caches and not args.dry_run:
        purge_caches()
    if args.include_toolchains:
        if args.dry_run:
            print("Would uninstall toolchains from scoop/winget")
        else:
            uninstall_toolchains(args.include_android_studio)
    if args.include_user_caches or args.include_android_sdk:
        for path in user_cache_paths(
            args.include_android_sdk,
            include_scoop_sdk=not args.include_toolchains,
        ):
            remove_user_path(path, args.dry_run)


if __name__ == "__main__":
    main()
