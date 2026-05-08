"""Tests for core.claude_bridge — ClaudeBridge class.

All subprocess spawning is mocked; no real 'claude' CLI is invoked.
"""

import asyncio
import time
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.claude_bridge import ClaudeBridge


# ---------------------------------------------------------------------------
# Helpers — fake subprocess objects
# ---------------------------------------------------------------------------


def _make_fake_process(returncode=None):
    """Create a fake asyncio.subprocess.Process.

    Args:
        returncode: None means the process is alive, any int means exited.
    """
    proc = MagicMock()
    proc.returncode = returncode
    proc.stdin = MagicMock()
    proc.stdin.write = MagicMock()
    proc.stdin.drain = AsyncMock()
    proc.stdout = MagicMock()
    proc.stdout.read = AsyncMock(return_value=b"")
    proc.stderr = MagicMock()
    proc.stderr.read = AsyncMock(return_value=b"")
    proc.kill = MagicMock()
    return proc


def _seed_session(bridge, session_id, sender_id, workspace="/ws", active=True, returncode=None):
    """Manually populate a bridge with a session for testing find/check."""
    proc = _make_fake_process(returncode=returncode)
    bridge.process_map[session_id] = proc
    bridge.session_meta[session_id] = {
        "senderId": sender_id,
        "cwd": workspace,
        "sessionId": session_id,
        "active": active,
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "lastActiveAt": datetime.now(timezone.utc).isoformat(),
        "messageCount": 0,
        "processAlive": True,
        "stashRef": None,
        "lockRelease": None,
    }
    return proc


# ---------------------------------------------------------------------------
# findActiveSession
# ---------------------------------------------------------------------------


class TestFindActiveSession:
    def test_returns_session_id_for_active_session(self):
        bridge = ClaudeBridge()
        _seed_session(bridge, "cc-100-abc123", "user1", active=True)
        assert bridge.findActiveSession("user1") == "cc-100-abc123"

    def test_returns_none_for_inactive_session(self):
        bridge = ClaudeBridge()
        _seed_session(bridge, "cc-100-abc123", "user1", active=False)
        assert bridge.findActiveSession("user1") is None

    def test_returns_none_for_unknown_sender(self):
        bridge = ClaudeBridge()
        _seed_session(bridge, "cc-100-abc123", "user1", active=True)
        assert bridge.findActiveSession("unknown") is None

    def test_returns_first_active_when_multiple_sessions(self):
        bridge = ClaudeBridge()
        _seed_session(bridge, "cc-100-aaa", "user1", active=False)
        _seed_session(bridge, "cc-101-bbb", "user1", active=True)
        result = bridge.findActiveSession("user1")
        assert result == "cc-101-bbb"

    def test_empty_bridge_returns_none(self):
        bridge = ClaudeBridge()
        assert bridge.findActiveSession("anyone") is None


# ---------------------------------------------------------------------------
# checkSessionAlive
# ---------------------------------------------------------------------------


