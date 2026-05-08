"""Tests for GitSnapshot — stash-based snapshot and rollback.

All git subprocess calls are mocked via _git_exec / _git_exec_output /
_git_exec_static / _git_exec_output_static; no real git CLI is invoked.
"""

from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.git_snapshot import SESSION_ID_REGEX, GitSnapshot


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class FakeBridge:
    """Minimal bridge mock with session_meta dict."""

    def __init__(self, cwd="/tmp/workspace"):
        self.session_meta = {}
        self.cwd = cwd


def _make_bridge_with_session(session_id="cc-1709123456789-abc123", cwd="/tmp/workspace"):
    bridge = FakeBridge(cwd)
    bridge.session_meta[session_id] = {
        "senderId": "user1",
        "cwd": cwd,
        "sessionId": session_id,
        "active": True,
        "stashRef": None,
    }
    return bridge


# ---------------------------------------------------------------------------
# SESSION_ID_REGEX
# ---------------------------------------------------------------------------


class TestSessionIdRegex:
    """Test the SESSION_ID_REGEX pattern."""

    def test_matches_valid_stash_ref(self):
        line = "stash@{0}: On main: CC-snapshot-cc-1709123456789-abc123-1709123456789"
        match = SESSION_ID_REGEX.search(line)
        assert match is not None
        assert match.group(1) == "cc-1709123456789-abc123"
        assert match.group(2) == "1709123456789"

    def test_no_match_regular_stash(self):
        line = "stash@{0}: On main: WIP on main: abc123 some message"
        assert SESSION_ID_REGEX.search(line) is None

    def test_no_match_empty_string(self):
        assert SESSION_ID_REGEX.search("") is None

    def test_matches_at_any_position_in_line(self):
        line = "some prefix CC-snapshot-cc-1234567890123-xyz999-9999999999999 suffix"
        match = SESSION_ID_REGEX.search(line)
        assert match is not None
        assert match.group(1) == "cc-1234567890123-xyz999"

    def test_no_match_for_partial_prefix(self):
        # "CC-snapshot-" is present but the remainder does not match the
        # cc-<digits>-<alphanum>-<digits> pattern required by the regex.
        line = "stash@{0}: On main: CC-snapshot-badformat-no-timestamp"
        assert SESSION_ID_REGEX.search(line) is None


# ---------------------------------------------------------------------------
# create()
# ---------------------------------------------------------------------------


