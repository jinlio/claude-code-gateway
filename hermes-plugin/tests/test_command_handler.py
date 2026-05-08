"""Tests for core.command_handler — CommandHandler, formatToolInput."""

import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.command_handler import CommandHandler, formatToolInput


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SESSION_ID = "cc-1700000000000-abc123"
SESSION_ID_SHORT = SESSION_ID[:8]
WORKSPACE = "/tmp/test-workspace"
NOW_ISO = "2026-01-15T12:00:00+00:00"


def _make_meta(
    sender_id: str = "user1",
    cwd: str = WORKSPACE,
    active: bool = True,
    stash_ref: str | None = "CC-snapshot-cc-1700000000000-abc123-1700000000000",
    message_count: int = 5,
) -> dict:
    return {
        "senderId": sender_id,
        "cwd": cwd,
        "sessionId": SESSION_ID,
        "active": active,
        "startedAt": NOW_ISO,
        "lastActiveAt": NOW_ISO,
        "messageCount": message_count,
        "stashRef": stash_ref,
    }


def _make_proc(alive: bool = True) -> MagicMock:
    proc = MagicMock()
    proc.returncode = None if alive else 1
    proc.stdin = AsyncMock()
    proc.stdout = AsyncMock()
    proc.stderr = AsyncMock()
    return proc


def _make_bridge(
    has_session: bool = True,
    session_alive: bool = True,
) -> MagicMock:
    bridge = MagicMock()
    bridge.findActiveSession = MagicMock(
        return_value=SESSION_ID if has_session else None
    )
    bridge.process_map = {SESSION_ID: _make_proc(session_alive)} if has_session else {}
    bridge.session_meta = {SESSION_ID: _make_meta()} if has_session else {}
    bridge.spawnSession = AsyncMock(
        return_value={"sessionId": SESSION_ID, "reused": False}
    )
    bridge.terminateSession = MagicMock()
    bridge.updateActivity = MagicMock()
    return bridge


def _make_approval_server() -> MagicMock:
    server = MagicMock()
    server.getPort = MagicMock(return_value=9876)
    server.setMode = MagicMock()
    server.store = MagicMock()
    server.store.resolve = MagicMock()
    return server


def _make_session_manager() -> MagicMock:
    sm = MagicMock()
    sm.activate = MagicMock()
    sm.deactivate = MagicMock()
    return sm


def _make_messenger() -> MagicMock:
    ms = MagicMock()
    ms.formatSessionStatus = MagicMock(return_value="status display")
    ms.formatErrorMessage = MagicMock(return_value="错误: test")
    ms.send_to_user = AsyncMock()
    return ms


_UNSET = object()  # Sentinel to distinguish "not passed" from explicit None


def _make_handler(
    bridge: MagicMock | None = None,
    approval_server: MagicMock | None | object = _UNSET,
    session_manager: MagicMock | None = None,
    messenger: MagicMock | None = None,
    config: dict | None = None,
) -> CommandHandler:
    bridge = bridge or _make_bridge()
    approval_server = _make_approval_server() if approval_server is _UNSET else approval_server
    session_manager = session_manager or _make_session_manager()
    messenger = messenger or _make_messenger()
    config = config or {"workspace": WORKSPACE, "defaultMode": "efficient"}
    return CommandHandler(
        bridge=bridge,
        approval_server=approval_server,
        session_manager=session_manager,
        messenger=messenger,
        context_managers={},
        config=config,
    )


# ---------------------------------------------------------------------------
# formatToolInput
# ---------------------------------------------------------------------------