class TestCheckSessionAlive:
    def test_alive_process_returns_true(self):
        bridge = ClaudeBridge()
        _seed_session(bridge, "cc-100-abc", "user1", returncode=None)
        result = bridge.checkSessionAlive("cc-100-abc")
        assert result == {"alive": True}

    def test_dead_process_cleans_up(self):
        bridge = ClaudeBridge()
        _seed_session(bridge, "cc-100-abc", "user1", returncode=0)
        result = bridge.checkSessionAlive("cc-100-abc")
        assert result == {"alive": False}
        # process_map and session_meta should be cleaned up
        assert "cc-100-abc" not in bridge.process_map
        assert "cc-100-abc" not in bridge.session_meta

    def test_missing_session_cleans_up(self):
        bridge = ClaudeBridge()
        # Insert only in session_meta, no process
        bridge.session_meta["cc-999-missing"] = {
            "senderId": "user1",
            "active": True,
            "lockRelease": None,
        }
        result = bridge.checkSessionAlive("cc-999-missing")
        assert result == {"alive": False}
        assert "cc-999-missing" not in bridge.session_meta

    def test_dead_process_releases_lock(self):
        bridge = ClaudeBridge()
        fake_lock = MagicMock()
        _seed_session(bridge, "cc-100-abc", "user1", returncode=0)
        bridge.session_meta["cc-100-abc"]["lockRelease"] = fake_lock

        with patch("core.claude_bridge.release_workspace_lock") as mock_release:
            bridge.checkSessionAlive("cc-100-abc")
            mock_release.assert_called_once_with(fake_lock)

    def test_missing_session_releases_lock(self):
        bridge = ClaudeBridge()
        fake_lock = MagicMock()
        bridge.session_meta["cc-999-missing"] = {
            "senderId": "user1",
            "active": True,
            "lockRelease": fake_lock,
        }
        # No entry in process_map

        with patch("core.claude_bridge.release_workspace_lock") as mock_release:
            bridge.checkSessionAlive("cc-999-missing")
            mock_release.assert_called_once_with(fake_lock)

    def test_lock_release_exception_is_swallowed(self):
        bridge = ClaudeBridge()
        fake_lock = MagicMock()
        _seed_session(bridge, "cc-100-abc", "user1", returncode=0)
        bridge.session_meta["cc-100-abc"]["lockRelease"] = fake_lock

        with patch("core.claude_bridge.release_workspace_lock", side_effect=RuntimeError("boom")):
            # Should not raise
            result = bridge.checkSessionAlive("cc-100-abc")
            assert result == {"alive": False}

    def test_missing_session_lock_release_exception_swallowed(self):
        bridge = ClaudeBridge()
        fake_lock = MagicMock()
        bridge.session_meta["cc-999-missing"] = {
            "senderId": "user1",
            "active": True,
            "lockRelease": fake_lock,
        }
        # No entry in process_map

        with patch("core.claude_bridge.release_workspace_lock", side_effect=RuntimeError("boom")):
            # Should not raise
            result = bridge.checkSessionAlive("cc-999-missing")
            assert result == {"alive": False}

    def test_nonzero_returncode_also_dead(self):
        bridge = ClaudeBridge()
        _seed_session(bridge, "cc-100-abc", "user1", returncode=137)
        result = bridge.checkSessionAlive("cc-100-abc")
        assert result == {"alive": False}
        assert "cc-100-abc" not in bridge.process_map


# ---------------------------------------------------------------------------
# spawnSession
# ---------------------------------------------------------------------------


