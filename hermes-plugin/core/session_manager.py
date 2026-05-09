"""PersistentSessionManager — compound-key session isolation.

Port of openclaw-plugin/src/core/persistent-session-manager.js.
Same compound key format: senderId::workspace
Same JSON file format for interoperability with Node.js version.

See: cc-bridge-v3-final-plan.md Section 8
"""

import json
import logging
import os
from typing import Any, Optional

from .utils import atomic_write_sync, iso_timestamp, safe_load_json

logger = logging.getLogger(__name__)


class PersistentSessionManager:
    """Manage persistent session state via atomic JSON file writes."""

    def __init__(self, data_dir: str) -> None:
        self.data_dir: str = data_dir
        self.sessions_path: str = os.path.join(data_dir, "persistent-sessions.json")

    def getKey(self, sender_id: str, workspace: str) -> str:
        """Construct the compound key: senderId::workspace."""
        return f"{sender_id}::{workspace}"

    def activate(
        self, sender_id: str, workspace: str, session_id: str
    ) -> dict[str, Any]:
        """Activate a persistent session and persist it."""
        sessions = safe_load_json(self.sessions_path)
        key = self.getKey(sender_id, workspace)

        sessions[key] = {
            "senderId": sender_id,
            "workspace": workspace,
            "sessionId": session_id,
            "active": True,
            "startedAt": iso_timestamp(),
            "lastActiveAt": iso_timestamp(),
            "messageCount": 0,
            "processAlive": True,
        }

        atomic_write_sync(self.sessions_path, json.dumps(sessions, indent=2))
        return sessions[key]

    def getActive(self, sender_id: str) -> Optional[dict[str, Any]]:
        """Find the active session for a given sender ID."""
        sessions = safe_load_json(self.sessions_path)
        for key, session in sessions.items():
            if session.get("senderId") == sender_id and session.get("active"):
                return session
        return None

    def deactivate(self, sender_id: str) -> None:
        """Deactivate the active session for a given sender ID."""
        sessions = safe_load_json(self.sessions_path)
        active = self.getActive(sender_id)
        if active:
            key = self.getKey(sender_id, active.get("workspace", ""))
            if key in sessions:
                sessions[key]["active"] = False
                sessions[key]["stoppedAt"] = iso_timestamp()
                atomic_write_sync(
                    self.sessions_path,
                    json.dumps(sessions, indent=2),
                )