class TestFormatToolInput:
    """formatToolInput() extracts relevant fields from tool input JSON."""

    def test_bash_command(self) -> None:
        raw = json.dumps({"command": "ls -la /tmp"})
        assert formatToolInput("Bash", raw) == "ls -la /tmp"

    def test_bash_no_command_field(self) -> None:
        raw = json.dumps({"other": "value"})
        assert formatToolInput("Bash", raw) == "(no command)"

    def test_write_file_path(self) -> None:
        raw = json.dumps({"file_path": "/home/user/test.py", "content": "print(1)"})
        assert formatToolInput("Write", raw) == "/home/user/test.py"

    def test_edit_file_path(self) -> None:
        raw = json.dumps({"file_path": "/home/user/test.py", "old_text": "a", "new_text": "b"})
        assert formatToolInput("Edit", raw) == "/home/user/test.py"

    def test_write_no_file_path(self) -> None:
        raw = json.dumps({"content": "print(1)"})
        assert formatToolInput("Write", raw) == "(no path)"

    def test_other_tool_truncated_json(self) -> None:
        data = {"key1": "v" * 300}
        raw = json.dumps(data)
        result = formatToolInput("Read", raw)
        assert len(result) <= 200

    def test_invalid_json_returns_raw(self) -> None:
        raw = "not valid json {{{"
        result = formatToolInput("Bash", raw)
        assert result == "not valid json {{{"[:200]

    def test_empty_string_returns_placeholder(self) -> None:
        result = formatToolInput("Bash", "")
        assert result == "(no content)"

    def test_none_returns_placeholder(self) -> None:
        result = formatToolInput("Bash", None)
        assert result == "(no content)"

    def test_bash_command_truncated_to_200(self) -> None:
        long_cmd = "x" * 300
        raw = json.dumps({"command": long_cmd})
        result = formatToolInput("Bash", raw)
        assert len(result) <= 200


# ---------------------------------------------------------------------------
# /cc
# ---------------------------------------------------------------------------

class TestHandleCc:
    """/cc <prompt> — one-shot task submission."""

    @pytest.mark.asyncio
    async def test_with_prompt_no_existing_session(self) -> None:
        bridge = _make_bridge(has_session=False)
        handler = _make_handler(bridge=bridge)
        result = await handler.handleCommand("cc", "do something", "user1", "ch1", "acc1")
        assert "任务已提交" in result
        assert f"ID: {SESSION_ID_SHORT}" in result
        bridge.spawnSession.assert_called_once()

    @pytest.mark.asyncio
    async def test_with_prompt_existing_alive_session(self) -> None:
        bridge = _make_bridge(has_session=True, session_alive=True)
        handler = _make_handler(bridge=bridge)
        result = await handler.handleCommand("cc", "do something", "user1", "ch1", "acc1")
        assert "已发送到持久会话" in result
        bridge.spawnSession.assert_not_called()

    @pytest.mark.asyncio
    async def test_without_prompt(self) -> None:
        handler = _make_handler()
        result = await handler.handleCommand("cc", "", "user1", "ch1", "acc1")
        assert "用法: /cc <任务描述>" in result

    @pytest.mark.asyncio
    async def test_without_prompt_whitespace_only(self) -> None:
        handler = _make_handler()
        result = await handler.handleCommand("cc", "   ", "user1", "ch1", "acc1")
        assert "用法: /cc <任务描述>" in result


# ---------------------------------------------------------------------------
# /cc_start
# ---------------------------------------------------------------------------

class TestHandleCcStart:
    """/cc_start — start persistent session."""

    @pytest.mark.asyncio
    async def test_start_new_session(self) -> None:
        bridge = _make_bridge(has_session=False)
        handler = _make_handler(bridge=bridge)
        result = await handler.handleCommand("cc_start", "", "user1", "ch1", "acc1")
        assert "持久会话已启动" in result
        assert SESSION_ID_SHORT in result
        assert "efficient" in result
        assert "9876" in result

    @pytest.mark.asyncio
    async def test_start_when_already_active(self) -> None:
        bridge = _make_bridge(has_session=True, session_alive=True)
        messenger = _make_messenger()
        handler = _make_handler(bridge=bridge, messenger=messenger)
        result = await handler.handleCommand("cc_start", "", "user1", "ch1", "acc1")
        # Should return the status display from formatSessionStatus
        assert result == "status display"
        messenger.formatSessionStatus.assert_called_once()


