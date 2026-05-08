"""Tests for core.messenger — DefaultMessenger, PlatformMessenger, MAX_MESSAGE_LENGTH."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from core.messenger import (
    CODE_BLOCK_MARKER,
    MAX_MESSAGE_LENGTH,
    DefaultMessenger,
    PlatformMessenger,
)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

class TestConstants:
    """Verify module-level constants."""

    def test_max_message_length(self) -> None:
        assert MAX_MESSAGE_LENGTH == 4000

    def test_code_block_marker(self) -> None:
        assert CODE_BLOCK_MARKER == "```"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def messenger() -> DefaultMessenger:
    return DefaultMessenger()


@pytest.fixture
def small_messenger() -> DefaultMessenger:
    """Messenger with a small max length for testing splitMessage."""
    return DefaultMessenger(max_message_length=100)


# ---------------------------------------------------------------------------
# formatApprovalNotification
# ---------------------------------------------------------------------------

class TestFormatApprovalNotification:
    """formatApprovalNotification() produces the expected formatted string."""

    def test_format_contains_short_id(self, messenger: DefaultMessenger) -> None:
        approval_id = "abcdefghijklmnop1234567890"
        result = messenger.formatApprovalNotification(
            approval_id, "Bash", "rm -rf /", "/home/user"
        )
        short_id = approval_id[:8]
        assert f"#{short_id}" in result

    def test_format_contains_tool_name(self, messenger: DefaultMessenger) -> None:
        result = messenger.formatApprovalNotification(
            "abc12345xyz", "Bash", "ls -la", "/tmp"
        )
        assert "Bash" in result

    def test_format_contains_input_preview(self, messenger: DefaultMessenger) -> None:
        result = messenger.formatApprovalNotification(
            "abc12345xyz", "Bash", "ls -la", "/tmp"
        )
        assert "ls -la" in result

    def test_format_contains_cwd(self, messenger: DefaultMessenger) -> None:
        result = messenger.formatApprovalNotification(
            "abc12345xyz", "Bash", "ls -la", "/home/user/project"
        )
        assert "/home/user/project" in result

    def test_format_contains_approve_command(self, messenger: DefaultMessenger) -> None:
        approval_id = "abc12345678"
        result = messenger.formatApprovalNotification(
            approval_id, "Bash", "cmd", "/tmp"
        )
        short_id = approval_id[:8]
        assert f"/cc_approve {short_id}" in result

    def test_format_contains_deny_command(self, messenger: DefaultMessenger) -> None:
        approval_id = "abc12345678"
        result = messenger.formatApprovalNotification(
            approval_id, "Bash", "cmd", "/tmp"
        )
        short_id = approval_id[:8]
        assert f"/cc_deny {short_id}" in result

    def test_format_starts_with_approval_header(self, messenger: DefaultMessenger) -> None:
        result = messenger.formatApprovalNotification(
            "abc12345678", "Bash", "cmd", "/tmp"
        )
        assert result.startswith("审批请求 #")


# ---------------------------------------------------------------------------
# formatToolProgress
# ---------------------------------------------------------------------------

class TestFormatToolProgress:
    """formatToolProgress() formats status with appropriate icon."""

    def test_success_status(self, messenger: DefaultMessenger) -> None:
        result = messenger.formatToolProgress("Bash", "success", "")
        assert result == "✓ Bash: 成功"

    def test_error_status_with_detail(self, messenger: DefaultMessenger) -> None:
        result = messenger.formatToolProgress("Bash", "error", "permission denied")
        assert "✗" in result
        assert "permission denied" in result

    def test_error_status_without_detail(self, messenger: DefaultMessenger) -> None:
        result = messenger.formatToolProgress("Bash", "error", "")
        assert "✗" in result
        assert "未知错误" in result

    def test_other_status_with_detail(self, messenger: DefaultMessenger) -> None:
        result = messenger.formatToolProgress("Bash", "running", "compiling...")
        assert "→" in result
        assert "compiling..." in result

    def test_other_status_without_detail(self, messenger: DefaultMessenger) -> None:
        result = messenger.formatToolProgress("Bash", "pending", "")
        assert "→" in result

    def test_error_detail_truncated_to_80_chars(self, messenger: DefaultMessenger) -> None:
        long_detail = "x" * 200
        result = messenger.formatToolProgress("Bash", "error", long_detail)
        # The detail part should be at most 80 chars
        # Result format: "✗ Bash: 失败: {detail[:80]}"
        assert len(result) < 200  # much shorter than raw 200-char detail


# ---------------------------------------------------------------------------
# formatErrorMessage
# ---------------------------------------------------------------------------

class TestFormatErrorMessage:
    """formatErrorMessage() formats errors with 错误 prefix."""

    def test_string_error(self, messenger: DefaultMessenger) -> None:
        result = messenger.formatErrorMessage("something went wrong")
        assert result == "错误: something went wrong"

    def test_exception_error(self, messenger: DefaultMessenger) -> None:
        exc = ValueError("bad value")
        result = messenger.formatErrorMessage(exc)
        assert "错误:" in result
        assert "bad value" in result

    def test_exception_without_message(self, messenger: DefaultMessenger) -> None:
        exc = Exception("")
        result = messenger.formatErrorMessage(exc)
        assert "未知错误" in result

    def test_non_string_non_exception(self, messenger: DefaultMessenger) -> None:
        result = messenger.formatErrorMessage(42)
        assert "未知错误" in result

    def test_none_error(self, messenger: DefaultMessenger) -> None:
        result = messenger.formatErrorMessage(None)
        assert "未知错误" in result

    def test_long_error_truncated(self, messenger: DefaultMessenger) -> None:
        long_msg = "x" * 1000
        result = messenger.formatErrorMessage(long_msg)
        # Should be truncated: "错误: " (4 chars) + up to 500 chars
        assert len(result) <= 510


# ---------------------------------------------------------------------------
# formatSessionStatus
# ---------------------------------------------------------------------------

class TestFormatSessionStatus:
    """formatSessionStatus() produces a multi-line status display."""

    def test_alive_process(self, messenger: DefaultMessenger) -> None:
        meta = {
            "startedAt": "2026-01-01T00:00:00+00:00",
            "lastActiveAt": "2026-01-01T00:01:00+00:00",
            "cwd": "/home/user/project",
            "messageCount": 5,
        }
        proc = MagicMock()
        proc.returncode = None
        session_id = "cc-1234567890-abc123"

        result = messenger.formatSessionStatus(meta, proc, session_id)

        assert "持久会话状态" in result
        assert "存活" in result
        assert "cc-12345" in result

    def test_dead_process(self, messenger: DefaultMessenger) -> None:
        meta = {
            "startedAt": "2026-01-01T00:00:00+00:00",
            "lastActiveAt": "2026-01-01T00:01:00+00:00",
            "cwd": "/home/user/project",
            "messageCount": 3,
        }
        proc = MagicMock()
        proc.returncode = 1
        session_id = "cc-1234567890-abc123"

        result = messenger.formatSessionStatus(meta, proc, session_id)

        assert "已退出" in result

    def test_none_process(self, messenger: DefaultMessenger) -> None:
        meta = {
            "startedAt": "2026-01-01T00:00:00+00:00",
            "lastActiveAt": "2026-01-01T00:01:00+00:00",
            "cwd": "/home/user/project",
            "messageCount": 0,
        }
        result = messenger.formatSessionStatus(meta, None, "cc-1234567890-abc123")
        assert "已退出" in result

    def test_status_contains_cwd(self, messenger: DefaultMessenger) -> None:
        meta = {
            "startedAt": "2026-01-01T00:00:00+00:00",
            "lastActiveAt": "2026-01-01T00:01:00+00:00",
            "cwd": "/home/user/project",
            "messageCount": 0,
        }
        result = messenger.formatSessionStatus(meta, None, "cc-1234567890")
        assert "/home/user/project" in result

    def test_status_contains_message_count(self, messenger: DefaultMessenger) -> None:
        meta = {
            "startedAt": "2026-01-01T00:00:00+00:00",
            "lastActiveAt": "2026-01-01T00:01:00+00:00",
            "cwd": "/tmp",
            "messageCount": 42,
        }
        result = messenger.formatSessionStatus(meta, None, "cc-1234567890")
        assert "42" in result


# ---------------------------------------------------------------------------
# splitMessage
# ---------------------------------------------------------------------------

class TestSplitMessage:
    """splitMessage() splits long messages while preserving code blocks."""

    def test_short_message_single_chunk(self, messenger: DefaultMessenger) -> None:
        text = "Hello, world!"
        chunks = messenger.splitMessage(text)
        assert chunks == ["Hello, world!"]

    def test_empty_string_returns_single_empty_chunk(self, messenger: DefaultMessenger) -> None:
        chunks = messenger.splitMessage("")
        assert chunks == [""]

    def test_none_returns_single_empty_chunk(self, messenger: DefaultMessenger) -> None:
        chunks = messenger.splitMessage(None)
        assert chunks == [""]

    def test_exactly_max_length_is_single_chunk(self, messenger: DefaultMessenger) -> None:
        text = "a" * MAX_MESSAGE_LENGTH
        chunks = messenger.splitMessage(text)
        assert len(chunks) == 1

    def test_over_max_length_splits(self, messenger: DefaultMessenger) -> None:
        text = "a" * (MAX_MESSAGE_LENGTH + 100)
        chunks = messenger.splitMessage(text)
        assert len(chunks) >= 2

    def test_splits_prefer_newline_boundaries(self, small_messenger: DefaultMessenger) -> None:
        # Create a message where newline falls within the search range
        lines = ["line content"] * 20
        text = "\n".join(lines)
        chunks = small_messenger.splitMessage(text)
        assert len(chunks) >= 2
        # Each chunk should be at or under the max length
        for chunk in chunks:
            assert len(chunk) <= small_messenger.max_message_length

    def test_code_block_preservation(self, small_messenger: DefaultMessenger) -> None:
        """Do not split inside a code block (odd number of markers)."""
        code = "```\ncode line 1\ncode line 2\n```"
        prefix = "a" * 60
        text = f"{prefix}\n{code}"
        chunks = small_messenger.splitMessage(text)
        # The code block should remain intact in one chunk
        for chunk in chunks:
            marker_count = chunk.count(CODE_BLOCK_MARKER)
            # If a chunk contains the start marker, it must also contain the end
            # (marker count must be even, or 0)
            # This is a soft check: we just ensure we didn't produce a chunk
            # with an odd number of markers that would indicate a broken block.
            # Exception: the last chunk might legitimately end with an opening marker
            # if the entire text has odd markers.
            total_markers = text.count(CODE_BLOCK_MARKER)
            if total_markers % 2 == 0:
                assert marker_count % 2 == 0, (
                    f"Chunk has {marker_count} code block markers (odd), "
                    f"indicating a split inside a code block:\n{chunk[:100]}"
                )

    def test_all_chunks_concatenated_equal_original(self, small_messenger: DefaultMessenger) -> None:
        """Concatenating all chunks should yield the original text."""
        text = "\n".join(f"paragraph {i} with some text" for i in range(50))
        chunks = small_messenger.splitMessage(text)
        assert "".join(chunks) == text

    def test_very_long_line_no_newlines(self, small_messenger: DefaultMessenger) -> None:
        """When there are no newlines near the split point, it splits at max_length."""
        text = "x" * 300
        chunks = small_messenger.splitMessage(text)
        assert len(chunks) >= 2
        assert "".join(chunks) == text


# ---------------------------------------------------------------------------
# PlatformMessenger
# ---------------------------------------------------------------------------

class TestPlatformMessenger:
    """PlatformMessenger delegates delivery to a callback and splits long messages."""

    @pytest.mark.asyncio
    async def test_send_to_user_calls_callback(self) -> None:
        callback = AsyncMock()
        pm = PlatformMessenger(delivery_callback=callback)
        await pm.send_to_user("user1", "hello")
        callback.assert_called_once_with(
            target="user1", text="hello", options={}
        )

    @pytest.mark.asyncio
    async def test_send_to_user_passes_options(self) -> None:
        callback = AsyncMock()
        pm = PlatformMessenger(delivery_callback=callback)
        await pm.send_to_user("user1", "hello", {"channelId": "ch1"})
        callback.assert_called_once_with(
            target="user1", text="hello", options={"channelId": "ch1"}
        )

    @pytest.mark.asyncio
    async def test_send_to_user_splits_long_messages(self) -> None:
        callback = AsyncMock()
        pm = PlatformMessenger(delivery_callback=callback, max_message_length=50)
        text = "a" * 120
        await pm.send_to_user("user1", text)
        assert callback.call_count >= 2

    @pytest.mark.asyncio
    async def test_send_to_user_returns_chunk_count(self) -> None:
        callback = AsyncMock()
        pm = PlatformMessenger(delivery_callback=callback)
        count = await pm.send_to_user("user1", "short msg")
        assert count == 1

    @pytest.mark.asyncio
    async def test_send_to_user_long_message_returns_correct_count(self) -> None:
        callback = AsyncMock()
        pm = PlatformMessenger(delivery_callback=callback, max_message_length=50)
        text = "a" * 120
        count = await pm.send_to_user("user1", text)
        assert count >= 2

    def test_inherits_formatting_methods(self) -> None:
        callback = AsyncMock()
        pm = PlatformMessenger(delivery_callback=callback)
        # Should have all formatting methods from DefaultMessenger
        assert hasattr(pm, "formatApprovalNotification")
        assert hasattr(pm, "formatToolProgress")
        assert hasattr(pm, "formatErrorMessage")
        assert hasattr(pm, "formatSessionStatus")
        assert hasattr(pm, "splitMessage")