class TestGitSnapshotCreate:
    """Test GitSnapshot.create()."""

    @pytest.mark.asyncio
    async def test_create_success(self):
        bridge = _make_bridge_with_session()
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        with patch.object(snapshot, "_git_exec", new_callable=AsyncMock):
            result = await snapshot.create()

        assert result is True
        meta = bridge.session_meta["cc-1709123456789-abc123"]
        assert meta["stashRef"] is not None
        assert "CC-snapshot-cc-1709123456789-abc123-" in meta["stashRef"]

    @pytest.mark.asyncio
    async def test_create_no_meta(self):
        bridge = FakeBridge()
        snapshot = GitSnapshot(bridge, "nonexistent-session")
        result = await snapshot.create()
        assert result is False

    @pytest.mark.asyncio
    async def test_create_git_failure(self):
        bridge = _make_bridge_with_session()
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        async def _fail(cmd, cwd):
            raise RuntimeError("git failed")

        with patch.object(snapshot, "_git_exec", side_effect=_fail):
            result = await snapshot.create()

        assert result is False

    @pytest.mark.asyncio
    async def test_create_sanitizes_stash_ref(self):
        bridge = _make_bridge_with_session(session_id="cc-1234-a;b")
        snapshot = GitSnapshot(bridge, "cc-1234-a;b")

        with patch.object(snapshot, "_git_exec", new_callable=AsyncMock):
            await snapshot.create()

        meta = bridge.session_meta["cc-1234-a;b"]
        # Semicolons should be replaced with underscores
        assert ";" not in meta["stashRef"]

    @pytest.mark.asyncio
    async def test_create_git_add_then_stash_push(self):
        bridge = _make_bridge_with_session()
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        with patch.object(snapshot, "_git_exec", new_callable=AsyncMock) as mock_exec:
            await snapshot.create()

        assert mock_exec.call_count == 2
        first_cmd = mock_exec.call_args_list[0].args[0]
        second_cmd = mock_exec.call_args_list[1].args[0]
        assert "git add -A" in first_cmd
        assert "git stash push" in second_cmd

    @pytest.mark.asyncio
    async def test_create_git_add_failure_returns_false(self):
        bridge = _make_bridge_with_session()
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        async def _fail_on_add(cmd, cwd):
            if "git add" in cmd:
                raise RuntimeError("git add failed")

        with patch.object(snapshot, "_git_exec", new_callable=AsyncMock, side_effect=_fail_on_add):
            result = await snapshot.create()

        assert result is False

    @pytest.mark.asyncio
    async def test_create_stash_push_failure_returns_false(self):
        bridge = _make_bridge_with_session()
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        async def _fail_on_stash(cmd, cwd):
            if "git stash" in cmd:
                raise RuntimeError("git stash failed")

        with patch.object(snapshot, "_git_exec", new_callable=AsyncMock, side_effect=_fail_on_stash):
            result = await snapshot.create()

        assert result is False

    @pytest.mark.asyncio
    async def test_create_stash_ref_not_set_on_failure(self):
        bridge = _make_bridge_with_session()
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        with patch.object(snapshot, "_git_exec", new_callable=AsyncMock, side_effect=RuntimeError("fail")):
            await snapshot.create()

        meta = bridge.session_meta["cc-1709123456789-abc123"]
        assert meta.get("stashRef") is None

    @pytest.mark.asyncio
    async def test_create_cwd_passed_from_meta(self):
        bridge = _make_bridge_with_session(cwd="/custom/workspace")
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        with patch.object(snapshot, "_git_exec", new_callable=AsyncMock) as mock_exec:
            await snapshot.create()

        for call in mock_exec.call_args_list:
            assert call.kwargs.get("cwd") == "/custom/workspace" or call.args[1] == "/custom/workspace"


# ---------------------------------------------------------------------------
# revert()
# ---------------------------------------------------------------------------


