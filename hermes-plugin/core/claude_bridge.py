"""ClaudeBridge — dual dict architecture, process lifecycle management.

Port of openclaw-plugin/src/core/claude-bridge.js.
Uses asyncio subprocess for spawning the 'claude' CLI.

See: cc-bridge-v3-final-plan.md Section 2
"""

import asyncio
import os
import random
import string
import time
from datetime import datetime, timezone
from typing import Any, Optional

from .utils import acquire_workspace_lock, release_workspace_lock


DEFAULT_HEARTBEAT_INTERVAL: int = 60000   # 60s in ms
DEFAULT_SESSION_TIMEOUT: int = 1800000    # 30min in ms


class ClaudeBridge:
    """Manage Claude Code CLI subprocess sessions with dual-dict tracking."""

    def __init__(self, options: dict[str, Any] | None = None) -> None:
        options = options or {}
        self.process_map: dict[str, asyncio.subprocess.Process] = {}
        self.session_meta: dict[str, dict[str, Any]] = {}
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._heartbeat_interval: int = options.get(
            "heartbeatInterval", DEFAULT_HEARTBEAT_INTERVAL
        )
        self._session_timeout: int = options.get(
            "sessionTimeout", DEFAULT_SESSION_TIMEOUT
        )

    def findActiveSession(self, sender_id: str) -> Optional[str]:
        """Find an active session for a given sender ID."""
        for sid, meta in self.session_meta.items():
            if meta.get("senderId") == sender_id and meta.get("active"):
                return sid
        return None

    def checkSessionAlive(self, session_id: str) -> dict[str, Any]:
        """Check whether a session process is still alive.

        Returns {"alive": True/False}. Cleans up dead entries.
        """
        proc = self.process_map.get(session_id)
        if proc is None:
            meta = self.session_meta.get(session_id)
            if meta and meta.get("lockRelease"):
                try:
                    release_workspace_lock(meta["lockRelease"])
                except Exception:
                    pass
                meta["lockRelease"] = None
            self.session_meta.pop(session_id, None)
            return {"alive": False}

        if proc.returncode is not None:
            self.process_map.pop(session_id, None)
            meta = self.session_meta.get(session_id)
            if meta and meta.get("lockRelease"):
                try:
                    release_workspace_lock(meta["lockRelease"])
                except Exception:
                    pass
                meta["lockRelease"] = None
            self.session_meta.pop(session_id, None)
            return {"alive": False}

        return {"alive": True}

    async def spawnSession(
        self,
        sender_id: str,
        workspace: str,
        prompt: str,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Spawn a new Claude CLI session or reuse an existing one.

        Returns {"sessionId": str, "reused": bool}.
        """
        options = options or {}
        existing = self.findActiveSession(sender_id)
        if existing:
            return {"sessionId": existing, "reused": True}

        # Acquire workspace lock to prevent concurrent sessions
        lock_release = acquire_workspace_lock(workspace)

        # Session ID format: cc-{timestamp}-{random6}
        timestamp = int(time.time() * 1000)
        random_part = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
        session_id = f"cc-{timestamp}-{random_part}"

        is_one_shot = bool(prompt)
        args: list[str] = []
        if is_one_shot:
            args.extend(["--print", prompt])
        if options.get("model"):
            args.extend(["--model", options["model"]])
        if options.get("allowedTools"):
            args.extend(["--allowedTools", options["allowedTools"]])

        env = {**os.environ, "CLAUDE_SESSION_ID": session_id}
        proc = await asyncio.create_subprocess_exec(
            "claude", *args,
            cwd=workspace,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # Initialize session metadata
        self.session_meta[session_id] = {
            "senderId": sender_id,
            "cwd": workspace,
            "sessionId": session_id,
            "active": True,
            "startedAt": datetime.now(timezone.utc).isoformat(),
            "lastActiveAt": datetime.now(timezone.utc).isoformat(),
            "messageCount": 0,
            "processAlive": True,
            "stashRef": None,
            "lockRelease": lock_release,
        }

        # Register process
        self.process_map[session_id] = proc

        # Start heartbeat
        self.startHeartbeat()

        return {"sessionId": session_id, "reused": False}

    def terminateSession(self, session_id: str) -> None:
        """Terminate a session process and release its workspace lock."""
        proc = self.process_map.pop(session_id, None)
        meta = self.session_meta.get(session_id)

        if proc and proc.returncode is None:
            proc.kill()

        if meta:
            meta["active"] = False
            # Release workspace lock
            if meta.get("lockRelease"):
                try:
                    release_workspace_lock(meta["lockRelease"])
                except Exception:
                    pass
                meta["lockRelease"] = None

    def startHeartbeat(self) -> None:
        """Start the periodic heartbeat check for session timeouts."""
        if self._heartbeat_task is not None:
            return

        async def _heartbeat_loop() -> None:
            while True:
                await asyncio.sleep(self._heartbeat_interval / 1000)
                # Iterate a snapshot to avoid concurrent modification
                entries = list(self.session_meta.items())
                for sid, meta in entries:
                    alive = self.checkSessionAlive(sid)
                    if not alive.get("alive"):
                        self.terminateSession(sid)
                        continue

                    last_active = datetime.fromisoformat(meta["lastActiveAt"]).timestamp() * 1000
                    if time.time() * 1000 - last_active > self._session_timeout:
                        self.terminateSession(sid)

                # Stop heartbeat if no active sessions
                has_active = any(m.get("active") for m in self.session_meta.values())
                if not has_active:
                    self.stopHeartbeat()
                    return

        self._heartbeat_task = asyncio.ensure_future(_heartbeat_loop())

    def stopHeartbeat(self) -> None:
        """Stop the heartbeat timer."""
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            self._heartbeat_task = None

    def updateActivity(self, session_id: str) -> None:
        """Update lastActiveAt and increment messageCount for a session."""
        meta = self.session_meta.get(session_id)
        if meta:
            meta["lastActiveAt"] = datetime.now(timezone.utc).isoformat()
            meta["messageCount"] = meta.get("messageCount", 0) + 1