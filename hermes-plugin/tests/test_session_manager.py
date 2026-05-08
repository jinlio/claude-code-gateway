"""Tests for core.session_manager — PersistentSessionManager class.

Uses tmp_path fixture for isolated file system operations.
"""

import json
import os

import pytest

from core.session_manager import PersistentSessionManager


# ---------------------------------------------------------------------------
# getKey
# ---------------------------------------------------------------------------


class TestGetKey:
    def test_format(self):
        mgr = PersistentSessionManager("/tmp/dummy")
        key = mgr.getKey("user123", "/path/to/workspace")
        assert key == "user123::/path/to/workspace"

    def test_double_colon_separator(self):
        mgr = PersistentSessionManager("/tmp/dummy")
        key = mgr.getKey("alice", "/home/alice/project")
        assert "::" in key
        parts = key.split("::", 1)
        assert parts[0] == "alice"
        assert parts[1] == "/home/alice/project"

    def test_empty_strings(self):
        mgr = PersistentSessionManager("/tmp/dummy")
        key = mgr.getKey("", "")
        assert key == "::"

    def test_workspace_with_colon(self):
        """Workspace paths should not be split further."""
        mgr = PersistentSessionManager("/tmp/dummy")
        key = mgr.getKey("user1", "C::drive")
        assert key == "user1::C::drive"


# ---------------------------------------------------------------------------
# activate
# ---------------------------------------------------------------------------