class TestSpawnSession:
    @pytest.mark.asyncio
    async def test_creates_session_with_correct_metadata(self):
        bridge = ClaudeBridge()
        fake_proc = _make_fake_process(returncode=None)

        with patch("core.claude_bridge.acquire_workspace_lock", return_value=None), \
             patch("asyncio.create_subprocess_exec", return_value=fake_proc) as mock_exec:
            result = await bridge.spawnSession("user1", "/workspace", "hello")

        assert result["reused"] is False
        session_id = result["sessionId"]
        assert session_id.startswith("cc-")

        # Session ID format: cc-{timestamp}-{random6}
        parts = session_id.split("-")
        # "cc", <timestamp>, <random6>
        assert len(parts) == 3
        assert parts[0] == "cc"
        assert len(parts[2]) == 6
        assert parts[2].isalnum()

        # Verify metadata
        meta = bridge.session_meta[session_id]
        assert meta["senderId"] == "user1"
        assert meta["cwd"] == "/workspace"
        assert meta["active"] is True
        assert meta["messageCount"] == 0
        assert meta["processAlive"] is True
        assert meta["stashRef"] is None
        assert "startedAt" in meta
        assert "lastActiveAt" in meta

        # Verify process registered
        assert bridge.process_map[session_id] is fake_proc

        # Verify subprocess was launched correctly
        mock_exec.assert_awaited_once()
        call_args = mock_exec.call_args
        assert call_args.kwargs.get("cwd") == "/workspace" or call_args[1].get("cwd") == "/workspace"

    @pytest.mark.asyncio
    async def test_session_id_format_timestamp_random6(self):
        bridge = ClaudeBridge()
        fake_proc = _make_fake_process(returncode=None)

        with patch("core.claude_bridge.acquire_workspace_lock", return_value=None), \
             patch("asyncio.create_subprocess_exec", return_value=fake_proc):
            result = await bridge.spawnSession("user1", "/ws", "prompt")

        session_id = result["sessionId"]
        # cc-{ms_timestamp}-{6 alphanumeric chars}
        prefix, ts_str, rand = session_id.split("-", 2)
        assert prefix == "cc"
        assert ts_str.isdigit()
        assert len(rand) == 6
        assert rand.isalnum()

    @pytest.mark.asyncio
    async def test_existing_active_session_returns_reused(self):
        bridge = ClaudeBridge()
        _seed_session(bridge, "cc-100-existing", "user1", active=True)

        result = await bridge.spawnSession("user1", "/ws", "prompt")
        assert result == {"sessionId": "cc-100-existing", "reused": True}
        # No new process should be spawned
        assert len(bridge.process_map) == 1

    @pytest.mark.asyncio
    async def test_one_shot_prompt_adds_print_flag(self):
        bridge = ClaudeBridge()
        fake_proc = _make_fake_process(returncode=None)

        with patch("core.claude_bridge.acquire_workspace_lock", return_value=None), \
             patch("asyncio.create_subprocess_exec", return_value=fake_proc) as mock_exec:
            await bridge.spawnSession("user1", "/ws", "do something")

        # --print and the prompt string should be in the args
        call_args = mock_exec.call_args
        # First positional arg after "claude" is the program name in create_subprocess_exec
        args_list = call_args[0]  # positional args
        assert "--print" in args_list
        assert "do something" in args_list

    @pytest.mark.asyncio
    async def test_no_prompt_skips_print_flag(self):
        bridge = ClaudeBridge()
        fake_proc = _make_fake_process(returncode=None)

        with patch("core.claude_bridge.acquire_workspace_lock", return_value=None), \
             patch("asyncio.create_subprocess_exec", return_value=fake_proc) as mock_exec:
            await bridge.spawnSession("user1", "/ws", "")

        call_args = mock_exec.call_args
        args_list = call_args[0]
        assert "--print" not in args_list

    @pytest.mark.asyncio
    async def test_model_option_passed_through(self):
        bridge = ClaudeBridge()
        fake_proc = _make_fake_process(returncode=None)

        with patch("core.claude_bridge.acquire_workspace_lock", return_value=None), \
             patch("asyncio.create_subprocess_exec", return_value=fake_proc) as mock_exec:
            await bridge.spawnSession("user1", "/ws", "", {"model": "opus"})

        call_args = mock_exec.call_args
        args_list = call_args[0]
        assert "--model" in args_list
        idx = args_list.index("--model")
        assert args_list[idx + 1] == "opus"

    @pytest.mark.asyncio
    async def test_allowed_tools_option_passed_through(self):
        bridge = ClaudeBridge()
        fake_proc = _make_fake_process(returncode=None)

        with patch("core.claude_bridge.acquire_workspace_lock", return_value=None), \
             patch("asyncio.create_subprocess_exec", return_value=fake_proc) as mock_exec:
            await bridge.spawnSession("user1", "/ws", "", {"allowedTools": "Read,Write"})

        call_args = mock_exec.call_args
        args_list = call_args[0]
        assert "--allowedTools" in args_list
        idx = args_list.index("--allowedTools")
        assert args_list[idx + 1] == "Read,Write"

    @pytest.mark.asyncio
    async def test_env_includes_session_id(self):
        bridge = ClaudeBridge()
        fake_proc = _make_fake_process(returncode=None)

        with patch("core.claude_bridge.acquire_workspace_lock", return_value=None), \
             patch("asyncio.create_subprocess_exec", return_value=fake_proc) as mock_exec:
            result = await bridge.spawnSession("user1", "/ws", "")

        call_kwargs = mock_exec.call_args[1]
        env = call_kwargs.get("env", {})
        assert env.get("CLAUDE_SESSION_ID") == result["sessionId"]

    @pytest.mark.asyncio
    async def test_acquires_workspace_lock_on_spawn(self):
        bridge = ClaudeBridge()
        fake_proc = _make_fake_process(returncode=None)
        fake_lock = MagicMock()

        with patch("core.claude_bridge.acquire_workspace_lock", return_value=fake_lock) as mock_lock, \
             patch("asyncio.create_subprocess_exec", return_value=fake_proc):
            result = await bridge.spawnSession("user1", "/my/workspace", "")

        mock_lock.assert_called_once_with("/my/workspace")
        meta = bridge.session_meta[result["sessionId"]]
        assert meta["lockRelease"] is fake_lock

    @pytest.mark.asyncio
    async def test_starts_heartbeat_on_spawn(self):
        bridge = ClaudeBridge()
        fake_proc = _make_fake_process(returncode=None)

        with patch("core.claude_bridge.acquire_workspace_lock", return_value=None), \
             patch("asyncio.create_subprocess_exec", return_value=fake_proc):
            await bridge.spawnSession("user1", "/ws", "")

        assert bridge._heartbeat_task is not None

    @pytest.mark.asyncio
    async def test_inactive_session_not_reused(self):
        bridge = ClaudeBridge()
        _seed_session(bridge, "cc-100-inactive", "user1", active=False)
        fake_proc = _make_fake_process(returncode=None)

        with patch("core.claude_bridge.acquire_workspace_lock", return_value=None), \
             patch("asyncio.create_subprocess_exec", return_value=fake_proc):
            result = await bridge.spawnSession("user1", "/ws", "")

        assert result["reused"] is False
        assert result["sessionId"] != "cc-100-inactive"


