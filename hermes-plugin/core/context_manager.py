"""ContextManager — CLAUDE.md marker injection + temporary context.

Port of openclaw-plugin/src/core/context-manager.js.
Same RULES_START/RULES_END markers.
Same inject/cleanup/orphan detection logic.
Same buildContextPrompt (git branch, recent files, directory listing).

See: cc-bridge-v3-final-plan.md Section 6
"""

import asyncio
import logging
import os
import pathlib
import re
from typing import Any

from .utils import atomic_write_sync

logger = logging.getLogger(__name__)

RULES_START = "<!-- CC-BRIDGE-RULES:START -->"
RULES_END = "<!-- CC-BRIDGE-RULES:END -->"


class ContextManager:
    """Manage CLAUDE.md rule injection and context prompts."""

    def __init__(self, workspace: str) -> None:
        self.workspace: str = workspace
        self.claude_md_path: str = os.path.join(workspace, "CLAUDE.md")
        self.rules_content: str = self._load_bridge_rules()

    def _load_bridge_rules(self) -> str:
        """Load the bridge rules template from the core package directory."""
        rules_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "bridge_rules_template.md",
        )
        if os.path.exists(rules_path):
            with open(rules_path, "r", encoding="utf-8") as fh:
                return fh.read()
        return ""

    def injectRules(self) -> None:
        """Inject bridge rules into CLAUDE.md, removing any previous injection first."""
        content = ""
        if os.path.exists(self.claude_md_path):
            with open(self.claude_md_path, "r", encoding="utf-8") as fh:
                content = fh.read()

        content = self._removeInjectedRules(content)

        injected = f"{RULES_START}\n{self.rules_content}\n{RULES_END}"
        content += f"\n\n{injected}"

        atomic_write_sync(self.claude_md_path, content)

    def cleanOrphanedRules(self, bridge: Any) -> bool:
        """Remove injected rules from CLAUDE.md if no active session for this workspace.

        Returns True if rules were cleaned, False otherwise.
        """
        if not os.path.exists(self.claude_md_path):
            return False

        with open(self.claude_md_path, "r", encoding="utf-8") as fh:
            content = fh.read()

        if RULES_START not in content:
            return False

        has_active_session = any(
            meta.get("active") and meta.get("cwd") == self.workspace
            for meta in bridge.session_meta.values()
        )

        if not has_active_session:
            cleaned = self._removeInjectedRules(content)
            atomic_write_sync(self.claude_md_path, cleaned)
            return True

        return False

    def _removeInjectedRules(self, content: str) -> str:
        """Remove any previously injected rules block from content."""
        escaped_start = re.escape(RULES_START)
        escaped_end = re.escape(RULES_END)
        regex = re.compile(f"{escaped_start}.*?{escaped_end}", re.DOTALL)
        return regex.sub("", content).strip()

    def cleanup(self) -> None:
        """Remove injected rules from CLAUDE.md on session stop."""
        if not os.path.exists(self.claude_md_path):
            return
        with open(self.claude_md_path, "r", encoding="utf-8") as fh:
            content = fh.read()
        cleaned = self._removeInjectedRules(content)
        atomic_write_sync(self.claude_md_path, cleaned)

    async def buildContextPrompt(self, workspace: str) -> str:
        """Build a context prompt with git branch, recent files, and directory listing."""
        parts: list[str] = []

        try:
            proc = await asyncio.create_subprocess_exec(
                "git", "branch", "--show-current",
                cwd=workspace,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await proc.communicate()
            branch = stdout.decode("utf-8", errors="replace").strip()
            if branch:
                parts.append(f"当前分支: {branch}")
        except Exception:
            logger.warning("git branch query failed", exc_info=True)

        try:
            proc = await asyncio.create_subprocess_exec(
                "git", "diff", "--name-only", "HEAD~5",
                cwd=workspace,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await proc.communicate()
            files = stdout.decode("utf-8", errors="replace").strip()
            if files:
                lines = files.split("\n")[:20]
                parts.append(f"最近修改的文件:\n" + "\n".join(lines))
        except Exception:
            logger.warning("git diff query failed", exc_info=True)

        # Cross-platform directory listing without shell injection risk
        try:
            entries = os.listdir(workspace)
            parts.append(f"工作目录内容:\n" + "\n".join(entries))
        except Exception:
            logger.warning("directory listing failed", exc_info=True)

        return "\n\n".join(parts)