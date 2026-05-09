"""CommandHandler — handles all 10 CC Bridge commands.

Port of the handleCommand logic from openclaw-plugin/src/plugin/index.js.
All 10 command handlers produce the same response text as the Node.js version.

See: cc-bridge-v3-final-plan.md Sections 7, 8
"""

import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Optional

from .approval_server import ApprovalServer
from .claude_bridge import ClaudeBridge
from .context_manager import ContextManager
from .git_snapshot import GitSnapshot
from .messenger import DefaultMessenger
from .session_manager import PersistentSessionManager

logger = logging.getLogger(__name__)


def formatToolInput(tool_name: str, raw_input: str) -> str:
    """Format tool input for display in approval notifications."""
    try:
        input_data = json.loads(raw_input)
        if tool_name == "Bash":
            return (input_data.get("command") or "(no command)")[:200]
        if tool_name in ("Write", "Edit"):
            return input_data.get("file_path") or "(no path)"
        return json.dumps(input_data)[:200]
    except (json.JSONDecodeError, TypeError):
        return (raw_input or "(no content)")[:200]


class CommandHandler:
    """Handle all CC Bridge slash commands."""

    def __init__(
        self,
        bridge: ClaudeBridge,
        approval_server: Optional[ApprovalServer],
        session_manager: PersistentSessionManager,
        messenger: DefaultMessenger,
        context_managers: dict[str, ContextManager],
        config: dict[str, Any],
    ) -> None:
        self.bridge = bridge
        self.approval_server = approval_server
        self.session_manager = session_manager
        self.messenger = messenger
        self.context_managers = context_managers
        self.config = config
        self.current_mode: str = config.get("defaultMode", "efficient")
        self.session_routes: dict[str, dict[str, str]] = {}

    def storeSessionRoute(
        self,
        session_id: str,
        sender_id: str,
        channel_id: str,
        account_id: str,
    ) -> None:
        """Store the routing info (sender, channel, account) for a session."""
        self.session_routes[session_id] = {
            "senderId": sender_id,
            "channelId": channel_id,
            "accountId": account_id,
        }

    def setupProcessForwarding(
        self, proc: Any, session_id: str
    ) -> None:
        """Set up stdout/stderr forwarding from the Claude process to the user.

        Reads from the process output stream and forwards lines
        via the messenger to the original sender.
        """
        route = self.session_routes.get(session_id)
        target = route.get("senderId") if route else None

        async def _forward_stdout() -> None:
            output_buffer = ""
            try:
                while True:
                    chunk = await proc.stdout.read(4096)
                    if not chunk:
                        break
                    output_buffer += chunk.decode("utf-8", errors="replace")
                    self.bridge.updateActivity(session_id)

                    lines = output_buffer.split("\n")
                    if len(lines) > 1:
                        output_buffer = lines.pop()
                        complete_lines = "\n".join(lines)
                        if complete_lines.strip() and target:
                            await self.messenger.send_to_user(
                                target, complete_lines,
                                {
                                    "channelId": route.get("channelId") if route else None,
                                    "accountId": route.get("accountId") if route else None,
                                },
                            )
            except Exception:
                logger.warning("stdout forwarding failed", exc_info=True)

            # Flush remaining buffer on exit
            if output_buffer.strip() and target:
                await self.messenger.send_to_user(
                    target, output_buffer.strip(),
                    {
                        "channelId": route.get("channelId") if route else None,
                        "accountId": route.get("accountId") if route else None,
                    },
                )

        async def _forward_stderr() -> None:
            try:
                while True:
                    chunk = await proc.stderr.read(4096)
                    if not chunk:
                        break
                    text = chunk.decode("utf-8", errors="replace").strip()
                    if text and target:
                        await self.messenger.send_to_user(
                            target,
                            self.messenger.formatErrorMessage(text),
                            {
                                "channelId": route.get("channelId") if route else None,
                                "accountId": route.get("accountId") if route else None,
                            },
                        )
            except Exception:
                logger.warning("stderr forwarding failed", exc_info=True)

        async def _on_exit() -> None:
            await proc.wait()
            exit_code = proc.returncode
            if exit_code not in (0, None) and target:
                await self.messenger.send_to_user(
                    target,
                    f"会话进程退出 (code: {exit_code})",
                    {
                        "channelId": route.get("channelId") if route else None,
                        "accountId": route.get("accountId") if route else None,
                    },
                )
            self.session_routes.pop(session_id, None)

        # Schedule forwarding tasks
        import asyncio
        asyncio.create_task(_forward_stdout())
        asyncio.create_task(_forward_stderr())
        asyncio.create_task(_on_exit())

    async def handleCommand(
        self,
        command_name: str,
        args: str,
        sender_id: str,
        channel_id: str,
        account_id: str,
    ) -> str:
        """Dispatch and handle a CC Bridge command. Returns the response text."""

        # /cc <prompt> — one-shot task
        if command_name == "cc":
            return await self._handleCc(args, sender_id, channel_id, account_id)

        # /cc_start — start persistent session
        if command_name == "cc_start":
            return await self._handleCcStart(sender_id, channel_id, account_id)

        # /cc_stop — stop persistent session
        if command_name == "cc_stop":
            return await self._handleCcStop(sender_id)

        # /cc_status — check session status
        if command_name == "cc_status":
            return self._handleCcStatus(sender_id)

        # /cc_answer — reply to Claude's question
        if command_name == "cc_answer":
            return await self._handleCcAnswer(args, sender_id)

        # /cc_approve — approve a pending request
        if command_name == "cc_approve":
            return self._handleCcApprove(args, sender_id)

        # /cc_deny — deny a pending request
        if command_name == "cc_deny":
            return self._handleCcDeny(args, sender_id)

        # /cc_revert — rollback code changes
        if command_name == "cc_revert":
            return await self._handleCcRevert(args, sender_id)

        # /cc_context — view project context
        if command_name == "cc_context":
            return await self._handleCcContext(sender_id)

        # /cc_mode — switch approval mode
        if command_name == "cc_mode":
            return self._handleCcMode(args)

        return f"未知命令: {command_name}"

    # ---- Individual command handlers ----

    async def _handleCc(
        self, args: str, sender_id: str, channel_id: str, account_id: str
    ) -> str:
        """Handle /cc <prompt> — one-shot task."""
        prompt = args.strip()
        if not prompt:
            return "用法: /cc <任务描述>"

        workspace = self.config.get("workspace", os.getcwd())
        existing_session_id = self.bridge.findActiveSession(sender_id)
        if existing_session_id:
            proc = self.bridge.process_map.get(existing_session_id)
            if proc and proc.returncode is None:
                proc.stdin.write(prompt.encode("utf-8") + b"\n")
                await proc.stdin.drain()
                self.bridge.updateActivity(existing_session_id)
                return "已发送到持久会话。"

        result = await self.bridge.spawnSession(sender_id, workspace, prompt)
        session_id = result["sessionId"]
        self.storeSessionRoute(session_id, sender_id, channel_id, account_id)
        proc = self.bridge.process_map.get(session_id)
        if proc:
            self.setupProcessForwarding(proc, session_id)

        return f"任务已提交 (ID: {session_id[:8]})"

    async def _handleCcStart(
        self, sender_id: str, channel_id: str, account_id: str
    ) -> str:
        """Handle /cc_start — start persistent session."""
        workspace = self.config.get("workspace", os.getcwd())
        existing = self.bridge.findActiveSession(sender_id)
        if existing:
            meta = self.bridge.session_meta.get(existing)
            proc = self.bridge.process_map.get(existing)
            return self.messenger.formatSessionStatus(meta, proc, existing)

        result = await self.bridge.spawnSession(sender_id, workspace, "")
        session_id = result["sessionId"]
        self.storeSessionRoute(session_id, sender_id, channel_id, account_id)
        self.session_manager.activate(sender_id, workspace, session_id)

        proc = self.bridge.process_map.get(session_id)
        if proc:
            self.setupProcessForwarding(proc, session_id)

        context_manager = self.context_managers.get(workspace)
        if not context_manager:
            context_manager = ContextManager(workspace)
            self.context_managers[workspace] = context_manager
        context_manager.cleanOrphanedRules(self.bridge)
        context_manager.injectRules()

        git_snapshot_enabled = self.config.get("gitSnapshotEnabled", True)
        snapshot = GitSnapshot(self.bridge, session_id)
        snapshot_created = (
            await snapshot.create() if git_snapshot_enabled else False
        )

        port = self.approval_server.getPort() if self.approval_server else None

        return (
            f"持久会话已启动 (ID: {session_id[:8]})\n"
            f"模式: {self.current_mode}\n"
            f"审批服务端口: {port}\n"
            f"快照: {'已创建' if snapshot_created else '未创建（非Git目录）'}"
        )

    async def _handleCcStop(self, sender_id: str) -> str:
        """Handle /cc_stop — stop persistent session."""
        session_id = self.bridge.findActiveSession(sender_id)
        if not session_id or not self.bridge.session_meta.get(session_id, {}).get("active"):
            return "当前没有持久会话。"

        meta = self.bridge.session_meta.get(session_id)
        if meta and meta.get("senderId") != sender_id:
            return "无权停止该会话，只有会话创建者可以停止。"

        self.bridge.terminateSession(session_id)
        self.session_manager.deactivate(sender_id)
        self.session_routes.pop(session_id, None)

        snapshot = GitSnapshot(self.bridge, session_id)
        if meta and meta.get("stashRef"):
            await snapshot.dropStash()

        cwd = meta.get("cwd") if meta else None
        cm = self.context_managers.get(cwd) if cwd else None
        if cm:
            cm.cleanup()
            self.context_managers.pop(cwd, None)

        if cwd:
            await GitSnapshot.cleanupOldStashes(self.bridge, cwd)

        runtime = 0
        if meta:
            started_ms = datetime.fromisoformat(meta["startedAt"]).timestamp() * 1000
            runtime = round((time.time() * 1000 - started_ms) / 60000)

        message_count = meta.get("messageCount", 0) if meta else 0
        return (
            f"会话已停止 (ID: {session_id[:8]})\n"
            f"运行时长: {runtime} 分钟\n"
            f"消息数: {message_count}"
        )

    def _handleCcStatus(self, sender_id: str) -> str:
        """Handle /cc_status — check session status."""
        session_id = self.bridge.findActiveSession(sender_id)
        if not session_id:
            return "当前没有活跃的持久会话。"
        meta = self.bridge.session_meta.get(session_id)
        proc = self.bridge.process_map.get(session_id)
        return self.messenger.formatSessionStatus(meta, proc, session_id)

    async def _handleCcAnswer(self, args: str, sender_id: str) -> str:
        """Handle /cc_answer <text> — reply to Claude's question."""
        answer = args.strip()
        if not answer:
            return "用法: /cc_answer <回答内容>"

        session_id = self.bridge.findActiveSession(sender_id)
        if not session_id:
            return "没有活跃会话。"

        proc = self.bridge.process_map.get(session_id)
        if proc and proc.returncode is None:
            proc.stdin.write(answer.encode("utf-8") + b"\n")
            await proc.stdin.drain()
            self.bridge.updateActivity(session_id)
            return "已发送回答。"
        return "会话进程已退出，无法回答。"

    def _handleCcApprove(self, args: str, sender_id: str) -> str:
        """Handle /cc_approve <id> — approve a pending request."""
        short_id = args.strip()
        if not short_id:
            return "用法: /cc_approve <审批ID>"

        if not self.approval_server:
            return "审批服务未启动。"

        item = self.approval_server.store.findByShortId(short_id)
        if not item:
            return "未找到该审批请求。"
        if isinstance(item, dict) and item.get("ambiguous"):
            matches = item.get("matches", [])
            ids = ", ".join(m.get("id", "")[:12] for m in matches)
            return f'ID "{short_id}" 匹配到多个请求，请使用更长的ID。\n匹配: {ids}'
        if item.get("status") != "PENDING":
            return f"该请求已处理: {item.get('status')}"

        meta = self.bridge.session_meta.get(item.get("sessionId"))
        if meta and meta.get("senderId") != sender_id:
            return "无权审批该请求，只有会话创建者可以操作。"

        self.approval_server.store.resolve(item["id"], "APPROVED")
        return f"已批准 #{short_id}: {item.get('toolName')}"

    def _handleCcDeny(self, args: str, sender_id: str) -> str:
        """Handle /cc_deny <id> — deny a pending request."""
        short_id = args.strip()
        if not short_id:
            return "用法: /cc_deny <审批ID>"

        if not self.approval_server:
            return "审批服务未启动。"

        item = self.approval_server.store.findByShortId(short_id)
        if not item:
            return "未找到该审批请求。"
        if isinstance(item, dict) and item.get("ambiguous"):
            matches = item.get("matches", [])
            ids = ", ".join(m.get("id", "")[:12] for m in matches)
            return f'ID "{short_id}" 匹配到多个请求，请使用更长的ID。\n匹配: {ids}'
        if item.get("status") != "PENDING":
            return f"该请求已处理: {item.get('status')}"

        meta = self.bridge.session_meta.get(item.get("sessionId"))
        if meta and meta.get("senderId") != sender_id:
            return "无权审批该请求，只有会话创建者可以操作。"

        self.approval_server.store.resolve(item["id"], "DENIED")
        return f"已拒绝 #{short_id}: {item.get('toolName')}"

    async def _handleCcRevert(self, args: str, sender_id: str) -> str:
        """Handle /cc_revert — rollback code changes."""
        revert_args = args.strip()

        if revert_args == "--confirm":
            session_id = self.bridge.findActiveSession(sender_id)
            if not session_id:
                return "没有活跃的会话。"

            meta = self.bridge.session_meta.get(session_id)
            if not meta or not meta.get("stashRef"):
                return "无可用的快照，无法回滚。（可能已回滚过或启动时未创建快照）"

            snapshot = GitSnapshot(self.bridge, session_id)
            result = await snapshot.revert()
            if result.get("success"):
                return "已回滚到任务前状态。"
            return f"回滚失败: {result.get('message')}"

        if revert_args == "--cancel":
            return "已取消回滚。"

        session_id = self.bridge.findActiveSession(sender_id)
        if not session_id:
            return "没有活跃的会话。"

        meta = self.bridge.session_meta.get(session_id)
        if not meta or not meta.get("stashRef"):
            return "无可用的快照。（可能已回滚过或启动时未创建快照）"

        return (
            "确认回滚？\n"
            "将恢复到上次 CC 任务前的状态。\n\n"
            "确认: /cc_revert --confirm\n"
            "取消: /cc_revert --cancel"
        )

    async def _handleCcContext(self, sender_id: str) -> str:
        """Handle /cc_context — view project context."""
        session_id = self.bridge.findActiveSession(sender_id)
        if not session_id:
            return "没有活跃会话。"

        meta = self.bridge.session_meta.get(session_id)
        if not meta:
            return "没有活跃会话。"

        cm = self.context_managers.get(meta.get("cwd"))
        context_info = (
            await cm.buildContextPrompt(meta["cwd"]) if cm else "(无上下文)"
        )
        return f"当前项目上下文:\n\n{context_info}"

    def _handleCcMode(self, args: str) -> str:
        """Handle /cc_mode [efficient|strict] — switch approval mode."""
        mode = args.strip()
        if not mode or mode not in ("efficient", "strict"):
            return (
                f"当前模式: {self.current_mode}\n"
                "efficient — Edit/Write 免审批，仅 Bash 需审批\n"
                "strict — 全部操作需审批\n\n"
                "切换: /cc_mode efficient 或 /cc_mode strict"
            )

        if self.approval_server:
            self.approval_server.setMode(mode)
        self.current_mode = mode
        return f"已切换到 {mode} 模式。"