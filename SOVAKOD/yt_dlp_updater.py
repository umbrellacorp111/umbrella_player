from __future__ import annotations

import importlib.metadata
import json
import logging
import os
import re
import subprocess
import sys
import time
from pathlib import Path


CHECK_INTERVAL = 24 * 60 * 60
COMMAND_TIMEOUT = 20
PACKAGE = "yt-dlp"


def _version() -> str | None:
    try:
        return importlib.metadata.version("yt-dlp")
    except importlib.metadata.PackageNotFoundError:
        return None


def _read_state(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_state(path: Path, state: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=True), encoding="utf-8")
    os.replace(temporary, path)


def _latest_version() -> str | None:
    try:
        result = subprocess.run(
            [sys.executable, "-m", "pip", "index", "versions", PACKAGE,
             "--disable-pip-version-check"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=COMMAND_TIMEOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    for line in result.stdout.splitlines():
        match = re.search(r"\((\d+(?:\.\d+)+(?:[.-][0-9A-Za-z.-]+)?)\)", line)
        if match:
            return match.group(1)
        if line.lower().startswith("latest:"):
            return line.split(":", 1)[1].strip().split()[0]
    return None


def _acquire_lock(path: Path) -> int | None:
    try:
        return os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return None
    except OSError:
        return None


def _update() -> tuple[bool, str]:
    try:
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--upgrade", "--no-input",
             "--disable-pip-version-check", PACKAGE],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=COMMAND_TIMEOUT * 3,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError) as error:
        return False, str(error)
    if result.returncode != 0:
        return False, (result.stderr or result.stdout or "pip failed")[-1000:]
    return True, "updated"


def check_and_update(root: str | Path, storage: str | Path, logger: logging.Logger | None = None) -> str | None:
    """Best-effort daily update; never blocks startup on update failure."""
    logger = logger or logging.getLogger("umbrella")
    if getattr(sys, "frozen", False):
        logger.info("yt-dlp auto-update skipped in frozen build")
        return _version()

    storage_path = Path(storage)
    storage_path.mkdir(parents=True, exist_ok=True)
    state_path = storage_path / "yt_dlp_update.json"
    lock_path = storage_path / "yt_dlp_update.lock"
    current = _version()
    state = _read_state(state_path)
    now = time.time()
    if now - float(state.get("checked_at", 0) or 0) < CHECK_INTERVAL:
        return current

    lock_fd = _acquire_lock(lock_path)
    if lock_fd is None:
        logger.info("yt-dlp update is already running in another process")
        return current
    try:
        try:
            os.write(lock_fd, str(os.getpid()).encode("ascii"))
        finally:
            os.close(lock_fd)
        state["checked_at"] = now
        latest = _latest_version()
        state["latest"] = latest or ""
        if not latest or not current:
            _write_state(state_path, state)
            return current
        try:
            is_old = tuple(int(part) for part in current.split(".")[:3]) < tuple(int(part) for part in latest.split(".")[:3])
        except ValueError:
            is_old = current != latest
        if is_old:
            logger.info("Updating yt-dlp %s -> %s", current, latest)
            success, message = _update()
            state["updated_at"] = time.time() if success else state.get("updated_at", 0)
            state["update_error"] = "" if success else message
            if success:
                current = _version() or current
            else:
                logger.warning("yt-dlp update failed; keeping %s: %s", current, message)
        _write_state(state_path, state)
        return current
    finally:
        try:
            lock_path.unlink()
        except OSError:
            pass