# ---------------------------------------------------------------------------
# /cc_stop
# ---------------------------------------------------------------------------

class TestHandleCcStop:
    """/cc_stop — stop persistent session."""

    @pytest.mark.asyncio
    async def test_stop_active_session(self) -> None:
        bridge = _make_bridge(has_session=True)
        handler = _make_handler(bridge=bridge)
        result = await handler.handleCommand("cc_stop", "", "user1", "ch1", "acc1")
        assert "会话已停止" in result
        assert SESSION_ID_SHORT in result
        bridge.terminateSession.assert_called_once_with(SESSION_ID)

    @pytest.mark.asyncio
    async def test_stop_without_session(self) -> None:
        bridge = _make_bridge(has_session=False)
        handler = _make_handler(bridge=bridge)
        result = await handler.handleCommand("cc_stop", "", "user1", "ch1", "acc1")
        assert "当前没有持久会话" in result

    @pytest.mark.asyncio
    async def test_stop_by_non_owner(self) -> None:
        bridge = _make_bridge(has_session=True)
        # The session belongs to "user1" (from _make_meta)
        handler = _make_handler(bridge=bridge)
        result = await handler.handleCommand("cc_stop", "", "user2", "ch1", "acc1")
        assert "无权停止该会话" in result


# ---------------------------------------------------------------------------
# /cc_status
# ---------------------------------------------------------------------------

class TestHandleCcStatus:
    """/cc_status — check session status."""

    def test_with_active_session(self) -> None:
        bridge = _make_bridge(has_session=True)
        messenger = _make_messenger()
        handler = _make_handler(bridge=bridge, messenger=messenger)
        result = handler._handleCcStatus("user1")
        assert result == "status display"
        messenger.formatSessionStatus.assert_called_once()

    def test_without_session(self) -> None:
        bridge = _make_bridge(has_session=False)
        handler = _make_handler(bridge=bridge)
        result = handler._handleCcStatus("user1")
        assert "当前没有活跃的持久会话" in result


# ---------------------------------------------------------------------------
# /cc_answer
# ---------------------------------------------------------------------------

class TestHandleCcAnswer:
    """/cc_answer <text> — reply to Claude's question."""

    @pytest.mark.asyncio
    async def test_answer_with_alive_process(self) -> None:
        bridge = _make_bridge(has_session=True, session_alive=True)
        handler = _make_handler(bridge=bridge)
        result = await handler.handleCommand("cc_answer", "yes do it", "user1", "ch1", "acc1")
        assert "已发送回答" in result
        bridge.updateActivity.assert_called()

    @pytest.mark.asyncio
    async def test_answer_with_dead_process(self) -> None:
        bridge = _make_bridge(has_session=True, session_alive=False)
        handler = _make_handler(bridge=bridge)
        result = await handler.handleCommand("cc_answer", "yes", "user1", "ch1", "acc1")
        assert "会话进程已退出，无法回答" in result

    @pytest.mark.asyncio
    async def test_answer_without_session(self) -> None:
        bridge = _make_bridge(has_session=False)
        handler = _make_handler(bridge=bridge)
        result = await handler.handleCommand("cc_answer", "yes", "user1", "ch1", "acc1")
        assert "没有活跃会话" in result

    @pytest.mark.asyncio
    async def test_answer_without_text(self) -> None:
        handler = _make_handler()
        result = await handler.handleCommand("cc_answer", "", "user1", "ch1", "acc1")
        assert "用法: /cc_answer <回答内容>" in result


# ---------------------------------------------------------------------------
# /cc_approve
# ---------------------------------------------------------------------------

