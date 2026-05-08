"""Tests for core.context_manager — ContextManager, RULES_START, RULES_END."""

import os
from unittest.mock import MagicMock

import pytest

from core.context_manager import RULES_END, RULES_START, ContextManager


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

class TestConstants:
    """Verify RULES_START and RULES_END marker constants."""

    def test_rules_start_value(self) -> None:
        assert RULES_START == "<!-- CC-BRIDGE-RULES:START -->"

    def test_rules_end_value(self) -> None:
        assert RULES_END == "<!-- CC-BRIDGE-RULES:END -->"

    def test_markers_are_html_comments(self) -> None:
        assert RULES_START.startswith("<!--")
        assert RULES_START.endswith("-->")
        assert RULES_END.startswith("<!--")
        assert RULES_END.endswith("-->")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def workspace(tmp_path: pytest.TempPathFactory) -> str:
    """Provide a temporary workspace directory."""
    return str(tmp_path)


@pytest.fixture
def cm(workspace: str) -> ContextManager:
    """Create a ContextManager for the temporary workspace."""
    return ContextManager(workspace)


def _read_claude_md(workspace: str) -> str:
    """Read the CLAUDE.md file in the given workspace."""
    path = os.path.join(workspace, "CLAUDE.md")
    if not os.path.exists(path):
        return ""
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


# ---------------------------------------------------------------------------
# injectRules
# ---------------------------------------------------------------------------

class TestInjectRules:
    """injectRules() adds START/END markers with content to CLAUDE.md."""

    def test_creates_claude_md_if_not_exists(self, cm: ContextManager, workspace: str) -> None:
        claude_md_path = os.path.join(workspace, "CLAUDE.md")
        assert not os.path.exists(claude_md_path)

        cm.injectRules()

        assert os.path.exists(claude_md_path)

    def test_adds_start_and_end_markers(self, cm: ContextManager, workspace: str) -> None:
        cm.injectRules()

        content = _read_claude_md(workspace)
        assert RULES_START in content
        assert RULES_END in content

    def test_markers_surround_content(self, cm: ContextManager, workspace: str) -> None:
        cm.injectRules()

        content = _read_claude_md(workspace)
        start_idx = content.index(RULES_START)
        end_idx = content.index(RULES_END)
        assert start_idx < end_idx

    def test_idempotent_replaces_previous_injection(self, cm: ContextManager, workspace: str) -> None:
        """Calling injectRules twice should produce only one injected block."""
        cm.injectRules()
        cm.injectRules()

        content = _read_claude_md(workspace)
        count_start = content.count(RULES_START)
        count_end = content.count(RULES_END)
        assert count_start == 1
        assert count_end == 1

    def test_preserves_existing_content(self, cm: ContextManager, workspace: str) -> None:
        claude_md_path = os.path.join(workspace, "CLAUDE.md")
        with open(claude_md_path, "w", encoding="utf-8") as fh:
            fh.write("# Existing content\n\nDo not overwrite this.\n")

        cm.injectRules()

        content = _read_claude_md(workspace)
        assert "# Existing content" in content
        assert "Do not overwrite this." in content
        assert RULES_START in content

    def test_injected_rules_template_content(self, cm: ContextManager, workspace: str) -> None:
        """The injected block should contain the bridge rules template."""
        cm.injectRules()

        content = _read_claude_md(workspace)
        # The template file contains "CC Gateway 项目规则"
        if cm.rules_content:
            assert cm.rules_content in content


# ---------------------------------------------------------------------------
# cleanup
# ---------------------------------------------------------------------------

class TestCleanup:
    """cleanup() removes the injected rules block from CLAUDE.md."""

    def test_removes_injected_block(self, cm: ContextManager, workspace: str) -> None:
        cm.injectRules()
        assert RULES_START in _read_claude_md(workspace)

        cm.cleanup()

        content = _read_claude_md(workspace)
        assert RULES_START not in content
        assert RULES_END not in content

    def test_preserves_other_content(self, cm: ContextManager, workspace: str) -> None:
        claude_md_path = os.path.join(workspace, "CLAUDE.md")
        with open(claude_md_path, "w", encoding="utf-8") as fh:
            fh.write("# My Project\n\nSome rules here.\n")

        cm.injectRules()
        cm.cleanup()

        content = _read_claude_md(workspace)
        assert "# My Project" in content
        assert "Some rules here." in content

    def test_no_claude_md_does_nothing(self, cm: ContextManager, workspace: str) -> None:
        claude_md_path = os.path.join(workspace, "CLAUDE.md")
        assert not os.path.exists(claude_md_path)
        # Should not raise
        cm.cleanup()

    def test_no_markers_does_nothing(self, cm: ContextManager, workspace: str) -> None:
        claude_md_path = os.path.join(workspace, "CLAUDE.md")
        with open(claude_md_path, "w", encoding="utf-8") as fh:
            fh.write("# Clean file\n")

        cm.cleanup()

        content = _read_claude_md(workspace)
        assert content == "# Clean file"


