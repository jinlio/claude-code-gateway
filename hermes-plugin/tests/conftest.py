"""Shared test fixtures for Hermes CC Bridge plugin tests."""

from __future__ import annotations

import os
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

# Ensure the plugin root is on sys.path so `core.*` imports work
plugin_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if plugin_root not in sys.path:
    sys.path.insert(0, plugin_root)


@pytest.fixture
def fake_process():
    """Return a mock asyncio subprocess.Process that appears alive."""
    proc = MagicMock()
    proc.returncode = None
    proc.stdin = AsyncMock()
    proc.stdout = AsyncMock()
    proc.stdout.read = AsyncMock(return_value=b"")
    proc.stderr = AsyncMock()
    proc.stderr.read = AsyncMock(return_value=b"")
    proc.wait = AsyncMock(return_value=0)
    proc.kill = MagicMock()
    return proc


@pytest.fixture
def fake_dead_process():
    """Return a mock subprocess.Process that has exited."""
    proc = MagicMock()
    proc.returncode = 0
    proc.stdin = AsyncMock()
    proc.stdout = AsyncMock()
    proc.stderr = AsyncMock()
    proc.wait = AsyncMock(return_value=0)
    proc.kill = MagicMock()
    return proc


@pytest.fixture
def fake_bridge(fake_process):
    """Return a mock ClaudeBridge with a pre-populated session."""
    from core.claude_bridge import ClaudeBridge

    bridge = ClaudeBridge()
    session_id = "cc-1709123456789-abc123"
    bridge.process_map[session_id] = fake_process
    bridge.session_meta[session_id] = {
        "senderId": "user1",
        "cwd": "/tmp/workspace",
        "sessionId": session_id,
        "active": True,
        "startedAt": "2026-05-08T10:00:00.000000+00:00",
        "lastActiveAt": "2026-05-08T10:30:00.000000+00:00",
        "messageCount": 5,
        "processAlive": True,
        "stashRef": f"CC-snapshot-{session_id}-1709123456789",
        "lockRelease": None,
    }
    return bridge


@pytest.fixture
def sample_session_meta():
    """Return a sample session metadata dict."""
    return {
        "senderId": "user1",
        "cwd": "/tmp/workspace",
        "sessionId": "cc-1709123456789-abc123",
        "active": True,
        "startedAt": "2026-05-08T10:00:00.000000+00:00",
        "lastActiveAt": "2026-05-08T10:30:00.000000+00:00",
        "messageCount": 5,
        "processAlive": True,
        "stashRef": "CC-snapshot-cc-1709123456789-abc123-1709123456789",
    }