class TestHandleCcApprove:
    """/cc_approve <id> — approve a pending request."""

    def _make_item(
        self,
        status: str = "PENDING",
        tool_name: str = "Bash",
        session_id: str = SESSION_ID,
    ) -> dict:
        return {
            "id": "abc12345def67890",
            "toolName": tool_name,
            "status": status,
            "sessionId": session_id,
        }

    def test_approve_pending_request(self) -> None:
        bridge = _make_bridge(has_session=True)
        approval_server = _make_approval_server()
        item = self._make_item()
        approval_server.store.findByShortId = MagicMock(return_value=item)

        handler = _make_handler(bridge=bridge, approval_server=approval_server)
        result = handler._handleCcApprove("abc12345", "user1")

        assert "已批准" in result
        assert "abc12345" in result
        approval_server.store.resolve.assert_called_once_with(item["id"], "APPROVED")

    def test_approve_by_non_owner(self) -> None:
        bridge = _make_bridge(has_session=True)
        approval_server = _make_approval_server()
        item = self._make_item()
        approval_server.store.findByShortId = MagicMock(return_value=item)

        handler = _make_handler(bridge=bridge, approval_server=approval_server)
        result = handler._handleCcApprove("abc12345", "user2")

        assert "无权审批该请求" in result
        approval_server.store.resolve.assert_not_called()

    def test_approve_ambiguous_id(self) -> None:
        approval_server = _make_approval_server()
        ambiguous_item = {
            "ambiguous": True,
            "matches": [
                {"id": "abc12345aaaa", "toolName": "Bash"},
                {"id": "abc12345bbbb", "toolName": "Write"},
            ],
        }
        approval_server.store.findByShortId = MagicMock(return_value=ambiguous_item)

        handler = _make_handler(approval_server=approval_server)
        result = handler._handleCcApprove("abc1", "user1")

        assert "匹配到多个请求" in result

    def test_approve_already_resolved(self) -> None:
        approval_server = _make_approval_server()
        item = self._make_item(status="APPROVED")
        approval_server.store.findByShortId = MagicMock(return_value=item)

        handler = _make_handler(approval_server=approval_server)
        result = handler._handleCcApprove("abc12345", "user1")

        assert "该请求已处理" in result
        approval_server.store.resolve.assert_not_called()

    def test_approve_not_found(self) -> None:
        approval_server = _make_approval_server()
        approval_server.store.findByShortId = MagicMock(return_value=None)

        handler = _make_handler(approval_server=approval_server)
        result = handler._handleCcApprove("xyz99999", "user1")

        assert "未找到该审批请求" in result

    def test_approve_no_id(self) -> None:
        handler = _make_handler()
        result = handler._handleCcApprove("", "user1")
        assert "用法: /cc_approve <审批ID>" in result

    def test_approve_no_approval_server(self) -> None:
        handler = _make_handler(approval_server=None)
        result = handler._handleCcApprove("abc12345", "user1")
        assert "审批服务未启动" in result


# ---------------------------------------------------------------------------
# /cc_deny
# ---------------------------------------------------------------------------

class TestHandleCcDeny:
    """/cc_deny <id> — deny a pending request."""

    def _make_item(
        self,
        status: str = "PENDING",
        tool_name: str = "Bash",
        session_id: str = SESSION_ID,
    ) -> dict:
        return {
            "id": "abc12345def67890",
            "toolName": tool_name,
            "status": status,
            "sessionId": session_id,
        }

    def test_deny_pending_request(self) -> None:
        bridge = _make_bridge(has_session=True)
        approval_server = _make_approval_server()
        item = self._make_item()
        approval_server.store.findByShortId = MagicMock(return_value=item)

        handler = _make_handler(bridge=bridge, approval_server=approval_server)
        result = handler._handleCcDeny("abc12345", "user1")

        assert "已拒绝" in result
        assert "abc12345" in result
        approval_server.store.resolve.assert_called_once_with(item["id"], "DENIED")

    def test_deny_by_non_owner(self) -> None:
        bridge = _make_bridge(has_session=True)
        approval_server = _make_approval_server()
        item = self._make_item()
        approval_server.store.findByShortId = MagicMock(return_value=item)

        handler = _make_handler(bridge=bridge, approval_server=approval_server)
        result = handler._handleCcDeny("abc12345", "user2")

        assert "无权审批该请求" in result
        approval_server.store.resolve.assert_not_called()

    def test_deny_not_found(self) -> None:
        approval_server = _make_approval_server()
        approval_server.store.findByShortId = MagicMock(return_value=None)

        handler = _make_handler(approval_server=approval_server)
        result = handler._handleCcDeny("xyz99999", "user1")
        assert "未找到该审批请求" in result

    def test_deny_already_resolved(self) -> None:
        approval_server = _make_approval_server()
        item = self._make_item(status="DENIED")
        approval_server.store.findByShortId = MagicMock(return_value=item)

        handler = _make_handler(approval_server=approval_server)
        result = handler._handleCcDeny("abc12345", "user1")
        assert "该请求已处理" in result

    def test_deny_no_id(self) -> None:
        handler = _make_handler()
        result = handler._handleCcDeny("", "user1")
        assert "用法: /cc_deny <审批ID>" in result