# ---------------------------------------------------------------------------
# cleanOrphanedRules
# ---------------------------------------------------------------------------

class TestCleanOrphanedRules:
    """cleanOrphanedRules() removes rules when no active session for workspace."""

    def test_removes_rules_when_no_active_session(
        self, cm: ContextManager, workspace: str
    ) -> None:
        cm.injectRules()

        # Bridge with no active sessions for this workspace
        bridge = MagicMock()
        bridge.session_meta = {}

        result = cm.cleanOrphanedRules(bridge)

        assert result is True
        content = _read_claude_md(workspace)
        assert RULES_START not in content

    def test_removes_rules_when_session_is_inactive(
        self, cm: ContextManager, workspace: str
    ) -> None:
        cm.injectRules()

        # Bridge with an inactive session for this workspace
        bridge = MagicMock()
        bridge.session_meta = {
            "session-1": {"active": False, "cwd": workspace},
        }

        result = cm.cleanOrphanedRules(bridge)

        assert result is True
        content = _read_claude_md(workspace)
        assert RULES_START not in content

    def test_keeps_rules_when_active_session_exists(
        self, cm: ContextManager, workspace: str
    ) -> None:
        cm.injectRules()

        # Bridge with an active session for this workspace
        bridge = MagicMock()
        bridge.session_meta = {
            "session-1": {"active": True, "cwd": workspace},
        }

        result = cm.cleanOrphanedRules(bridge)

        assert result is False
        content = _read_claude_md(workspace)
        assert RULES_START in content

    def test_keeps_rules_when_session_is_for_different_workspace(
        self, cm: ContextManager, workspace: str
    ) -> None:
        cm.injectRules()

        # Active session for a different workspace should not protect this one
        bridge = MagicMock()
        bridge.session_meta = {
            "session-1": {"active": True, "cwd": "/other/workspace"},
        }

        result = cm.cleanOrphanedRules(bridge)

        assert result is True
        content = _read_claude_md(workspace)
        assert RULES_START not in content

    def test_no_claude_md_returns_false(
        self, cm: ContextManager, workspace: str
    ) -> None:
        bridge = MagicMock()
        bridge.session_meta = {}

        result = cm.cleanOrphanedRules(bridge)

        assert result is False

    def test_no_markers_returns_false(
        self, cm: ContextManager, workspace: str
    ) -> None:
        claude_md_path = os.path.join(workspace, "CLAUDE.md")
        with open(claude_md_path, "w", encoding="utf-8") as fh:
            fh.write("# No markers here\n")

        bridge = MagicMock()
        bridge.session_meta = {}

        result = cm.cleanOrphanedRules(bridge)

        assert result is False


# ---------------------------------------------------------------------------
# buildContextPrompt
# ---------------------------------------------------------------------------

class TestBuildContextPrompt:
    """buildContextPrompt() returns context info string (directory listing)."""

    @pytest.mark.asyncio
    async def test_returns_directory_listing(
        self, cm: ContextManager, workspace: str
    ) -> None:
        # Create some files in workspace so listing is non-empty
        for name in ("file1.txt", "file2.py"):
            with open(os.path.join(workspace, name), "w") as fh:
                fh.write("")

        result = await cm.buildContextPrompt(workspace)

        assert isinstance(result, str)
        assert "file1.txt" in result
        assert "file2.py" in result

    @pytest.mark.asyncio
    async def test_includes_working_directory_label(
        self, cm: ContextManager, workspace: str
    ) -> None:
        result = await cm.buildContextPrompt(workspace)
        assert "工作目录内容" in result

    @pytest.mark.asyncio
    async def test_empty_workspace_still_returns_listing_label(
        self, cm: ContextManager, workspace: str
    ) -> None:
        result = await cm.buildContextPrompt(workspace)
        assert "工作目录内容" in result

    @pytest.mark.asyncio
    async def test_nonexistent_workspace_does_not_crash(self, cm: ContextManager) -> None:
        # Use a path that does not exist — should not raise
        result = await cm.buildContextPrompt("/nonexistent/path/xyz123")
        assert isinstance(result, str)