# ---------------------------------------------------------------------------
# terminateSession
# ---------------------------------------------------------------------------


class TestTerminateSession:
    def test_kills_alive_process(self):
        bridge = ClaudeBridge()
        proc = _seed_session(bridge, "cc-100-abc", "user1", returncode=None)

        bridge.terminateSession("cc-100-abc")

        proc.kill.assert_called_once()

    def test_does_not_kill_dead_process(self):
        bridge = ClaudeBridge()
        proc = _seed_session(bridge, "cc-100-abc", "user1", returncode=0)

        bridge.terminateSession("cc-100-abc")

        proc.kill.assert_not_called()

    def test_sets_active_false(self):
        bridge = ClaudeBridge()
        _seed_session(bridge, "cc-100-abc", "user1", active=True)

        bridge.terminateSession("cc-100-abc")

        meta = bridge.session_meta.get("cc-100-abc")
        assert meta is not None
        assert meta["active"] is False

    def test_removes_from_process_map(self):
        bridge = ClaudeBridge()
        _seed_session(bridge, "cc-100-abc", "user1")

        bridge.terminateSession("cc-100-abc")

        assert "cc-100-abc" not in bridge.process_map

    def test_releases_workspace_lock(self):
        bridge = ClaudeBridge()
        fake_lock = MagicMock()
        _seed_session(bridge, "cc-100-abc", "user1")
        bridge.session_meta["cc-100-abc"]["lockRelease"] = fake_lock

        with patch("core.claude_bridge.release_workspace_lock") as mock_release:
            bridge.terminateSession("cc-100-abc")
            mock_release.assert_called_once_with(fake_lock)

    def test_lock_release_exception_swallowed(self):
        bridge = ClaudeBridge()
        fake_lock = MagicMock()
        _seed_session(bridge, "cc-100-abc", "user1")
        bridge.session_meta["cc-100-abc"]["lockRelease"] = fake_lock

        with patch("core.claude_bridge.release_workspace_lock", side_effect=RuntimeError("boom")):
            # Should not raise
            bridge.terminateSession("cc-100-abc")

    def test_lock_release_cleared_after_terminate(self):
        bridge = ClaudeBridge()
        fake_lock = MagicMock()
        _seed_session(bridge, "cc-100-abc", "user1")
        bridge.session_meta["cc-100-abc"]["lockRelease"] = fake_lock

        with patch("core.claude_bridge.release_workspace_lock"):
            bridge.terminateSession("cc-100-abc")

        assert bridge.session_meta["cc-100-abc"]["lockRelease"] is None

    def test_terminate_unknown_session_is_noop(self):
        bridge = ClaudeBridge()
        # Should not raise
        bridge.terminateSession("cc-nonexistent")

    def test_terminates_session_with_no_meta(self):
        bridge = ClaudeBridge()
        proc = _make_fake_process(returncode=None)
        bridge.process_map["cc-100-abc"] = proc
        # No session_meta entry

        bridge.terminateSession("cc-100-abc")

        proc.kill.assert_called_once()
        assert "cc-100-abc" not in bridge.process_map


# ---------------------------------------------------------------------------
# updateActivity
# ---------------------------------------------------------------------------


class TestUpdateActivity:
    def test_updates_last_active_at(self):
        bridge = ClaudeBridge()
        _seed_session(bridge, "cc-100-abc", "user1")
        old_time = bridge.session_meta["cc-100-abc"]["lastActiveAt"]

        # Small sleep to ensure timestamp differs
        import time as _time
        _time.sleep(0.01)

        bridge.updateActivity("cc-100-abc")

        new_time = bridge.session_meta["cc-100-abc"]["lastActiveAt"]
        assert new_time != old_time

    def test_increments_message_count(self):
        bridge = ClaudeBridge()
        _seed_session(bridge, "cc-100-abc", "user1")

        bridge.updateActivity("cc-100-abc")
        assert bridge.session_meta["cc-100-abc"]["messageCount"] == 1

        bridge.updateActivity("cc-100-abc")
        assert bridge.session_meta["cc-100-abc"]["messageCount"] == 2

    def test_unknown_session_is_noop(self):
        bridge = ClaudeBridge()
        # Should not raise
        bridge.updateActivity("cc-nonexistent")

    def test_message_count_starts_at_zero(self):
        bridge = ClaudeBridge()
        _seed_session(bridge, "cc-100-abc", "user1")
        assert bridge.session_meta["cc-100-abc"]["messageCount"] == 0