class TestGitSnapshotRevert:
    """Test GitSnapshot.revert()."""

    @pytest.mark.asyncio
    async def test_revert_success(self):
        bridge = _make_bridge_with_session()
        stash_ref = "CC-snapshot-cc-1709123456789-abc123-1709123456789"
        bridge.session_meta["cc-1709123456789-abc123"]["stashRef"] = stash_ref
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        stash_list = f"stash@{{0}}: On main: {stash_ref}"
        with (
            patch.object(snapshot, "_git_exec_output", new_callable=AsyncMock, return_value=stash_list),
            patch.object(snapshot, "_git_exec", new_callable=AsyncMock),
        ):
            result = await snapshot.revert()

        assert result["success"] is True
        assert bridge.session_meta["cc-1709123456789-abc123"]["stashRef"] is None

    @pytest.mark.asyncio
    async def test_revert_no_meta(self):
        bridge = FakeBridge()
        snapshot = GitSnapshot(bridge, "nonexistent")
        result = await snapshot.revert()
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_revert_no_stash_ref(self):
        bridge = _make_bridge_with_session()
        bridge.session_meta["cc-1709123456789-abc123"]["stashRef"] = None
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")
        result = await snapshot.revert()
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_revert_snapshot_not_found_in_list(self):
        bridge = _make_bridge_with_session()
        bridge.session_meta["cc-1709123456789-abc123"]["stashRef"] = "CC-snapshot-old"
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        stash_list = "stash@{0}: On main: some other stash"
        with patch.object(snapshot, "_git_exec_output", new_callable=AsyncMock, return_value=stash_list):
            result = await snapshot.revert()

        assert result["success"] is False
        assert "missing" in result["message"].lower() or "not found" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_revert_git_apply_failure(self):
        bridge = _make_bridge_with_session()
        stash_ref = "CC-snapshot-cc-1709123456789-abc123-1709123456789"
        bridge.session_meta["cc-1709123456789-abc123"]["stashRef"] = stash_ref
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        stash_list = f"stash@{{0}}: On main: {stash_ref}"

        async def _git_exec_side_effect(cmd, cwd):
            if "stash apply" in cmd:
                raise RuntimeError("conflict")

        with (
            patch.object(snapshot, "_git_exec_output", new_callable=AsyncMock, return_value=stash_list),
            patch.object(snapshot, "_git_exec", side_effect=_git_exec_side_effect),
        ):
            result = await snapshot.revert()

        assert result["success"] is False
        assert "Rollback failed" in result["message"]

    @pytest.mark.asyncio
    async def test_revert_applies_correct_stash_index(self):
        bridge = _make_bridge_with_session()
        stash_ref = "CC-snapshot-cc-1709123456789-abc123-1709123456789"
        bridge.session_meta["cc-1709123456789-abc123"]["stashRef"] = stash_ref
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        # Target stash is at index 2
        stash_list = (
            "stash@{0}: On main: other-stash\n"
            "stash@{1}: On main: another-stash\n"
            f"stash@{{2}}: On main: {stash_ref}"
        )
        with (
            patch.object(snapshot, "_git_exec_output", new_callable=AsyncMock, return_value=stash_list),
            patch.object(snapshot, "_git_exec", new_callable=AsyncMock) as mock_exec,
        ):
            result = await snapshot.revert()

        assert result["success"] is True
        apply_calls = [c for c in mock_exec.call_args_list if "stash apply" in str(c)]
        assert len(apply_calls) == 1
        assert "stash@{2}" in apply_calls[0].args[0]

    @pytest.mark.asyncio
    async def test_revert_checkout_and_clean_before_apply(self):
        bridge = _make_bridge_with_session()
        stash_ref = "CC-snapshot-cc-1709123456789-abc123-1709123456789"
        bridge.session_meta["cc-1709123456789-abc123"]["stashRef"] = stash_ref
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        stash_list = f"stash@{{0}}: On main: {stash_ref}"
        with (
            patch.object(snapshot, "_git_exec_output", new_callable=AsyncMock, return_value=stash_list),
            patch.object(snapshot, "_git_exec", new_callable=AsyncMock) as mock_exec,
        ):
            await snapshot.revert()

        cmds = [c.args[0] for c in mock_exec.call_args_list]
        assert "git checkout -- ." in cmds
        assert "git clean -fd" in cmds

    @pytest.mark.asyncio
    async def test_revert_checkout_failure_is_ignored(self):
        """Covers lines 71-72: the except block for git checkout failure."""
        bridge = _make_bridge_with_session()
        stash_ref = "CC-snapshot-cc-1709123456789-abc123-1709123456789"
        bridge.session_meta["cc-1709123456789-abc123"]["stashRef"] = stash_ref
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        stash_list = f"stash@{{0}}: On main: {stash_ref}"

        async def _selective_fail(cmd, cwd):
            if "checkout" in cmd:
                raise RuntimeError("checkout failed")
            # Other commands succeed silently

        with (
            patch.object(snapshot, "_git_exec_output", new_callable=AsyncMock, return_value=stash_list),
            patch.object(snapshot, "_git_exec", new_callable=AsyncMock, side_effect=_selective_fail),
        ):
            result = await snapshot.revert()

        # Should still succeed despite checkout failure
        assert result["success"] is True

    @pytest.mark.asyncio
    async def test_revert_clean_failure_is_ignored(self):
        """Covers lines 75-76: the except block for git clean failure."""
        bridge = _make_bridge_with_session()
        stash_ref = "CC-snapshot-cc-1709123456789-abc123-1709123456789"
        bridge.session_meta["cc-1709123456789-abc123"]["stashRef"] = stash_ref
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        stash_list = f"stash@{{0}}: On main: {stash_ref}"

        async def _selective_fail(cmd, cwd):
            if "clean" in cmd:
                raise RuntimeError("clean failed")

        with (
            patch.object(snapshot, "_git_exec_output", new_callable=AsyncMock, return_value=stash_list),
            patch.object(snapshot, "_git_exec", new_callable=AsyncMock, side_effect=_selective_fail),
        ):
            result = await snapshot.revert()

        assert result["success"] is True

    @pytest.mark.asyncio
    async def test_revert_empty_stash_ref_treated_as_missing(self):
        bridge = _make_bridge_with_session()
        bridge.session_meta["cc-1709123456789-abc123"]["stashRef"] = ""
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        result = await snapshot.revert()
        assert result["success"] is False
        assert "No matching snapshot" in result["message"]