class TestActivate:
    def test_creates_session_with_all_fields(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        session = mgr.activate("user1", "/workspace", "cc-100-abc123")

        assert session["senderId"] == "user1"
        assert session["workspace"] == "/workspace"
        assert session["sessionId"] == "cc-100-abc123"
        assert session["active"] is True
        assert session["messageCount"] == 0
        assert session["processAlive"] is True
        assert "startedAt" in session
        assert "lastActiveAt" in session
        # startedAt and lastActiveAt should be valid ISO format
        from datetime import datetime
        datetime.fromisoformat(session["startedAt"])
        datetime.fromisoformat(session["lastActiveAt"])

    def test_writes_to_persistent_file(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        mgr.activate("user1", "/workspace", "cc-100-abc123")

        file_path = os.path.join(str(tmp_path), "persistent-sessions.json")
        assert os.path.exists(file_path)

        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        key = "user1::/workspace"
        assert key in data
        assert data[key]["senderId"] == "user1"
        assert data[key]["sessionId"] == "cc-100-abc123"

    def test_compound_key_in_json(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        mgr.activate("user1", "/workspace", "cc-100-abc")

        file_path = os.path.join(str(tmp_path), "persistent-sessions.json")
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        assert "user1::/workspace" in data

    def test_overwrites_existing_key(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        mgr.activate("user1", "/workspace", "cc-100-first")
        mgr.activate("user1", "/workspace", "cc-100-second")

        file_path = os.path.join(str(tmp_path), "persistent-sessions.json")
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        key = "user1::/workspace"
        assert data[key]["sessionId"] == "cc-100-second"

    def test_returns_the_session_dict(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        result = mgr.activate("user1", "/ws", "cc-100-abc")
        assert isinstance(result, dict)
        assert result["sessionId"] == "cc-100-abc"

    def test_creates_data_dir_if_missing(self, tmp_path):
        nested = tmp_path / "deep" / "nested" / "dir"
        mgr = PersistentSessionManager(str(nested))
        mgr.activate("user1", "/ws", "cc-100-abc")
        assert os.path.exists(os.path.join(str(nested), "persistent-sessions.json"))


# ---------------------------------------------------------------------------
# getActive
# ---------------------------------------------------------------------------


class TestGetActive:
    def test_returns_active_session_for_sender(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        mgr.activate("user1", "/workspace", "cc-100-abc")
        result = mgr.getActive("user1")
        assert result is not None
        assert result["senderId"] == "user1"
        assert result["sessionId"] == "cc-100-abc"
        assert result["active"] is True

    def test_returns_none_for_unknown_sender(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        mgr.activate("user1", "/workspace", "cc-100-abc")
        result = mgr.getActive("unknown_user")
        assert result is None

    def test_returns_none_for_deactivated_session(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        mgr.activate("user1", "/workspace", "cc-100-abc")
        mgr.deactivate("user1")
        result = mgr.getActive("user1")
        assert result is None

    def test_returns_none_when_no_sessions(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        assert mgr.getActive("anyone") is None

    def test_returns_none_when_file_is_corrupt(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        file_path = os.path.join(str(tmp_path), "persistent-sessions.json")
        with open(file_path, "w", encoding="utf-8") as f:
            f.write("{invalid json")
        assert mgr.getActive("user1") is None

    def test_returns_only_active_session(self, tmp_path):
        """If a sender has a deactivated and an active session, returns the active one."""
        mgr = PersistentSessionManager(str(tmp_path))
        mgr.activate("user1", "/ws1", "cc-100-first")
        mgr.deactivate("user1")
        mgr.activate("user1", "/ws2", "cc-200-second")
        result = mgr.getActive("user1")
        assert result is not None
        assert result["sessionId"] == "cc-200-second"


# ---------------------------------------------------------------------------
# deactivate
# ---------------------------------------------------------------------------


class TestDeactivate:
    def test_sets_active_false(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        mgr.activate("user1", "/workspace", "cc-100-abc")
        mgr.deactivate("user1")

        file_path = os.path.join(str(tmp_path), "persistent-sessions.json")
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        key = "user1::/workspace"
        assert data[key]["active"] is False

    def test_adds_stopped_at(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        mgr.activate("user1", "/workspace", "cc-100-abc")
        mgr.deactivate("user1")

        file_path = os.path.join(str(tmp_path), "persistent-sessions.json")
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        key = "user1::/workspace"
        assert "stoppedAt" in data[key]
        # Verify ISO format
        from datetime import datetime
        datetime.fromisoformat(data[key]["stoppedAt"])

    def test_deactivate_unknown_sender_is_noop(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        # Should not raise
        mgr.deactivate("nonexistent")

    def test_deactivate_persists_to_file(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        mgr.activate("user1", "/workspace", "cc-100-abc")
        mgr.deactivate("user1")

        # Create a new manager instance reading from the same file
        mgr2 = PersistentSessionManager(str(tmp_path))
        result = mgr2.getActive("user1")
        assert result is None

    def test_deactivate_preserves_other_sessions(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        mgr.activate("user1", "/ws1", "cc-100-u1")
        mgr.activate("user2", "/ws2", "cc-200-u2")
        mgr.deactivate("user1")

        # user2 should still be active
        result = mgr.getActive("user2")
        assert result is not None
        assert result["sessionId"] == "cc-200-u2"


# ---------------------------------------------------------------------------
# Persistence across instances
# ---------------------------------------------------------------------------


class TestPersistence:
    def test_data_persists_across_instances(self, tmp_path):
        mgr1 = PersistentSessionManager(str(tmp_path))
        mgr1.activate("user1", "/workspace", "cc-100-abc")

        mgr2 = PersistentSessionManager(str(tmp_path))
        result = mgr2.getActive("user1")
        assert result is not None
        assert result["sessionId"] == "cc-100-abc"

    def test_deactivate_persists_across_instances(self, tmp_path):
        mgr1 = PersistentSessionManager(str(tmp_path))
        mgr1.activate("user1", "/workspace", "cc-100-abc")
        mgr1.deactivate("user1")

        mgr2 = PersistentSessionManager(str(tmp_path))
        assert mgr2.getActive("user1") is None

    def test_multiple_activations_persist(self, tmp_path):
        mgr1 = PersistentSessionManager(str(tmp_path))
        mgr1.activate("user1", "/ws1", "cc-100-a")
        mgr1.activate("user2", "/ws2", "cc-200-b")

        mgr2 = PersistentSessionManager(str(tmp_path))
        assert mgr2.getActive("user1")["sessionId"] == "cc-100-a"
        assert mgr2.getActive("user2")["sessionId"] == "cc-200-b"


# ---------------------------------------------------------------------------
# Multiple senders / isolation
# ---------------------------------------------------------------------------


class TestMultiSenderIsolation:
    def test_multiple_senders_independent(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        mgr.activate("user1", "/ws1", "cc-100-u1")
        mgr.activate("user2", "/ws2", "cc-200-u2")

        r1 = mgr.getActive("user1")
        r2 = mgr.getActive("user2")

        assert r1["sessionId"] == "cc-100-u1"
        assert r2["sessionId"] == "cc-200-u2"
        assert r1["workspace"] == "/ws1"
        assert r2["workspace"] == "/ws2"

    def test_deactivate_one_does_not_affect_other(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        mgr.activate("user1", "/ws1", "cc-100-u1")
        mgr.activate("user2", "/ws2", "cc-200-u2")

        mgr.deactivate("user1")

        assert mgr.getActive("user1") is None
        assert mgr.getActive("user2") is not None
        assert mgr.getActive("user2")["sessionId"] == "cc-200-u2"

    def test_same_sender_different_workspaces(self, tmp_path):
        """Activating the same sender on a different workspace overwrites."""
        mgr = PersistentSessionManager(str(tmp_path))
        mgr.activate("user1", "/ws1", "cc-100-a")
        mgr.activate("user1", "/ws2", "cc-200-b")

        # The second activate writes to a different key, so both exist in JSON
        file_path = os.path.join(str(tmp_path), "persistent-sessions.json")
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        assert "user1::/ws1" in data
        assert "user1::/ws2" in data
        assert data["user1::/ws1"]["sessionId"] == "cc-100-a"
        assert data["user1::/ws2"]["sessionId"] == "cc-200-b"

        # getActive should return one of them (first match)
        result = mgr.getActive("user1")
        assert result is not None
        assert result["active"] is True


# ---------------------------------------------------------------------------
# JSON format validation
# ---------------------------------------------------------------------------


class TestJsonFormat:
    def test_json_matches_expected_schema(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        mgr.activate("user1", "/workspace", "cc-100-abc")

        file_path = os.path.join(str(tmp_path), "persistent-sessions.json")
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        key = "user1::/workspace"
        assert key in data
        session = data[key]

        # Verify all expected field names per session-schema.md
        expected_fields = {
            "senderId",
            "workspace",
            "sessionId",
            "active",
            "startedAt",
            "lastActiveAt",
            "messageCount",
            "processAlive",
        }
        assert expected_fields.issubset(set(session.keys()))

    def test_compound_key_format(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        mgr.activate("alice", "/home/alice/proj", "cc-100-xyz")

        file_path = os.path.join(str(tmp_path), "persistent-sessions.json")
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        # Key should use :: separator
        assert "alice::/home/alice/proj" in data

    def test_field_names_are_camel_case(self, tmp_path):
        """All field names should be camelCase (matching JS convention)."""
        mgr = PersistentSessionManager(str(tmp_path))
        mgr.activate("user1", "/ws", "cc-100-abc")

        file_path = os.path.join(str(tmp_path), "persistent-sessions.json")
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        session = list(data.values())[0]
        # No snake_case keys should be present
        for key in session:
            assert "_" not in key, f"Found snake_case key: {key}"

    def test_stopped_at_added_on_deactivate(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        mgr.activate("user1", "/ws", "cc-100-abc")
        mgr.deactivate("user1")

        file_path = os.path.join(str(tmp_path), "persistent-sessions.json")
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        session = data["user1::/ws"]
        assert "stoppedAt" in session
        assert session["active"] is False


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


class TestEdgeCases:
    def test_activate_on_empty_dir(self, tmp_path):
        """No pre-existing sessions file."""
        mgr = PersistentSessionManager(str(tmp_path))
        result = mgr.activate("user1", "/ws", "cc-100-abc")
        assert result["senderId"] == "user1"

    def test_get_active_with_empty_file(self, tmp_path):
        """sessions file exists but is empty JSON object."""
        file_path = os.path.join(str(tmp_path), "persistent-sessions.json")
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump({}, f)

        mgr = PersistentSessionManager(str(tmp_path))
        assert mgr.getActive("user1") is None

    def test_special_characters_in_workspace(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        ws = "/path/with spaces/and-dashes"
        mgr.activate("user1", ws, "cc-100-abc")

        result = mgr.getActive("user1")
        assert result is not None
        assert result["workspace"] == ws

    def test_unicode_sender_id(self, tmp_path):
        mgr = PersistentSessionManager(str(tmp_path))
        mgr.activate("用户1", "/ws", "cc-100-abc")

        result = mgr.getActive("用户1")
        assert result is not None
        assert result["senderId"] == "用户1"
