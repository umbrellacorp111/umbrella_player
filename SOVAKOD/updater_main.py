from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path


def wait_for_process(pid: int, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    try:
        import ctypes
        from ctypes import wintypes

        handle = ctypes.windll.kernel32.OpenProcess(0x00100000, False, pid)
        if handle:
            try:
                while time.monotonic() < deadline:
                    remaining = int(max(0, (deadline - time.monotonic()) * 1000))
                    result = ctypes.windll.kernel32.WaitForSingleObject(handle, remaining if remaining else 1000)
                    if result != 258:  # WAIT_TIMEOUT
                        return
                    time.sleep(0.2)
                return
            finally:
                ctypes.windll.kernel32.CloseHandle(handle)
    except (AttributeError, OSError):
        pass
    # Fallback: poll liveness via kill(pid, 0) if available, else sleep
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except OSError:
            return
        except AttributeError:
            break
        time.sleep(0.4)
    time.sleep(0.4)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def replace_file_from_different_volume(source: Path, destination: Path) -> None:
    """Copy to the target volume first; os.replace cannot cross drive letters."""
    temporary = destination.with_name(f".{destination.name}.update.tmp")
    try:
        shutil.copy2(source, temporary)
        os.replace(temporary, destination)
    finally:
        try:
            temporary.unlink()
        except OSError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--install-dir", required=True)
    parser.add_argument("--launch", required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--sha256", default="")
    args = parser.parse_args()
    wait_for_process(args.pid)
    target = Path(args.install_dir).resolve()
    target.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="umbrella-update-") as temp:
        archive = Path(temp) / "update.zip"
        # Download with timeout and proper error handling
        req = urllib.request.Request(args.url, headers={"User-Agent": "UmbrellaPlayer-Updater/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp, archive.open("wb") as out:
                shutil.copyfileobj(resp, out)
        except OSError as exc:
            print(f"Download failed: {exc}", file=sys.stderr)
            return 2
        if args.sha256 and sha256(archive).lower() != args.sha256.lower():
            return 2
        extract_dir = Path(temp) / "payload"
        extract_dir.mkdir(parents=True, exist_ok=True)
        extract_root = extract_dir.resolve()
        with zipfile.ZipFile(archive) as package:
            # Validate ALL members before extracting (zip-slip protection)
            for member in package.infolist():
                destination = (extract_dir / member.filename).resolve()
                if extract_root not in destination.parents and destination != extract_root:
                    print(f"Blocked zip-slip entry: {member.filename}", file=sys.stderr)
                    return 3
            package.extractall(extract_dir)
        running_updater = Path(sys.executable).resolve()
        for source in extract_dir.iterdir():
            destination = target / source.name
            # Windows locks the updater while it is running. Keep the current
            # updater for this cycle; the next installer release can replace it.
            if destination.resolve() == running_updater:
                continue
            if source.is_dir():
                shutil.copytree(source, destination, dirs_exist_ok=True)
            else:
                replace_file_from_different_volume(source, destination)
    # close_fds not valid with CREATE_NO_WINDOW on Windows; use platform-safe flags
    popen_kwargs: dict = {}
    if sys.platform == "win32":
        popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    else:
        popen_kwargs["close_fds"] = True
    subprocess.Popen([args.launch], **popen_kwargs)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