# ---------------------------------------------------------------------------
# /cc_revert
# ---------------------------------------------------------------------------

class TestHandleCcRevert:
    """/cc_revert — rollback code changes."""

    @pytest.mark.asyncio
    async def test_revert_shows_confirmation_prompt(self) -> None:
        bridge = _make_bridge(has_session=True)
        handler = _make_handler(bridge=bridge)
        result = await handler.handleCommand("cc_revert", "", "user1", "ch1", "acc1")
        assert "确认回滚" in result
        assert "/cc_revert --confirm" in result
        assert "/cc_revert --cancel" in result

    @pytest.mark.asyncio
    async def test_revert_confirm(self) -> None:
        bridge = _make_bridge(has_session=True)
        handler = _make_handler(bridge=bridge)

        with patch("core.command_handler.GitSnapshot") as MockSnapshot:
            mock_snapshot = MockSnapshot.return_value
            mock_snapshot.revert = AsyncMock(return_value={"success": True})
            result = await handler.handleCommand(
                "cc_revert", "--confirm", "user1", "ch1", "acc1"
            )

        assert "已回滚到任务前状态" in result

    @pytest.mark.asyncio
    async def test_revert_confirm_failure(self) -> None:
        bridge = _make_bridge(has_session=True)
        handler = _make_handler(bridge=bridge)

        with patch("core.command_handler.GitSnapshot") as MockSnapshot:
            mock_snapshot = MockSnapshot.return_value
            mock_snapshot.revert = AsyncMock(
                return_value={"success": False, "message": "conflict detected"}
            )
            result = await handler.handleCommand(
                "cc_revert", "--confirm", "user1", "ch1", "acc1"
            )

        assert "回滚失败" in result

    @pytest.mark.asyncio
    async def test_revert_cancel(self) -> None:
        bridge = _make_bridge(has_session=True)
        handler = _make_handler(bridge=bridge)
        result = await handler.handleCommand(
            "cc_revert", "--cancel", "user1", "ch1", "acc1"
        )
        assert "已取消回滚" in result

    @pytest.mark.asyncio
    async def test_revert_without_session(self) -> None:
        bridge = _make_bridge(has_session=False)
        handler = _make_handler(bridge=bridge)
        result = await handler.handleCommand("cc_revert", "", "user1", "ch1", "acc1")
        assert "没有活跃的会话" in result

    @pytest.mark.asyncio
    async def test_revert_without_stash(self) -> None:
        bridge = _make_bridge(has_session=True)
        # Set stashRef to None
        bridge.session_meta[SESSION_ID]["stashRef"] = None
        handler = _make_handler(bridge=bridge)
        result = await handler.handleCommand("cc_revert", "", "user1", "ch1", "acc1")
        assert "无可用的快照" in result

    @pytest.mark.asyncio
    async def test_revert_confirm_without_stash(self) -> None:
        bridge = _make_bridge(has_session=True)
        bridge.session_meta[SESSION_ID]["stashRef"] = None
        handler = _make_handler(bridge=bridge)
        result = await handler.handleCommand(
            "cc_revert", "--confirm", "user1", "ch1", "acc1"
        )
        assert "无可用的快照" in result


