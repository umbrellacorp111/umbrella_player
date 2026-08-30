from __future__ import annotations

import hashlib
import json
import logging
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

from app_version import APP_VERSION, UPDATE_MANIFEST_URL


def _version_key(value: str) -> tuple[int, ...]:
    try:
        return tuple(int(part) for part in value.lstrip("v").split(".")[:4])
    except ValueError:
        return (0,)


def fetch_update() -> dict | None:
    try:
        request = urllib.request.Request(UPDATE_MANIFEST_URL, headers={"User-Agent": "UmbrellaPlayer/1.0"})
        with urllib.request.urlopen(request, timeout=8) as response:
            value = json.loads(response.read().decode("utf-8"))
        version = str(value.get("version") or value.get("tag_name", "")).lstrip("v")
        assets = value.get("assets") or []
        package = next((item for item in assets if str(item.get("name", "")).endswith(".zip")), None)
        checksum = next((item for item in assets if str(item.get("name", "")).endswith(".sha256")), None)
        if not package or not version or _version_key(version) <= _version_key(APP_VERSION):
            return None
        digest = ""
        if checksum and checksum.get("browser_download_url"):
            try:
                c_url = str(checksum["browser_download_url"])
                c_req = urllib.request.Request(c_url, headers={"User-Agent": "UmbrellaPlayer/1.0"})
                with urllib.request.urlopen(c_req, timeout=8) as response:
                    digest = response.read().decode("ascii", "ignore").strip().split()[0]
            except OSError:
                logging.getLogger("umbrella").warning("Checksum download failed, continuing without digest")
                digest = ""
        pkg_url = package.get("browser_download_url") if isinstance(package, dict) else None
        if not pkg_url:
            logging.getLogger("umbrella").warning("fetch_update: missing browser_download_url in asset %r", package)
            return None
        return {
            "version": version,
            "packageUrl": pkg_url,
            "sha256": digest,
            "releaseNotes": value.get("body", ""),
        }
    except (OSError, ValueError, KeyError, IndexError, json.JSONDecodeError) as exc:
        logging.getLogger("umbrella").debug("fetch_update failed: %s", exc)
        return None


def launch_update(manifest: dict, logger: logging.Logger | None = None) -> bool:
    logger = logger or logging.getLogger("umbrella")
    if not getattr(sys, "frozen", False):
        return False
    updater = Path(sys.executable).with_name("Umbrella Player Updater.exe")
    if not updater.is_file():
        logger.warning("Updater binary is missing: %s", updater)
        return False
    popen_kwargs: dict = {}
    if sys.platform == "win32":
        popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    else:
        popen_kwargs["close_fds"] = True
    try:
        subprocess.Popen([
            str(updater), "--pid", str(os.getpid()),
            "--install-dir", str(Path(sys.executable).resolve().parent),
            "--launch", str(Path(sys.executable).resolve()),
            "--url", str(manifest["packageUrl"]),
            "--sha256", str(manifest.get("sha256", "")),
        ], **popen_kwargs)
        return True
    except OSError:
        logger.exception("Could not start application updater")
        return False


def verify_sha256(path: Path, expected: str) -> bool:
    if not expected:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().lower() == expected.lower()
