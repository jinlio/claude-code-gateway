"""Utils — atomic file write, safe JSON load, file lock helpers, timestamp normalization.

Port of openclaw-plugin/src/core/utils.js.
See: cc-bridge-v3-final-plan.md Section 2.3
"""

import json
import logging
import os
import pathlib
from datetime import datetime, timezone
from typing import Any

from filelock import FileLock

logger = logging.getLogger(__name__)


def iso_timestamp() -> str:
    """Return ISO 8601 timestamp matching Node.js Date.toISOString() format (.000Z)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def atomic_write_sync(file_path: str, data: str) -> None:
    """Write data to a file atomically using a .tmp file then os.replace().

    On POSIX, os.replace() is atomic. On Windows it is best-effort
    (rename may fail if the target exists; we fall back to unlink + rename).
    """
    parent = pathlib.Path(file_path).parent
    if not parent.exists():
        parent.mkdir(parents=True, exist_ok=True)

    tmp_path = file_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as fh:
        fh.write(data)

    try:
        os.replace(tmp_path, file_path)
    except OSError:
        # Windows: os.replace may fail if the target file is locked or exists
        # Fall back to unlink + replace (not atomic, but functional)
        logger.warning("atomic_write os.replace failed, falling back to unlink+replace", exc_info=True)
        try:
            os.unlink(file_path)
        except FileNotFoundError:
            pass
        os.replace(tmp_path, file_path)


def safe_load_json(file_path: str) -> dict[str, Any]:
    """Load a JSON file, returning {} on any error (missing, corrupt, etc.)."""
    try:
        if os.path.exists(file_path):
            with open(file_path, "r", encoding="utf-8") as fh:
                return json.load(fh)
    except (json.JSONDecodeError, OSError):
        # File corrupt or unreadable
        pass
    return {}


def acquire_workspace_lock(workspace: str) -> FileLock:
    """Acquire a file-based lock on the workspace directory.

    Returns a FileLock instance; call release() on it to release.
    """
    lock_path = os.path.join(workspace, ".cc-workspace.lock")
    lock = FileLock(lock_path, timeout=30)
    lock.acquire()
    return lock


def release_workspace_lock(lock: FileLock) -> None:
    """Release a previously acquired workspace lock."""
    try:
        lock.release()
    except Exception:
        logger.warning("workspace lock release failed", exc_info=True)