"""Tests for core.utils — atomic write, safe JSON load, file lock helpers."""

from __future__ import annotations

import json
import os

import pytest
from filelock import FileLock

from core.utils import (
    acquire_workspace_lock,
    atomic_write_sync,
    release_workspace_lock,
    safe_load_json,
)


# ---------------------------------------------------------------------------
# atomic_write_sync
# ---------------------------------------------------------------------------


class TestAtomicWriteSync:
    """Tests for atomic_write_sync."""

    def test_write_to_new_file(self, tmp_path: pytest.Path) -> None:
        """Writing to a new file creates the file with exact content."""
        target = str(tmp_path / "output.txt")
        atomic_write_sync(target, "hello world")
        assert os.path.exists(target)
        with open(target, "r", encoding="utf-8") as fh:
            assert fh.read() == "hello world"

    def test_overwrite_existing_file(self, tmp_path: pytest.Path) -> None:
        """Overwriting an existing file replaces its content."""
        target = str(tmp_path / "output.txt")
        # Write initial content
        atomic_write_sync(target, "first")
        # Overwrite
        atomic_write_sync(target, "second")
        with open(target, "r", encoding="utf-8") as fh:
            assert fh.read() == "second"

    def test_creates_parent_directories(self, tmp_path: pytest.Path) -> None:
        """Parent directories are created if they do not exist."""
        target = str(tmp_path / "deep" / "nested" / "dir" / "file.txt")
        atomic_write_sync(target, "nested content")
        assert os.path.exists(target)
        with open(target, "r", encoding="utf-8") as fh:
            assert fh.read() == "nested content"

    def test_content_is_exact(self, tmp_path: pytest.Path) -> None:
        """Written content matches the input exactly, including unicode."""
        target = str(tmp_path / "exact.txt")
        payload = '{"key": "value with émoji \U0001f680"}'
        atomic_write_sync(target, payload)
        with open(target, "r", encoding="utf-8") as fh:
            assert fh.read() == payload

    def test_no_tmp_file_left_behind(self, tmp_path: pytest.Path) -> None:
        """The .tmp file is cleaned up after a successful write."""
        target = str(tmp_path / "clean.txt")
        atomic_write_sync(target, "data")
        assert not os.path.exists(target + ".tmp")

    def test_overwrite_with_existing_tmp(self, tmp_path: pytest.Path) -> None:
        """Overwriting works even if a stale .tmp file exists."""
        target = str(tmp_path / "stale.txt")
        # Create a stale .tmp file
        with open(target + ".tmp", "w", encoding="utf-8") as fh:
            fh.write("stale")
        atomic_write_sync(target, "fresh")
        with open(target, "r", encoding="utf-8") as fh:
            assert fh.read() == "fresh"

    def test_empty_string_content(self, tmp_path: pytest.Path) -> None:
        """Writing an empty string creates a valid empty file."""
        target = str(tmp_path / "empty.txt")
        atomic_write_sync(target, "")
        with open(target, "r", encoding="utf-8") as fh:
            assert fh.read() == ""

    def test_multiline_content(self, tmp_path: pytest.Path) -> None:
        """Multiline content is preserved exactly."""
        target = str(tmp_path / "multi.txt")
        payload = "line1\nline2\nline3\n"
        atomic_write_sync(target, payload)
        with open(target, "r", encoding="utf-8") as fh:
            assert fh.read() == payload


# ---------------------------------------------------------------------------
# safe_load_json
# ---------------------------------------------------------------------------


