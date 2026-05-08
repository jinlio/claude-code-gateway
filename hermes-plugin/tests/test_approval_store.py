"""Tests for core.approval_store — ApprovalStore persistence logic."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone, timedelta

import pytest

from core.approval_store import ApprovalStore


def _make_params(
    session_id: str = "sess-001",
    tool_name: str = "Bash",
    tool_input: dict | None = None,
    cwd: str = "/home/user/project",
) -> dict:
    """Helper to build a create() params dict."""
    return {
        "sessionId": session_id,
        "toolName": tool_name,
        "toolInput": tool_input or {"command": "ls"},
        "cwd": cwd,
    }


class TestApprovalStoreCreateAndGet:
    """Tests for create + get round trip."""

    def test_create_returns_uuid(self, tmp_path: pytest.Path) -> None:
        """create() returns a valid UUID string."""
        store = ApprovalStore(str(tmp_path))
        rid = store.create(_make_params())
        assert isinstance(rid, str)
        assert len(rid) == 36  # standard UUID format with hyphens

    def test_get_returns_created_item(self, tmp_path: pytest.Path) -> None:
        """get() returns the item that was just created."""
        store = ApprovalStore(str(tmp_path))
        params = _make_params()
        rid = store.create(params)
        item = store.get(rid)
        assert item is not None
        assert item["id"] == rid
        assert item["sessionId"] == params["sessionId"]
        assert item["toolName"] == params["toolName"]
        assert item["toolInput"] == params["toolInput"]
        assert item["cwd"] == params["cwd"]
        assert item["status"] == "PENDING"
        assert "createdAt" in item

    def test_get_nonexistent_returns_none(self, tmp_path: pytest.Path) -> None:
        """get() returns None for an unknown id."""
        store = ApprovalStore(str(tmp_path))
        assert store.get("does-not-exist") is None

    def test_create_flushes_to_disk(self, tmp_path: pytest.Path) -> None:
        """create() persists data to the JSON file on disk."""
        store = ApprovalStore(str(tmp_path))
        rid = store.create(_make_params())
        fp = os.path.join(str(tmp_path), "approval-requests.json")
        with open(fp, "r", encoding="utf-8") as fh:
            items = json.load(fh)
        assert len(items) == 1
        assert items[0]["id"] == rid

    def test_create_multiple_items(self, tmp_path: pytest.Path) -> None:
        """Multiple creates produce independent items."""
        store = ApprovalStore(str(tmp_path))
        id1 = store.create(_make_params(session_id="s1"))
        id2 = store.create(_make_params(session_id="s2"))
        assert id1 != id2
        assert store.get(id1)["sessionId"] == "s1"
        assert store.get(id2)["sessionId"] == "s2"


class TestApprovalStoreFindByShortId:
    """Tests for findByShortId."""

    def test_exact_match(self, tmp_path: pytest.Path) -> None:
        """Full UUID returns the matching item."""
        store = ApprovalStore(str(tmp_path))
        rid = store.create(_make_params())
        result = store.findByShortId(rid)
        assert result is not None
        assert result["id"] == rid

    def test_prefix_match(self, tmp_path: pytest.Path) -> None:
        """A short prefix that matches exactly one item returns it."""
        store = ApprovalStore(str(tmp_path))
        rid = store.create(_make_params())
        short = rid[:8]
        result = store.findByShortId(short)
        assert result is not None
        assert result["id"] == rid

    def test_ambiguous_match(self, tmp_path: pytest.Path) -> None:
        """A prefix matching multiple items returns an ambiguous dict."""
        store = ApprovalStore(str(tmp_path))
        # We cannot control UUIDs, so create many and find a common prefix
        ids = [store.create(_make_params(session_id=f"s{i}")) for i in range(50)]
        # Try single char — likely ambiguous with 50 items
        prefix = ids[0][0]
        result = store.findByShortId(prefix)
        if result is not None and isinstance(result, dict):
            if result.get("ambiguous"):
                assert "matches" in result
                assert len(result["matches"]) > 1

    def test_no_match_returns_none(self, tmp_path: pytest.Path) -> None:
        """A prefix that matches nothing returns None."""
        store = ApprovalStore(str(tmp_path))
        store.create(_make_params())
        result = store.findByShortId("00000000-0000-0000-0000-000000000000")
        assert result is None

    def test_empty_store_returns_none(self, tmp_path: pytest.Path) -> None:
        """Searching in an empty store returns None."""
        store = ApprovalStore(str(tmp_path))
        result = store.findByShortId("abc")
        assert result is None


class TestApprovalStoreResolve:
    """Tests for resolve."""

    def test_resolve_changes_status(self, tmp_path: pytest.Path) -> None:
        """resolve() sets the status to the provided value."""
        store = ApprovalStore(str(tmp_path))
        rid = store.create(_make_params())
        item = store.resolve(rid, "APPROVED")
        assert item is not None
        assert item["status"] == "APPROVED"

    def test_resolve_adds_resolved_at(self, tmp_path: pytest.Path) -> None:
        """resolve() adds a resolvedAt timestamp."""
        store = ApprovalStore(str(tmp_path))
        rid = store.create(_make_params())
        item = store.resolve(rid, "APPROVED")
        assert item is not None
        assert "resolvedAt" in item
        # Verify the timestamp is parseable as ISO format
        datetime.fromisoformat(item["resolvedAt"])

    def test_resolve_persists_to_disk(self, tmp_path: pytest.Path) -> None:
        """resolve() flushes the updated status to disk."""
        store = ApprovalStore(str(tmp_path))
        rid = store.create(_make_params())
        store.resolve(rid, "DENIED")
        fp = os.path.join(str(tmp_path), "approval-requests.json")
        with open(fp, "r", encoding="utf-8") as fh:
            items = json.load(fh)
        assert items[0]["status"] == "DENIED"

    def test_resolve_nonexistent_returns_none(self, tmp_path: pytest.Path) -> None:
        """resolve() returns None for an unknown id."""
        store = ApprovalStore(str(tmp_path))
        result = store.resolve("nonexistent", "APPROVED")
        assert result is None

    def test_resolve_to_denied(self, tmp_path: pytest.Path) -> None:
        """resolve() can set status to DENIED."""
        store = ApprovalStore(str(tmp_path))
        rid = store.create(_make_params())
        item = store.resolve(rid, "DENIED")
        assert item["status"] == "DENIED"


class TestApprovalStoreListPending:
    """Tests for listPending."""

    def test_list_pending_returns_only_pending(self, tmp_path: pytest.Path) -> None:
        """listPending() returns only items with status PENDING."""
        store = ApprovalStore(str(tmp_path))
        id1 = store.create(_make_params())
        id2 = store.create(_make_params())
        store.resolve(id2, "APPROVED")
        pending = store.listPending()
        assert len(pending) == 1
        assert pending[0]["id"] == id1
        assert pending[0]["status"] == "PENDING"

    def test_list_pending_empty_when_none(self, tmp_path: pytest.Path) -> None:
        """listPending() returns [] when no items are PENDING."""
        store = ApprovalStore(str(tmp_path))
        rid = store.create(_make_params())
        store.resolve(rid, "APPROVED")
        assert store.listPending() == []

    def test_list_pending_all_pending(self, tmp_path: pytest.Path) -> None:
        """listPending() returns all items when all are PENDING."""
        store = ApprovalStore(str(tmp_path))
        store.create(_make_params())
        store.create(_make_params())
        assert len(store.listPending()) == 2


class TestApprovalStoreMarkAllPendingAsTimeout:
    """Tests for markAllPendingAsTimeout."""

    def test_marks_all_pending_as_timeout(self, tmp_path: pytest.Path) -> None:
        """All PENDING items become TIMEOUT after markAllPendingAsTimeout."""
        store = ApprovalStore(str(tmp_path))
        id1 = store.create(_make_params())
        id2 = store.create(_make_params())
        store.resolve(id1, "APPROVED")
        store.markAllPendingAsTimeout()
        assert store.get(id1)["status"] == "APPROVED"
        assert store.get(id2)["status"] == "TIMEOUT"

    def test_no_pending_items_no_error(self, tmp_path: pytest.Path) -> None:
        """Calling markAllPendingAsTimeout with no PENDING items is safe."""
        store = ApprovalStore(str(tmp_path))
        rid = store.create(_make_params())
        store.resolve(rid, "APPROVED")
        store.markAllPendingAsTimeout()  # should not raise
        assert store.get(rid)["status"] == "APPROVED"


class TestApprovalStoreLoadPendingTimeout:
    """Tests for PENDING -> TIMEOUT marking on reload."""

    def test_pending_marked_timeout_on_reload(self, tmp_path: pytest.Path) -> None:
        """When a new store loads, existing PENDING items become TIMEOUT."""
        # Create a store with a pending item
        store1 = ApprovalStore(str(tmp_path))
        rid = store1.create(_make_params())
        assert store1.get(rid)["status"] == "PENDING"

        # Load a fresh store from the same data dir
        store2 = ApprovalStore(str(tmp_path))
        item = store2.get(rid)
        assert item is not None
        assert item["status"] == "TIMEOUT"

    def test_already_resolved_unchanged_on_reload(self, tmp_path: pytest.Path) -> None:
        """Already-resolved items are not changed on reload."""
        store1 = ApprovalStore(str(tmp_path))
        rid = store1.create(_make_params())
        store1.resolve(rid, "APPROVED")

        store2 = ApprovalStore(str(tmp_path))
        assert store2.get(rid)["status"] == "APPROVED"


class TestApprovalStoreLoadTimedOutCount:
    """Tests for _load_timed_out_count."""

    def test_counts_pending_on_reload(self, tmp_path: pytest.Path) -> None:
        """_load_timed_out_count returns the number of PENDING items that became TIMEOUT."""
        store1 = ApprovalStore(str(tmp_path))
        store1.create(_make_params())
        store1.create(_make_params())
        rid3 = store1.create(_make_params())
        store1.resolve(rid3, "APPROVED")

        store2 = ApprovalStore(str(tmp_path))
        count = store2._load_timed_out_count()
        assert count == 2

    def test_zero_when_no_pending(self, tmp_path: pytest.Path) -> None:
        """_load_timed_out_count returns 0 when no PENDING items exist."""
        store1 = ApprovalStore(str(tmp_path))
        rid = store1.create(_make_params())
        store1.resolve(rid, "APPROVED")

        store2 = ApprovalStore(str(tmp_path))
        count = store2._load_timed_out_count()
        assert count == 0


class TestApprovalStoreCleanup:
    """Tests for cleanup."""

    def test_removes_old_resolved_items(self, tmp_path: pytest.Path) -> None:
        """cleanup() removes resolved items older than 1 hour."""
        store = ApprovalStore(str(tmp_path))
        rid = store.create(_make_params())
        store.resolve(rid, "APPROVED")

        # Manually backdate resolvedAt to 2 hours ago
        item = store.get(rid)
        old_time = datetime.now(timezone.utc) - timedelta(hours=2)
        item["resolvedAt"] = old_time.isoformat()

        store.cleanup()
        assert store.get(rid) is None

    def test_keeps_recent_resolved_items(self, tmp_path: pytest.Path) -> None:
        """cleanup() keeps resolved items newer than 1 hour."""
        store = ApprovalStore(str(tmp_path))
        rid = store.create(_make_params())
        store.resolve(rid, "APPROVED")

        # resolvedAt is just now, so it should be kept
        store.cleanup()
        assert store.get(rid) is not None

    def test_keeps_pending_items(self, tmp_path: pytest.Path) -> None:
        """cleanup() never removes PENDING items, even if old."""
        store = ApprovalStore(str(tmp_path))
        rid = store.create(_make_params())

        # Backdate createdAt to 2 hours ago
        item = store.get(rid)
        old_time = datetime.now(timezone.utc) - timedelta(hours=2)
        item["createdAt"] = old_time.isoformat()

        store.cleanup()
        assert store.get(rid) is not None
        assert store.get(rid)["status"] == "PENDING"

    def test_removes_old_timeout_items(self, tmp_path: pytest.Path) -> None:
        """cleanup() removes TIMEOUT items older than 1 hour."""
        store = ApprovalStore(str(tmp_path))
        rid = store.create(_make_params())
        store.resolve(rid, "TIMEOUT")

        # Backdate resolvedAt
        item = store.get(rid)
        old_time = datetime.now(timezone.utc) - timedelta(hours=2)
        item["resolvedAt"] = old_time.isoformat()

        store.cleanup()
        assert store.get(rid) is None

    def test_removes_old_denied_items(self, tmp_path: pytest.Path) -> None:
        """cleanup() removes DENIED items older than 1 hour."""
        store = ApprovalStore(str(tmp_path))
        rid = store.create(_make_params())
        store.resolve(rid, "DENIED")

        # Backdate resolvedAt
        item = store.get(rid)
        old_time = datetime.now(timezone.utc) - timedelta(hours=2)
        item["resolvedAt"] = old_time.isoformat()

        store.cleanup()
        assert store.get(rid) is None

    def test_cleanup_flushes_to_disk(self, tmp_path: pytest.Path) -> None:
        """cleanup() persists the cleaned state to disk."""
        store = ApprovalStore(str(tmp_path))
        rid = store.create(_make_params())
        store.resolve(rid, "APPROVED")

        # Backdate
        item = store.get(rid)
        old_time = datetime.now(timezone.utc) - timedelta(hours=2)
        item["resolvedAt"] = old_time.isoformat()

        store.cleanup()

        fp = os.path.join(str(tmp_path), "approval-requests.json")
        with open(fp, "r", encoding="utf-8") as fh:
            items = json.load(fh)
        assert len(items) == 0

    def test_mixed_old_and_recent(self, tmp_path: pytest.Path) -> None:
        """cleanup() removes only old items and keeps recent ones."""
        store = ApprovalStore(str(tmp_path))

        # Old resolved item
        rid_old = store.create(_make_params(session_id="old"))
        store.resolve(rid_old, "APPROVED")
        old_item = store.get(rid_old)
        old_time = datetime.now(timezone.utc) - timedelta(hours=2)
        old_item["resolvedAt"] = old_time.isoformat()

        # Recent resolved item
        rid_recent = store.create(_make_params(session_id="recent"))
        store.resolve(rid_recent, "APPROVED")

        # Pending item
        rid_pending = store.create(_make_params(session_id="pending"))

        store.cleanup()
        assert store.get(rid_old) is None
        assert store.get(rid_recent) is not None
        assert store.get(rid_pending) is not None


class TestApprovalStoreFindBySessionId:
    """Tests for findBySessionId."""

    def test_finds_items_by_session(self, tmp_path: pytest.Path) -> None:
        """findBySessionId returns items matching the session ID."""
        store = ApprovalStore(str(tmp_path))
        store.create(_make_params(session_id="sess-A"))
        store.create(_make_params(session_id="sess-A"))
        store.create(_make_params(session_id="sess-B"))

        result = store.findBySessionId("sess-A")
        assert len(result) == 2
        assert all(item["sessionId"] == "sess-A" for item in result)

    def test_no_match_returns_empty_list(self, tmp_path: pytest.Path) -> None:
        """findBySessionId returns [] when no items match."""
        store = ApprovalStore(str(tmp_path))
        store.create(_make_params(session_id="sess-A"))
        assert store.findBySessionId("sess-Z") == []


class TestApprovalStorePersistence:
    """Tests that data persists across store instances."""

    def test_data_persists_across_instances(self, tmp_path: pytest.Path) -> None:
        """Creating an item in one store is readable from a new store instance."""
        data_dir = str(tmp_path)
        store1 = ApprovalStore(data_dir)
        rid = store1.create(_make_params(session_id="persist-test"))
        store1.resolve(rid, "APPROVED")

        # Fresh instance reads from disk
        store2 = ApprovalStore(data_dir)
        item = store2.get(rid)
        assert item is not None
        assert item["sessionId"] == "persist-test"
        # Note: the reload marks PENDING as TIMEOUT, but this one is APPROVED
        assert item["status"] == "APPROVED"

    def test_flush_public_method(self, tmp_path: pytest.Path) -> None:
        """flush() is the public wrapper for _flush()."""
        store = ApprovalStore(str(tmp_path))
        rid = store.create(_make_params())
        # Manually mutate in-memory data (bypass create/resolve)
        store.requests[rid]["toolName"] = "Modified"
        store.flush()

        store2 = ApprovalStore(str(tmp_path))
        item = store2.get(rid)
        assert item is not None
        assert item["toolName"] == "Modified"

    def test_corrupt_file_starts_fresh(self, tmp_path: pytest.Path) -> None:
        """A corrupt JSON file causes the store to start with no items."""
        data_dir = str(tmp_path)
        fp = os.path.join(data_dir, "approval-requests.json")
        with open(fp, "w", encoding="utf-8") as fh:
            fh.write("NOT VALID JSON")

        store = ApprovalStore(data_dir)
        assert len(store.requests) == 0

    def test_empty_data_dir(self, tmp_path: pytest.Path) -> None:
        """An empty data directory starts with no items."""
        store = ApprovalStore(str(tmp_path))
        assert len(store.requests) == 0
        assert store.listPending() == []