# ---------------------------------------------------------------------------
# dropStash()
# ---------------------------------------------------------------------------


class TestGitSnapshotDropStash:
    """Test GitSnapshot.dropStash()."""

    @pytest.mark.asyncio
    async def test_drop_success(self):
        bridge = _make_bridge_with_session()
        stash_ref = "CC-snapshot-cc-1709123456789-abc123-1709123456789"
        bridge.session_meta["cc-1709123456789-abc123"]["stashRef"] = stash_ref
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        stash_list = f"stash@{{0}}: On main: {stash_ref}"
        with (
            patch.object(snapshot, "_git_exec_output", new_callable=AsyncMock, return_value=stash_list),
            patch.object(snapshot, "_git_exec", new_callable=AsyncMock),
        ):
            result = await snapshot.dropStash()

        assert result["success"] is True
        assert bridge.session_meta["cc-1709123456789-abc123"]["stashRef"] is None

    @pytest.mark.asyncio
    async def test_drop_no_meta(self):
        bridge = FakeBridge()
        snapshot = GitSnapshot(bridge, "nonexistent")
        result = await snapshot.dropStash()
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_drop_no_stash_ref(self):
        bridge = _make_bridge_with_session()
        bridge.session_meta["cc-1709123456789-abc123"]["stashRef"] = None
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")
        result = await snapshot.dropStash()
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_drop_snapshot_not_found(self):
        bridge = _make_bridge_with_session()
        bridge.session_meta["cc-1709123456789-abc123"]["stashRef"] = "CC-snapshot-missing"
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        stash_list = "stash@{0}: On main: other stash"
        with patch.object(snapshot, "_git_exec_output", new_callable=AsyncMock, return_value=stash_list):
            result = await snapshot.dropStash()

        assert result["success"] is False
        # stashRef should be cleared even when snapshot is missing
        assert bridge.session_meta["cc-1709123456789-abc123"]["stashRef"] is None

    @pytest.mark.asyncio
    async def test_drop_git_failure(self):
        bridge = _make_bridge_with_session()
        stash_ref = "CC-snapshot-cc-1709123456789-abc123-1709123456789"
        bridge.session_meta["cc-1709123456789-abc123"]["stashRef"] = stash_ref
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        stash_list = f"stash@{{0}}: On main: {stash_ref}"

        async def _fail_on_drop(cmd, cwd):
            if "stash drop" in cmd:
                raise RuntimeError("drop failed")

        with (
            patch.object(snapshot, "_git_exec_output", new_callable=AsyncMock, return_value=stash_list),
            patch.object(snapshot, "_git_exec", side_effect=_fail_on_drop),
        ):
            result = await snapshot.dropStash()

        assert result["success"] is False
        assert "Drop failed" in result["message"]

    @pytest.mark.asyncio
    async def test_drop_correct_index(self):
        bridge = _make_bridge_with_session()
        stash_ref = "CC-snapshot-cc-1709123456789-abc123-1709123456789"
        bridge.session_meta["cc-1709123456789-abc123"]["stashRef"] = stash_ref
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        stash_list = (
            "stash@{0}: On main: other-stash\n"
            f"stash@{{1}}: On main: {stash_ref}"
        )
        with (
            patch.object(snapshot, "_git_exec_output", new_callable=AsyncMock, return_value=stash_list),
            patch.object(snapshot, "_git_exec", new_callable=AsyncMock) as mock_exec,
        ):
            await snapshot.dropStash()

        drop_calls = [c for c in mock_exec.call_args_list if "stash drop" in str(c)]
        assert len(drop_calls) == 1
        assert "stash@{1}" in drop_calls[0].args[0]

    @pytest.mark.asyncio
    async def test_drop_empty_stash_ref_treated_as_missing(self):
        bridge = _make_bridge_with_session()
        bridge.session_meta["cc-1709123456789-abc123"]["stashRef"] = ""
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        result = await snapshot.dropStash()
        assert result["success"] is False