# ---------------------------------------------------------------------------
# startHeartbeat / stopHeartbeat
# ---------------------------------------------------------------------------


class TestHeartbeat:
    def test_start_heartbeat_creates_task(self):
        bridge = ClaudeBridge()
        assert bridge._heartbeat_task is None
        bridge.startHeartbeat()
        assert bridge._heartbeat_task is not None
        # Cleanup
        bridge.stopHeartbeat()

    def test_start_heartbeat_idempotent(self):
        bridge = ClaudeBridge()
        bridge.startHeartbeat()
        first_task = bridge._heartbeat_task
        bridge.startHeartbeat()
        assert bridge._heartbeat_task is first_task
        bridge.stopHeartbeat()

    @pytest.mark.asyncio
    async def test_stop_heartbeat_cancels_task(self):
        bridge = ClaudeBridge()
        bridge.startHeartbeat()
        task = bridge._heartbeat_task
        assert task is not None
        bridge.stopHeartbeat()
        assert bridge._heartbeat_task is None
        # Let the event loop process the cancellation
        await asyncio.sleep(0)
        assert task.cancelled() or task.done()

    def test_stop_heartbeat_when_none_is_noop(self):
        bridge = ClaudeBridge()
        bridge.stopHeartbeat()  # Should not raise

    @pytest.mark.asyncio
    async def test_heartbeat_terminates_dead_session(self):
        bridge = ClaudeBridge({"heartbeatInterval": 50, "sessionTimeout": 999999})
        _seed_session(bridge, "cc-100-dead", "user1", returncode=0)

        bridge.startHeartbeat()
        # Give the heartbeat loop a chance to run
        await asyncio.sleep(0.15)
        bridge.stopHeartbeat()

        meta = bridge.session_meta.get("cc-100-dead")
        if meta is not None:
            assert meta["active"] is False

    @pytest.mark.asyncio
    async def test_heartbeat_terminates_timed_out_session(self):
        bridge = ClaudeBridge({"heartbeatInterval": 50, "sessionTimeout": 100})
        # Set lastActiveAt far in the past
        old_ts = datetime(2000, 1, 1, tzinfo=timezone.utc).isoformat()
        _seed_session(bridge, "cc-100-old", "user1", returncode=None)
        bridge.session_meta["cc-100-old"]["lastActiveAt"] = old_ts

        bridge.startHeartbeat()
        await asyncio.sleep(0.15)
        bridge.stopHeartbeat()

        meta = bridge.session_meta.get("cc-100-old")
        if meta is not None:
            assert meta["active"] is False

    @pytest.mark.asyncio
    async def test_heartbeat_stops_when_no_active_sessions(self):
        bridge = ClaudeBridge({"heartbeatInterval": 50, "sessionTimeout": 999999})
        _seed_session(bridge, "cc-100-dead", "user1", returncode=0, active=True)

        bridge.startHeartbeat()
        await asyncio.sleep(0.2)

        # Heartbeat should have stopped itself because no active sessions remain
        assert bridge._heartbeat_task is None


# ---------------------------------------------------------------------------
# Constructor / options
# ---------------------------------------------------------------------------


class TestConstructor:
    def test_default_options(self):
        bridge = ClaudeBridge()
        assert bridge._heartbeat_interval == 60000
        assert bridge._session_timeout == 1800000
        assert bridge.process_map == {}
        assert bridge.session_meta == {}

    def test_custom_options(self):
        bridge = ClaudeBridge({
            "heartbeatInterval": 10000,
            "sessionTimeout": 60000,
        })
        assert bridge._heartbeat_interval == 10000
        assert bridge._session_timeout == 60000

    def test_none_options_treated_as_empty(self):
        bridge = ClaudeBridge(None)
        assert bridge._heartbeat_interval == 60000