class TestSafeLoadJson:
    """Tests for safe_load_json."""

    def test_valid_json_file(self, tmp_path: pytest.Path) -> None:
        """Valid JSON is loaded and returned."""
        fp = str(tmp_path / "valid.json")
        data = {"name": "test", "count": 42}
        with open(fp, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        assert safe_load_json(fp) == data

    def test_missing_file_returns_empty_dict(self, tmp_path: pytest.Path) -> None:
        """A missing file returns {} without raising."""
        fp = str(tmp_path / "nonexistent.json")
        result = safe_load_json(fp)
        assert result == {}

    def test_corrupt_json_returns_empty_dict(self, tmp_path: pytest.Path) -> None:
        """A file with invalid JSON returns {} without raising."""
        fp = str(tmp_path / "corrupt.json")
        with open(fp, "w", encoding="utf-8") as fh:
            fh.write("{invalid json!!!")
        assert safe_load_json(fp) == {}

    def test_empty_file_returns_empty_dict(self, tmp_path: pytest.Path) -> None:
        """An empty file returns {} without raising."""
        fp = str(tmp_path / "empty.json")
        with open(fp, "w", encoding="utf-8") as fh:
            pass  # write nothing
        assert safe_load_json(fp) == {}

    def test_json_array_returns_array(self, tmp_path: pytest.Path) -> None:
        """A JSON array is returned as-is (not coerced to dict)."""
        fp = str(tmp_path / "array.json")
        with open(fp, "w", encoding="utf-8") as fh:
            json.dump([1, 2, 3], fh)
        result = safe_load_json(fp)
        assert result == [1, 2, 3]

    def test_nested_json_structure(self, tmp_path: pytest.Path) -> None:
        """Deeply nested JSON is loaded correctly."""
        fp = str(tmp_path / "nested.json")
        data = {"a": {"b": {"c": [1, 2, {"d": True}]}}}
        with open(fp, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        assert safe_load_json(fp) == data

    def test_unreadable_file_returns_empty_dict(self, tmp_path: pytest.Path) -> None:
        """A file that cannot be read (permissions etc.) returns {}."""
        fp = str(tmp_path / "unreadable.json")
        # Write valid JSON, then make it a directory so open() fails
        with open(fp, "w", encoding="utf-8") as fh:
            json.dump({"x": 1}, fh)
        os.remove(fp)
        os.mkdir(fp)
        try:
            assert safe_load_json(fp) == {}
        finally:
            os.rmdir(fp)


# ---------------------------------------------------------------------------
# acquire_workspace_lock / release_workspace_lock
# ---------------------------------------------------------------------------


class TestWorkspaceLock:
    """Tests for acquire_workspace_lock and release_workspace_lock."""

    def test_acquire_creates_lock_file(self, tmp_path: pytest.Path) -> None:
        """Acquiring a lock creates the .cc-workspace.lock file."""
        workspace = str(tmp_path / "ws")
        os.makedirs(workspace)
        lock = acquire_workspace_lock(workspace)
        try:
            lock_path = os.path.join(workspace, ".cc-workspace.lock")
            assert os.path.exists(lock_path)
        finally:
            release_workspace_lock(lock)

    def test_acquire_and_release_cycle(self, tmp_path: pytest.Path) -> None:
        """A lock can be acquired and then released without error."""
        workspace = str(tmp_path / "ws")
        os.makedirs(workspace)
        lock = acquire_workspace_lock(workspace)
        release_workspace_lock(lock)
        # After release, we should be able to acquire again
        lock2 = acquire_workspace_lock(workspace)
        release_workspace_lock(lock2)

    def test_release_returns_filelock_instance(self, tmp_path: pytest.Path) -> None:
        """acquire_workspace_lock returns a FileLock instance."""
        workspace = str(tmp_path / "ws")
        os.makedirs(workspace)
        lock = acquire_workspace_lock(workspace)
        try:
            assert isinstance(lock, FileLock)
        finally:
            release_workspace_lock(lock)

    def test_double_release_no_error(self, tmp_path: pytest.Path) -> None:
        """Releasing a lock twice does not raise an error."""
        workspace = str(tmp_path / "ws")
        os.makedirs(workspace)
        lock = acquire_workspace_lock(workspace)
        release_workspace_lock(lock)
        # Second release should not raise
        release_workspace_lock(lock)

    def test_lock_path_is_correct(self, tmp_path: pytest.Path) -> None:
        """The lock file is placed at workspace/.cc-workspace.lock."""
        workspace = str(tmp_path / "ws")
        os.makedirs(workspace)
        lock = acquire_workspace_lock(workspace)
        try:
            expected = os.path.join(workspace, ".cc-workspace.lock")
            assert lock.lock_file == expected
        finally:
            release_workspace_lock(lock)