# ---------------------------------------------------------------------------
# cleanupOldStashes()
# ---------------------------------------------------------------------------


class TestCleanupOldStashes:
    """Test GitSnapshot.cleanupOldStashes()."""

    @pytest.mark.asyncio
    async def test_removes_old_inactive_stash(self):
        bridge = FakeBridge()
        old_ts = int(time.time() * 1000) - 8 * 24 * 3600000  # 8 days ago
        old_session_id = "cc-1000000000000-old123"
        stash_list = f"stash@{{0}}: On main: CC-snapshot-{old_session_id}-{old_ts}"

        with (
            patch("core.git_snapshot.GitSnapshot._git_exec_output_static", new_callable=AsyncMock, return_value=stash_list),
            patch("core.git_snapshot.GitSnapshot._git_exec_static", new_callable=AsyncMock) as mock_exec,
        ):
            await GitSnapshot.cleanupOldStashes(bridge, "/tmp/workspace")
            mock_exec.assert_awaited_once()
            assert "stash@{0}" in mock_exec.call_args.args[0]

    @pytest.mark.asyncio
    async def test_keeps_active_session_stash(self):
        session_id = "cc-1709123456789-active1"
        bridge = FakeBridge()
        bridge.session_meta[session_id] = {"active": True, "cwd": "/tmp/workspace"}
        old_ts = int(time.time() * 1000) - 8 * 24 * 3600000
        stash_list = f"stash@{{0}}: On main: CC-snapshot-{session_id}-{old_ts}"

        with (
            patch("core.git_snapshot.GitSnapshot._git_exec_output_static", new_callable=AsyncMock, return_value=stash_list),
            patch("core.git_snapshot.GitSnapshot._git_exec_static", new_callable=AsyncMock) as mock_exec,
        ):
            await GitSnapshot.cleanupOldStashes(bridge, "/tmp/workspace")
            mock_exec.assert_not_called()

    @pytest.mark.asyncio
    async def test_keeps_recent_stash(self):
        bridge = FakeBridge()
        recent_ts = int(time.time() * 1000) - 1000  # 1 second ago
        session_id = "cc-1000000000000-recent1"
        stash_list = f"stash@{{0}}: On main: CC-snapshot-{session_id}-{recent_ts}"

        with (
            patch("core.git_snapshot.GitSnapshot._git_exec_output_static", new_callable=AsyncMock, return_value=stash_list),
            patch("core.git_snapshot.GitSnapshot._git_exec_static", new_callable=AsyncMock) as mock_exec,
        ):
            await GitSnapshot.cleanupOldStashes(bridge, "/tmp/workspace")
            mock_exec.assert_not_called()

    @pytest.mark.asyncio
    async def test_empty_stash_list(self):
        bridge = FakeBridge()
        with (
            patch("core.git_snapshot.GitSnapshot._git_exec_output_static", new_callable=AsyncMock, return_value=""),
        ):
            await GitSnapshot.cleanupOldStashes(bridge, "/tmp/workspace")

    @pytest.mark.asyncio
    async def test_skips_non_cc_stashes(self):
        bridge = FakeBridge()
        stash_list = "stash@{0}: On main: WIP on main: abc123 some work"
        with (
            patch("core.git_snapshot.GitSnapshot._git_exec_output_static", new_callable=AsyncMock, return_value=stash_list),
            patch("core.git_snapshot.GitSnapshot._git_exec_static", new_callable=AsyncMock) as mock_exec,
        ):
            await GitSnapshot.cleanupOldStashes(bridge, "/tmp/workspace")
            mock_exec.assert_not_called()

    @pytest.mark.asyncio
    async def test_git_list_failure_is_swallowed(self):
        bridge = FakeBridge()
        with patch(
            "core.git_snapshot.GitSnapshot._git_exec_output_static",
            new_callable=AsyncMock,
            side_effect=RuntimeError("git failed"),
        ):
            await GitSnapshot.cleanupOldStashes(bridge, "/tmp/workspace")

    @pytest.mark.asyncio
    async def test_drops_in_reverse_order(self):
        """Multiple old stashes should be dropped in reverse index order."""
        now_ms = int(time.time() * 1000)
        old_ts = now_ms - 8 * 24 * 3600000

        bridge = FakeBridge()
        bridge.session_meta["cc-1111111111111-old01"] = {"active": False, "cwd": "/tmp/workspace"}
        bridge.session_meta["cc-2222222222222-old02"] = {"active": False, "cwd": "/tmp/workspace"}

        stash_list = (
            f"stash@{{0}}: On main: CC-snapshot-cc-1111111111111-old01-{old_ts}\n"
            f"stash@{{1}}: On main: CC-snapshot-cc-2222222222222-old02-{old_ts}"
        )

        with (
            patch("core.git_snapshot.GitSnapshot._git_exec_output_static", new_callable=AsyncMock, return_value=stash_list),
            patch("core.git_snapshot.GitSnapshot._git_exec_static", new_callable=AsyncMock) as mock_static,
        ):
            await GitSnapshot.cleanupOldStashes(bridge, "/tmp/workspace")

        assert mock_static.await_count == 2
        first_drop = mock_static.call_args_list[0].args[0]
        second_drop = mock_static.call_args_list[1].args[0]
        assert "stash@{1}" in first_drop
        assert "stash@{0}" in second_drop

    @pytest.mark.asyncio
    async def test_skips_malformed_cc_snapshot(self):
        """Covers line 129: continue when SESSION_ID_REGEX does not match
        despite the line containing 'CC-snapshot-'."""
        bridge = FakeBridge()
        # "CC-snapshot-" is in the line but the remainder is malformed
        stash_list = "stash@{0}: On main: CC-snapshot-badformat-no-timestamp"

        with (
            patch("core.git_snapshot.GitSnapshot._git_exec_output_static", new_callable=AsyncMock, return_value=stash_list),
            patch("core.git_snapshot.GitSnapshot._git_exec_static", new_callable=AsyncMock) as mock_exec,
        ):
            await GitSnapshot.cleanupOldStashes(bridge, "/tmp/workspace")

        mock_exec.assert_not_called()

    @pytest.mark.asyncio
    async def test_individual_drop_failure_is_swallowed(self):
        """Covers lines 148-149: the except block inside the drop loop."""
        now_ms = int(time.time() * 1000)
        old_ts = now_ms - 8 * 24 * 3600000

        bridge = FakeBridge()
        bridge.session_meta["cc-1111111111111-old01"] = {"active": False, "cwd": "/tmp/workspace"}

        stash_list = f"stash@{{0}}: On main: CC-snapshot-cc-1111111111111-old01-{old_ts}"

        with (
            patch("core.git_snapshot.GitSnapshot._git_exec_output_static", new_callable=AsyncMock, return_value=stash_list),
            patch("core.git_snapshot.GitSnapshot._git_exec_static", new_callable=AsyncMock, side_effect=RuntimeError("drop failed")),
        ):
            # Should not raise despite individual drop failure
            await GitSnapshot.cleanupOldStashes(bridge, "/tmp/workspace")

    @pytest.mark.asyncio
    async def test_drops_old_stash_for_session_not_in_meta(self):
        """Session not present in session_meta means no active flag, so
        the stash should be eligible for cleanup."""
        now_ms = int(time.time() * 1000)
        old_ts = now_ms - 8 * 24 * 3600000

        bridge = FakeBridge()
        # No session_meta entry for cc-9999999999999-unknown
        stash_list = f"stash@{{0}}: On main: CC-snapshot-cc-9999999999999-unknown-{old_ts}"

        with (
            patch("core.git_snapshot.GitSnapshot._git_exec_output_static", new_callable=AsyncMock, return_value=stash_list),
            patch("core.git_snapshot.GitSnapshot._git_exec_static", new_callable=AsyncMock) as mock_exec,
        ):
            await GitSnapshot.cleanupOldStashes(bridge, "/tmp/workspace")

        mock_exec.assert_awaited_once()
        assert "stash@{0}" in mock_exec.call_args.args[0]

    @pytest.mark.asyncio
    async def test_mixed_stashes_only_drops_eligible(self):
        now_ms = int(time.time() * 1000)
        old_ts = now_ms - 8 * 24 * 3600000
        recent_ts = now_ms - 3 * 24 * 3600000

        bridge = FakeBridge()
        bridge.session_meta["cc-1111111111111-old01"] = {"active": False, "cwd": "/tmp/workspace"}
        bridge.session_meta["cc-3333333333333-act01"] = {"active": True, "cwd": "/tmp/workspace"}

        stash_list = (
            f"stash@{{0}}: On main: CC-snapshot-cc-1111111111111-old01-{old_ts}\n"
            f"stash@{{1}}: On main: CC-snapshot-cc-2222222222222-rec01-{recent_ts}\n"
            f"stash@{{2}}: On main: CC-snapshot-cc-3333333333333-act01-{old_ts}\n"
            "stash@{3}: On main: manual-stash"
        )

        with (
            patch("core.git_snapshot.GitSnapshot._git_exec_output_static", new_callable=AsyncMock, return_value=stash_list),
            patch("core.git_snapshot.GitSnapshot._git_exec_static", new_callable=AsyncMock) as mock_exec,
        ):
            await GitSnapshot.cleanupOldStashes(bridge, "/tmp/workspace")

        # Only stash@{0} should be dropped:
        # - stash@{1} is recent (<7 days)
        # - stash@{2} belongs to active session
        # - stash@{3} is not a CC-snapshot
        assert mock_exec.await_count == 1
        assert "stash@{0}" in mock_exec.call_args.args[0]

    @pytest.mark.asyncio
    async def test_whitespace_only_lines_ignored(self):
        now_ms = int(time.time() * 1000)
        old_ts = now_ms - 8 * 24 * 3600000

        bridge = FakeBridge()
        bridge.session_meta["cc-1111111111111-old01"] = {"active": False, "cwd": "/tmp/workspace"}

        stash_list = (
            "\n"
            f"stash@{{0}}: On main: CC-snapshot-cc-1111111111111-old01-{old_ts}\n"
            "   \n"
        )

        with (
            patch("core.git_snapshot.GitSnapshot._git_exec_output_static", new_callable=AsyncMock, return_value=stash_list),
            patch("core.git_snapshot.GitSnapshot._git_exec_static", new_callable=AsyncMock) as mock_exec,
        ):
            await GitSnapshot.cleanupOldStashes(bridge, "/tmp/workspace")

        mock_exec.assert_awaited_once()
        assert "stash@{0}" in mock_exec.call_args.args[0]

    @pytest.mark.asyncio
    async def test_custom_cleanup_days(self):
        now_ms = int(time.time() * 1000)
        ts_5d = now_ms - 5 * 24 * 3600000  # 5 days old

        bridge = FakeBridge()
        bridge.session_meta["cc-1111111111111-old01"] = {"active": False, "cwd": "/tmp/workspace"}
        stash_list = f"stash@{{0}}: On main: CC-snapshot-cc-1111111111111-old01-{ts_5d}"

        # With 3-day cutoff: 5-day stash should be dropped
        with (
            patch("core.git_snapshot.GitSnapshot._git_exec_output_static", new_callable=AsyncMock, return_value=stash_list),
            patch("core.git_snapshot.GitSnapshot._git_exec_static", new_callable=AsyncMock) as mock_static,
        ):
            await GitSnapshot.cleanupOldStashes(bridge, "/tmp/workspace", cleanup_days=3)
        mock_static.assert_awaited_once()

        # With 7-day cutoff: 5-day stash should be kept
        with (
            patch("core.git_snapshot.GitSnapshot._git_exec_output_static", new_callable=AsyncMock, return_value=stash_list),
            patch("core.git_snapshot.GitSnapshot._git_exec_static", new_callable=AsyncMock) as mock_static_7,
        ):
            await GitSnapshot.cleanupOldStashes(bridge, "/tmp/workspace", cleanup_days=7)
        mock_static_7.assert_not_awaited()


