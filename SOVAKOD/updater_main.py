from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path


def wait_for_process(pid: int) -> None:
    try:
        import ctypes
        handle = ctypes.windll.kernel32.OpenProcess(0x00100000, False, pid)
        if handle:
            ctypes.windll.kernel32.WaitForSingleObject(handle, 10000)
            ctypes.windll.kernel32.CloseHandle(handle)
            return
    except (AttributeError, OSError):
        pass
    time.sleep(1)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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
        urllib.request.urlretrieve(args.url, archive)
        if args.sha256 and sha256(archive).lower() != args.sha256.lower():
            return 2
        extract_dir = Path(temp) / "payload"
        with zipfile.ZipFile(archive) as package:
            for member in package.infolist():
                destination = (extract_dir / member.filename).resolve()
                if extract_dir.resolve() not in destination.parents:
                    return 3
            package.extractall(extract_dir)
        for source in extract_dir.iterdir():
            destination = target / source.name
            if source.is_dir():
                shutil.copytree(source, destination, dirs_exist_ok=True)
            else:
                os.replace(source, destination)
    subprocess.Popen([args.launch], close_fds=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
