"""CommandParser — parse messaging commands for Claude Code gateway.

Port of openclaw-plugin/src/core/command-parser.js.
Same 10 commands list, same parse logic, same help text format.

See: cc-bridge-v3-final-plan.md Section 7.1
"""

COMMANDS: list[str] = [
    "cc",
    "cc_start",
    "cc_stop",
    "cc_status",
    "cc_answer",
    "cc_approve",
    "cc_deny",
    "cc_revert",
    "cc_context",
    "cc_mode",
]


class CommandParser:
    """Parse slash commands for the CC Bridge."""

    def parse(self, text: str | None) -> dict | None:
        """Parse a command string.

        Returns:
            - {"command": str, "args": str, "unknown": False} for known commands
            - {"command": None, "args": str, "unknown": True} for unknown commands
            - None if the text does not start with /
        """
        trimmed = (text or "").strip()
        if not trimmed.startswith("/"):
            return None

        without_slash = trimmed[1:]
        space_idx = without_slash.find(" ")
        if space_idx == -1:
            command_name = without_slash
            args = ""
        else:
            command_name = without_slash[:space_idx]
            args = without_slash[space_idx + 1:].strip()

        if command_name not in COMMANDS:
            return {"command": None, "args": trimmed, "unknown": True}

        return {"command": command_name, "args": args, "unknown": False}

    def getCommands(self) -> list[str]:
        """Return the list of valid command names."""
        return list(COMMANDS)

    def getHelpText(self) -> str:
        """Return formatted help text for all commands."""
        return "\n".join([
            "CC Bridge 命令列表:",
            "/cc <prompt> — 发送任务到 Claude Code",
            "/cc_start — 启动持久会话",
            "/cc_stop — 停止持久会话",
            "/cc_status — 查看会话状态",
            "/cc_answer <text> — 回答 Claude Code 的问题",
            "/cc_approve <id> — 批准审批请求",
            "/cc_deny <id> — 拒绝审批请求",
            "/cc_revert — 回滚代码变更",
            "/cc_context — 查看项目上下文",
            "/cc_mode [efficient|strict] — 切换审批模式",
        ])