# ---------------------------------------------------------------------------
# _git_exec / _git_exec_output helper methods (integration with mock subprocess)
# ---------------------------------------------------------------------------


class TestGitExecHelpers:
    """Test the _git_exec and _git_exec_output helper methods."""

    @pytest.mark.asyncio
    async def test_git_exec_success(self):
        bridge = _make_bridge_with_session()
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.wait = AsyncMock(return_value=0)

        with patch("asyncio.create_subprocess_shell", new_callable=AsyncMock, return_value=mock_proc):
            await snapshot._git_exec("git status", "/tmp/workspace")

    @pytest.mark.asyncio
    async def test_git_exec_failure_raises(self):
        bridge = _make_bridge_with_session()
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        mock_proc = MagicMock()
        mock_proc.returncode = 1
        mock_proc.wait = AsyncMock(return_value=1)

        with patch("asyncio.create_subprocess_shell", new_callable=AsyncMock, return_value=mock_proc):
            with pytest.raises(RuntimeError, match="git command failed"):
                await snapshot._git_exec("git bad-cmd", "/tmp/workspace")

    @pytest.mark.asyncio
    async def test_git_exec_output_returns_stdout(self):
        bridge = _make_bridge_with_session()
        snapshot = GitSnapshot(bridge, "cc-1709123456789-abc123")

        mock_proc = MagicMock()
        mock_proc.communicate = AsyncMock(return_value=(b"stash@{0}: On main: test\n", b""))

        with patch("asyncio.create_subprocess_shell", new_callable=AsyncMock, return_value=mock_proc):
            result = await snapshot._git_exec_output("git stash list", "/tmp/workspace")
            assert "stash@{0}" in result

    @pytest.mark.asyncio
    async def test_git_exec_static_success(self):
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.wait = AsyncMock(return_value=0)

        with patch("asyncio.create_subprocess_shell", new_callable=AsyncMock, return_value=mock_proc):
            await GitSnapshot._git_exec_static("git status", "/tmp/workspace")

    @pytest.mark.asyncio
    async def test_git_exec_static_failure_raises(self):
        """Covers line 186: RuntimeError in _git_exec_static on non-zero exit."""
        mock_proc = MagicMock()
        mock_proc.returncode = 1
        mock_proc.wait = AsyncMock(return_value=1)

        with patch("asyncio.create_subprocess_shell", new_callable=AsyncMock, return_value=mock_proc):
            with pytest.raises(RuntimeError, match="git command failed"):
                await GitSnapshot._git_exec_static("git bad-cmd", "/tmp/workspace")

    @pytest.mark.asyncio
    async def test_git_exec_output_static_returns_stdout(self):
        mock_proc = MagicMock()
        mock_proc.communicate = AsyncMock(return_value=(b"output text", b""))

        with patch("asyncio.create_subprocess_shell", new_callable=AsyncMock, return_value=mock_proc):
            result = await GitSnapshot._git_exec_output_static("git stash list", "/tmp/workspace")
            assert result == "output text"