# ---------------------------------------------------------------------------
# /cc_context
# ---------------------------------------------------------------------------

class TestHandleCcContext:
    """/cc_context — view project context."""

    @pytest.mark.asyncio
    async def test_context_with_session(self) -> None:
        bridge = _make_bridge(has_session=True)
        cm_mock = MagicMock()
        cm_mock.buildContextPrompt = AsyncMock(return_value="分支: main\n工作目录内容: ...")

        handler = _make_handler(bridge=bridge)
        handler.context_managers[WORKSPACE] = cm_mock

        result = await handler.handleCommand("cc_context", "", "user1", "ch1", "acc1")
        assert "当前项目上下文" in result
        assert "分支: main" in result

    @pytest.mark.asyncio
    async def test_context_without_session(self) -> None:
        bridge = _make_bridge(has_session=False)
        handler = _make_handler(bridge=bridge)
        result = await handler.handleCommand("cc_context", "", "user1", "ch1", "acc1")
        assert "没有活跃会话" in result

    @pytest.mark.asyncio
    async def test_context_no_context_manager(self) -> None:
        bridge = _make_bridge(has_session=True)
        handler = _make_handler(bridge=bridge)
        # No context manager registered for the workspace
        result = await handler.handleCommand("cc_context", "", "user1", "ch1", "acc1")
        assert "当前项目上下文" in result
        assert "(无上下文)" in result


# ---------------------------------------------------------------------------
# /cc_mode
# ---------------------------------------------------------------------------

class TestHandleCcMode:
    """/cc_mode [efficient|strict] — switch approval mode."""

    def test_switch_to_efficient(self) -> None:
        approval_server = _make_approval_server()
        handler = _make_handler(approval_server=approval_server)
        result = handler._handleCcMode("efficient")
        assert "已切换到 efficient 模式" in result
        assert handler.current_mode == "efficient"
        approval_server.setMode.assert_called_once_with("efficient")

    def test_switch_to_strict(self) -> None:
        approval_server = _make_approval_server()
        handler = _make_handler(approval_server=approval_server)
        result = handler._handleCcMode("strict")
        assert "已切换到 strict 模式" in result
        assert handler.current_mode == "strict"
        approval_server.setMode.assert_called_once_with("strict")

    def test_invalid_mode_shows_current_and_usage(self) -> None:
        handler = _make_handler()
        result = handler._handleCcMode("invalid")
        assert "当前模式" in result
        assert "efficient" in result
        assert "/cc_mode efficient" in result
        assert "/cc_mode strict" in result

    def test_no_arg_shows_current_and_usage(self) -> None:
        handler = _make_handler()
        result = handler._handleCcMode("")
        assert "当前模式" in result

    def test_switch_without_approval_server(self) -> None:
        handler = _make_handler(approval_server=None)
        result = handler._handleCcMode("strict")
        assert "已切换到 strict 模式" in result
        assert handler.current_mode == "strict"


# ---------------------------------------------------------------------------
# handleCommand dispatch
# ---------------------------------------------------------------------------

class TestHandleCommandDispatch:
    """Verify handleCommand dispatches to the correct handler."""

    @pytest.mark.asyncio
    async def test_unknown_command(self) -> None:
        handler = _make_handler()
        # handleCommand only dispatches known commands from COMMANDS list;
        # passing an arbitrary name falls through to the return at the end
        result = await handler.handleCommand("unknown_cmd", "", "user1", "ch1", "acc1")
        assert "未知命令" in result

    @pytest.mark.asyncio
    async def test_dispatch_cc(self) -> None:
        handler = _make_handler()
        result = await handler.handleCommand("cc", "", "user1", "ch1", "acc1")
        assert "用法: /cc <任务描述>" in result

    @pytest.mark.asyncio
    async def test_dispatch_cc_mode(self) -> None:
        handler = _make_handler()
        result = await handler.handleCommand("cc_mode", "strict", "user1", "ch1", "acc1")
        assert "已切换到 strict 模式" in result
