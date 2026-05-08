"""Messenger — bidirectional message formatting and delivery.

Port of openclaw-plugin/src/core/feishu-messenger.js.
DefaultMessenger has all formatting logic (approval notifications, error messages,
session status, tool progress). send_to_user is abstract (raises NotImplementedError).
PlatformMessenger subclass delegates to a delivery callback.

Same split_message algorithm (MAX_MESSAGE_LENGTH=4000, code block preservation).
"""

import math
import time
from datetime import datetime, timezone
from typing import Any, Callable, Optional

MAX_MESSAGE_LENGTH: int = 4000
CODE_BLOCK_MARKER: str = "```"


class DefaultMessenger:
    """Base messenger with formatting logic. send_to_user must be overridden."""

    def __init__(self, max_message_length: int = MAX_MESSAGE_LENGTH) -> None:
        self.max_message_length: int = max_message_length

    async def send_to_user(
        self,
        target: str,
        text: str,
        options: dict[str, Any] | None = None,
    ) -> int:
        """Send a message to a user/chat. Must be overridden by subclasses.

        Returns the number of message chunks sent.
        """
        raise NotImplementedError("send_to_user must be implemented by subclass")

    def formatCodeBlock(self, code: str, language: str = "") -> str:
        """Format a code block with optional language hint."""
        return f"{CODE_BLOCK_MARKER}{language}\n{code}\n{CODE_BLOCK_MARKER}"

    def formatApprovalNotification(
        self,
        approval_id: str,
        tool_name: str,
        input_preview: str,
        cwd: str,
    ) -> str:
        """Format an approval request notification for display."""
        short_id = approval_id[:8]
        return "\n".join([
            f"审批请求 #{short_id}",
            f"工具: {tool_name}",
            f"内容: {input_preview}",
            f"目录: {cwd}",
            "",
            f"批准: /cc_approve {short_id}",
            f"拒绝: /cc_deny {short_id}",
        ])

    def formatToolProgress(
        self, tool_name: str, status: str, detail: str = ""
    ) -> str:
        """Format a tool execution progress line."""
        if status == "success":
            icon = "✓"
            summary = "成功"
        elif status == "error":
            icon = "✗"
            summary = f"失败: {detail[:80] or '未知错误'}"
        else:
            icon = "→"
            summary = detail
        return f"{icon} {tool_name}: {summary}"

    def formatErrorMessage(self, error: Any) -> str:
        """Format an error message for display."""
        if isinstance(error, str):
            msg = error
        elif isinstance(error, Exception):
            msg = str(error) or "未知错误"
        else:
            msg = "未知错误"
        return f"错误: {msg[:500]}"

    def formatSessionStatus(
        self,
        meta: dict[str, Any],
        proc: Any,
        session_id: str,
    ) -> str:
        """Format a session status display message."""
        now_ms = time.time() * 1000
        started_ms = datetime.fromisoformat(meta["startedAt"]).timestamp() * 1000
        runtime = round((now_ms - started_ms) / 60000)
        last_active_ms = datetime.fromisoformat(meta["lastActiveAt"]).timestamp() * 1000
        last_active = round((now_ms - last_active_ms) / 60000)

        proc_alive = (
            proc is not None and proc.returncode is None
        ) if hasattr(proc, "returncode") else False
        process_status = "存活" if proc_alive else "已退出"

        return "\n".join([
            "持久会话状态",
            f"工作目录: {meta.get('cwd', '')}",
            f"会话ID: {session_id[:8]}",
            f"运行时长: {runtime} 分钟",
            f"消息数: {meta.get('messageCount', 0)}",
            f"最后活动: {last_active} 分钟前",
            f"进程状态: {process_status}",
        ])

    def splitMessage(self, text: str) -> list[str]:
        """Split a long message into chunks respecting code block boundaries.

        Preserves code blocks across splits by never splitting inside
        an odd number of code block markers.
        """
        if not text or len(text) <= self.max_message_length:
            return [text or ""]

        chunks: list[str] = []
        remaining = text

        while remaining:
            if len(remaining) <= self.max_message_length:
                chunks.append(remaining)
                break

            split_at = self._findSplitPoint(remaining, self.max_message_length)
            split_at = max(split_at, 1)

            # Preserve code blocks across splits
            before_split = remaining[:split_at]
            code_block_count = self._countCodeBlockMarkers(before_split)
            if code_block_count % 2 != 0:
                last_marker = before_split.rfind(CODE_BLOCK_MARKER)
                if last_marker > 0:
                    split_at = last_marker

            chunks.append(remaining[:split_at])
            remaining = remaining[split_at:]

        return chunks

    def _findSplitPoint(self, text: str, max_length: int) -> int:
        """Find a suitable split point near max_length, preferring newline breaks."""
        search_start = max(0, max_length - 200)
        search_end = min(len(text), max_length)

        for i in range(search_end, search_start - 1, -1):
            if i < len(text) and text[i] == "\n":
                return i + 1

        return max_length

    def _countCodeBlockMarkers(self, text: str) -> int:
        """Count the number of code block markers (```) in a text."""
        count = 0
        pos = 0
        while True:
            idx = text.find(CODE_BLOCK_MARKER, pos)
            if idx == -1:
                break
            count += 1
            pos = idx + len(CODE_BLOCK_MARKER)
        return count


class PlatformMessenger(DefaultMessenger):
    """Messenger that delegates message delivery to an outbound callback.

    The delivery callback receives (target, text, options) and handles
    platform-specific routing (e.g. Feishu, Slack, Discord).
    """

    def __init__(
        self,
        delivery_callback: Callable[..., Any],
        max_message_length: int = MAX_MESSAGE_LENGTH,
    ) -> None:
        super().__init__(max_message_length)
        self._delivery_callback: Callable[..., Any] = delivery_callback

    async def send_to_user(
        self,
        target: str,
        text: str,
        options: dict[str, Any] | None = None,
    ) -> int:
        """Send a message to a user via the delivery callback."""
        options = options or {}
        chunks = self.splitMessage(text)

        for chunk in chunks:
            await self._delivery_callback(
                target=target,
                text=chunk,
                options=options,
            )

        return len(chunks)