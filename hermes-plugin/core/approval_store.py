"""ApprovalStore — atomic JSON persistence for approval requests.

Port of openclaw-plugin/src/core/approval-store.js.
CRITICAL: Must use the EXACT same JSON format so data is interoperable
with the Node.js version.

See: cc-bridge-v3-final-plan.md Section 3.5
"""

import json
import logging
import os
import uuid
from typing import Any, Optional

from .utils import atomic_write_sync, iso_timestamp

logger = logging.getLogger(__name__)


class ApprovalStore:
    """Persistent store for approval requests using atomic JSON writes."""

    def __init__(self, data_dir: str) -> None:
        self.file_path: str = os.path.join(data_dir, "approval-requests.json")
        self.requests: dict[str, dict[str, Any]] = {}
        self._timed_out_on_load: int = 0
        self._load()

    def _load(self) -> None:
        """Load persisted requests, marking any PENDING as TIMEOUT."""
        self._timed_out_on_load = 0
        try:
            if os.path.exists(self.file_path):
                with open(self.file_path, "r", encoding="utf-8") as fh:
                    items = json.load(fh)
                for item in items:
                    if item.get("status") == "PENDING":
                        item["status"] = "TIMEOUT"
                        self._timed_out_on_load += 1
                    self.requests[item["id"]] = item
        except (json.JSONDecodeError, OSError):
            # File corrupt or missing, start fresh
            logger.warning("approval store load failed, starting fresh", exc_info=True)
            pass

    def _load_timed_out_count(self) -> int:
        """Reload and return count of requests that timed out."""
        self._load()
        return self._timed_out_on_load

    def _flush(self) -> None:
        """Persist all requests to disk via atomic write."""
        data = json.dumps(list(self.requests.values()), indent=2)
        atomic_write_sync(self.file_path, data)

    def create(self, params: dict[str, Any]) -> str:
        """Create a new PENDING approval request. Returns the UUID id."""
        id_ = str(uuid.uuid4())
        self.requests[id_] = {
            "id": id_,
            "sessionId": params["sessionId"],
            "toolName": params["toolName"],
            "toolInput": params["toolInput"],
            "cwd": params["cwd"],
            "status": "PENDING",
            "createdAt": iso_timestamp(),
        }
        self._flush()
        return id_

    def get(self, id_: str) -> Optional[dict[str, Any]]:
        """Return a request by its full UUID, or None."""
        return self.requests.get(id_)

    def findByShortId(self, short_id: str) -> Optional[Any]:
        """Find a request by a short ID prefix (e.g. first 8 chars).

        Returns:
            - The matching item dict if exactly one match
            - A dict {"ambiguous": True, "matches": [...]} if multiple matches
            - None if no matches
        """
        matches: list[dict[str, Any]] = []
        for id_, item in self.requests.items():
            if id_.startswith(short_id):
                matches.append(item)

        if len(matches) == 0:
            return None
        if len(matches) > 1:
            return {"ambiguous": True, "matches": matches}
        return matches[0]

    def findBySessionId(self, session_id: str) -> list[dict[str, Any]]:
        """Return all requests for a given session ID."""
        return [
            item
            for item in self.requests.values()
            if item.get("sessionId") == session_id
        ]

    def listPending(self) -> list[dict[str, Any]]:
        """Return all PENDING requests."""
        return [
            item
            for item in self.requests.values()
            if item.get("status") == "PENDING"
        ]

    def resolve(self, id_: str, status: str) -> Optional[dict[str, Any]]:
        """Resolve a request by setting its status. Returns the item or None."""
        item = self.requests.get(id_)
        if item is not None:
            item["status"] = status
            item["resolvedAt"] = iso_timestamp()
            self._flush()
        return item

    def markAllPendingAsTimeout(self) -> None:
        """Mark every PENDING request as TIMEOUT (used on shutdown)."""
        for item in self.requests.values():
            if item.get("status") == "PENDING":
                item["status"] = "TIMEOUT"

    def flush(self) -> None:
        """Public flush — persist current state to disk."""
        self._flush()

    def cleanup(self) -> None:
        """Remove resolved/timeout/denied items older than 1 hour."""
        from datetime import datetime, timezone
        cutoff = datetime.now(timezone.utc).timestamp() * 1000 - 3600000
        to_delete: list[str] = []
        for id_, item in self.requests.items():
            if item.get("status") == "PENDING":
                continue
            resolved_or_created = item.get("resolvedAt") or item.get("createdAt")
            if resolved_or_created:
                ts = datetime.fromisoformat(resolved_or_created).timestamp() * 1000
                if ts < cutoff:
                    to_delete.append(id_)
        for id_ in to_delete:
            del self.requests[id_]
        if to_delete:
            logger.info("cleanup removed %d old approval requests", len(to_delete))
        self._flush()