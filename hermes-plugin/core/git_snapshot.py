"""GitSnapshot — stash-based snapshot with message positioning and session state validation.

Port of openclaw-plugin/src/core/git-snapshot.js.
Uses asyncio subprocess for git commands.

Same stashRef format: CC-snapshot-{sessionId}-{timestamp}
Same stash apply (not pop) strategy.
Same cleanup_old_stashes static method (7-day default, skip active sessions).

See: cc-bridge-v3-final-plan.md Section 5
"""

import asyncio
import re
import time
from typing import Any

# Regex for sessionId format: cc-<timestamp>-<random>
SESSION_ID_REGEX = re.compile(r"CC-snapshot-(cc-\d+-[a-z0-9]+)-(\d+)")


class GitSnapshot:
    """Create, revert, and drop git stash snapshots for session rollback."""

    def __init__(self, bridge: Any, session_id: str) -> None:
        self.bridge = bridge
        self.session_id = session_id

    async def create(self) -> bool:
        """Create a stash snapshot of the current working tree state."""
        meta = self.bridge.session_meta.get(self.session_id)
        if not meta:
            return False

        stash_ref = f"CC-snapshot-{self.session_id}-{int(time.time() * 1000)}"

        # Sanitize stashRef to prevent shell injection
        safe_ref = re.sub(r"[^a-zA-Z0-9_.-]", "_", stash_ref)

        try:
            await self._git_exec("git add -A", cwd=meta["cwd"])
            await self._git_exec(
                f'git stash push -u -m "{safe_ref}"', cwd=meta["cwd"]
            )
            meta["stashRef"] = safe_ref
            return True
        except Exception:
            return False

    async def revert(self) -> dict[str, Any]:
        """Revert to the pre-task snapshot by applying the stash."""
        meta = self.bridge.session_meta.get(self.session_id)
        if not meta or not meta.get("stashRef"):
            return {"success": False, "message": "No matching snapshot found"}

        try:
            stash_list = await self._git_exec_output("git stash list", cwd=meta["cwd"])
            lines = stash_list.split("\n")
            idx = -1
            for i, line in enumerate(lines):
                if meta["stashRef"] in line:
                    idx = i
                    break

            if idx == -1:
                return {"success": False, "message": "Snapshot manually deleted or missing"}

            # Discard current working tree changes before applying stash
            try:
                await self._git_exec("git checkout -- .", cwd=meta["cwd"])
            except Exception:
                pass
            try:
                await self._git_exec("git clean -fd", cwd=meta["cwd"])
            except Exception:
                pass

            await self._git_exec(f"git stash apply stash@{{{idx}}}", cwd=meta["cwd"])

            # Clear stashRef to prevent duplicate revert
            meta["stashRef"] = None
            return {"success": True, "message": "Rolled back to pre-task state"}
        except Exception as err:
            return {"success": False, "message": f"Rollback failed: {err}"}

    async def dropStash(self) -> dict[str, Any]:
        """Drop the stash snapshot after session ends."""
        meta = self.bridge.session_meta.get(self.session_id)
        if not meta or not meta.get("stashRef"):
            return {"success": False, "message": "No matching snapshot found"}

        try:
            stash_list = await self._git_exec_output("git stash list", cwd=meta["cwd"])
            entries = stash_list.split("\n")
            idx = -1
            for i, line in enumerate(entries):
                if meta["stashRef"] in line:
                    idx = i
                    break

            if idx == -1:
                meta["stashRef"] = None
                return {"success": False, "message": "Snapshot manually deleted or missing"}

            await self._git_exec(f"git stash drop stash@{{{idx}}}", cwd=meta["cwd"])
            meta["stashRef"] = None
            return {"success": True, "message": "Snapshot dropped"}
        except Exception as err:
            return {"success": False, "message": f"Drop failed: {err}"}

    @staticmethod
    async def cleanupOldStashes(
        bridge: Any, cwd: str, cleanup_days: int = 7
    ) -> None:
        """Remove old stash snapshots that are not associated with active sessions."""
        try:
            stash_list = await GitSnapshot._git_exec_output_static("git stash list", cwd=cwd)
            cutoff = int(time.time() * 1000) - cleanup_days * 24 * 3600000
            entries = [line for line in stash_list.split("\n") if line.strip()]

            # Collect indices to drop (apply in reverse order)
            to_drop: list[int] = []
            for i, line in enumerate(entries):
                if "CC-snapshot-" not in line:
                    continue

                match = SESSION_ID_REGEX.search(line)
                if not match:
                    continue

                session_id = match.group(1)
                timestamp = int(match.group(2))

                # Safety check: skip active sessions
                meta = bridge.session_meta.get(session_id)
                if meta and meta.get("active"):
                    continue

                if timestamp < cutoff:
                    to_drop.append(i)

            # Drop in reverse order to preserve indices
            for idx in reversed(to_drop):
                try:
                    await GitSnapshot._git_exec_static(
                        f"git stash drop stash@{{{idx}}}", cwd=cwd
                    )
                except Exception:
                    pass
        except Exception:
            pass

    # ---- Helpers for async git execution ----

    async def _git_exec(self, cmd: str, cwd: str) -> None:
        """Run a git command, ignoring output. Raises on non-zero exit."""
        proc = await asyncio.create_subprocess_shell(
            cmd, cwd=cwd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
        if proc.returncode != 0:
            raise RuntimeError(f"git command failed: {cmd} (exit {proc.returncode})")

    async def _git_exec_output(self, cmd: str, cwd: str) -> str:
        """Run a git command and return its stdout."""
        proc = await asyncio.create_subprocess_shell(
            cmd, cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await proc.communicate()
        return stdout.decode("utf-8", errors="replace")

    @staticmethod
    async def _git_exec_static(cmd: str, cwd: str) -> None:
        """Static version of _git_exec for cleanupOldStashes."""
        proc = await asyncio.create_subprocess_shell(
            cmd, cwd=cwd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
        if proc.returncode != 0:
            raise RuntimeError(f"git command failed: {cmd} (exit {proc.returncode})")

    @staticmethod
    async def _git_exec_output_static(cmd: str, cwd: str) -> str:
        """Static version of _git_exec_output for cleanupOldStashes."""
        proc = await asyncio.create_subprocess_shell(
            cmd, cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await proc.communicate()
        return stdout.decode("utf-8", errors="replace")