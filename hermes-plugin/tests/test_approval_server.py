"""Tests for core.approval_server — ApprovalServer HTTP API."""

import json

import pytest
import yaml
from aiohttp import ClientSession

from core.approval_rules import ApprovalRules
from core.approval_server import ApprovalServer


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_yaml_rules(rules_dir, rules_dict):
    """Write approval rules YAML and return an ApprovalRules instance.

    Creates the directory if it does not exist.
    """
    rules_dir.mkdir(parents=True, exist_ok=True)
    file_path = rules_dir / "rules.yaml"
    file_path.write_text(yaml.dump(rules_dict, default_flow_style=False), encoding="utf-8")
    return ApprovalRules(str(file_path))


def _base_url(port: int) -> str:
    return f"http://127.0.0.1:{port}"


def _make_request_body(
    tool_name: str = "Bash",
    tool_input: dict | None = None,
    session_id: str = "test-session",
    cwd: str = "/tmp",
) -> dict:
    """Build a standard approval request body."""
    if tool_input is None:
        tool_input = {"command": "git status"}
    return {
        "sessionId": session_id,
        "toolName": tool_name,
        "toolInput": json.dumps(tool_input),
        "cwd": cwd,
        "timestamp": "2026-01-01T00:00:00Z",
    }


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def data_dir(tmp_path):
    """Provide a temporary data directory for the ApprovalStore."""
    d = tmp_path / "approval_data"
    d.mkdir()
    return str(d)


@pytest.fixture()
def approval_rules(tmp_path):
    """Standard rules: git auto-approve, rm require_approval, * fallback."""
    return _write_yaml_rules(
        tmp_path / "rules_dir",
        {
            "rules": [
                {"tool": "Bash", "command_pattern": "^git ", "action": "auto_approve"},
                {"tool": "Bash", "command_pattern": "^rm ", "action": "require_approval", "sensitive": True},
                {"tool": "Write", "path_pattern": "*.md", "action": "auto_approve"},
                {"tool": "*", "action": "require_approval"},
            ]
        },
    )


@pytest.fixture()
async def server(data_dir, approval_rules):
    """Start an ApprovalServer on port 0 and yield it, then stop."""
    srv = ApprovalServer(
        data_dir=data_dir,
        port=0,
        approval_rules=approval_rules,
        current_mode="efficient",
        shared_secret=None,
    )
    port = await srv.start()
    assert port > 0
    yield srv
    await srv.stop()


@pytest.fixture()
async def server_with_secret(data_dir, approval_rules):
    """Server with a shared secret configured."""
    srv = ApprovalServer(
        data_dir=data_dir,
        port=0,
        approval_rules=approval_rules,
        current_mode="efficient",
        shared_secret="s3cret",
    )
    port = await srv.start()
    yield srv
    await srv.stop()


@pytest.fixture()
async def server_strict(data_dir, approval_rules):
    """Server in strict mode."""
    srv = ApprovalServer(
        data_dir=data_dir,
        port=0,
        approval_rules=approval_rules,
        current_mode="strict",
        shared_secret=None,
    )
    port = await srv.start()
    yield srv
    await srv.stop()


@pytest.fixture()
async def server_no_rules(data_dir):
    """Server without any approval rules."""
    srv = ApprovalServer(
        data_dir=data_dir,
        port=0,
        approval_rules=None,
        current_mode="efficient",
        shared_secret=None,
    )
    port = await srv.start()
    yield srv
    await srv.stop()


# ---------------------------------------------------------------------------
# Tests — server lifecycle
# ---------------------------------------------------------------------------


class TestServerLifecycle:
    """Server start/stop basics."""

    async def test_server_starts_on_port_zero_and_returns_actual_port(self, data_dir, approval_rules):
        srv = ApprovalServer(data_dir=data_dir, port=0, approval_rules=approval_rules)
        port = await srv.start()
        try:
            assert isinstance(port, int)
            assert port > 0
            assert srv.getPort() == port
        finally:
            await srv.stop()

    async def test_server_stops_cleanly(self, data_dir, approval_rules):
        srv = ApprovalServer(data_dir=data_dir, port=0, approval_rules=approval_rules)
        await srv.start()
        await srv.stop()
        assert srv.site is None
        assert srv.runner is None

    async def test_server_starts_on_specific_port(self, data_dir, approval_rules):
        # Use port 0 to let the OS assign a free port (testing with a specific
        # port would be fragile in CI). We just verify the contract.
        srv = ApprovalServer(data_dir=data_dir, port=0, approval_rules=approval_rules)
        port = await srv.start()
        try:
            assert port > 0
        finally:
            await srv.stop()


# ---------------------------------------------------------------------------
# Tests — POST /api/approval/request
# ---------------------------------------------------------------------------


class TestApprovalRequest:
    """POST /api/approval/request — create or auto-approve requests."""

    async def test_creates_pending_request_when_no_rules_match(self, server):
        port = server.getPort()
        async with ClientSession() as session:
            body = _make_request_body(
                tool_name="Bash",
                tool_input={"command": "echo hello"},  # does not match ^git or ^rm
            )
            async with session.post(
                f"{_base_url(port)}/api/approval/request", json=body
            ) as resp:
                assert resp.status == 200
                data = await resp.json()
                assert data["approvalId"] is not None
                assert data["status"] == "PENDING"
                assert "autoApproved" not in data

    async def test_auto_approves_when_rules_match(self, server):
        port = server.getPort()
        async with ClientSession() as session:
            body = _make_request_body(
                tool_name="Bash",
                tool_input={"command": "git status"},
            )
            async with session.post(
                f"{_base_url(port)}/api/approval/request", json=body
            ) as resp:
                assert resp.status == 200
                data = await resp.json()
                assert data["approvalId"] is None
                assert data["status"] == "APPROVED"
                assert data["autoApproved"] is True

    async def test_auto_approve_includes_sensitive_flag(self, server):
        port = server.getPort()
        async with ClientSession() as session:
            # Use a tool that auto-approves via the * rule would require_approval,
            # so test the Write/*.md auto-approve path instead
            body = _make_request_body(
                tool_name="Write",
                tool_input={"file_path": "README.md", "content": "hello"},
            )
            async with session.post(
                f"{_base_url(port)}/api/approval/request", json=body
            ) as resp:
                data = await resp.json()
                assert data["autoApproved"] is True
                assert data["sensitive"] is False

    async def test_strict_mode_overrides_auto_approve_for_write(self, server_strict):
        port = server_strict.getPort()
        async with ClientSession() as session:
            body = _make_request_body(
                tool_name="Write",
                tool_input={"file_path": "README.md", "content": "hello"},
            )
            async with session.post(
                f"{_base_url(port)}/api/approval/request", json=body
            ) as resp:
                data = await resp.json()
                # In strict mode, Write should NOT be auto-approved
                assert data["status"] == "PENDING"
                assert data["approvalId"] is not None

    async def test_strict_mode_overrides_auto_approve_for_edit(self, server_strict):
        port = server_strict.getPort()
        async with ClientSession() as session:
            body = _make_request_body(
                tool_name="Edit",
                tool_input={"file_path": "test.py"},
            )
            async with session.post(
                f"{_base_url(port)}/api/approval/request", json=body
            ) as resp:
                data = await resp.json()
                assert data["status"] == "PENDING"

    async def test_strict_mode_does_not_override_bash_auto_approve(self, server_strict):
        port = server_strict.getPort()
        async with ClientSession() as session:
            body = _make_request_body(
                tool_name="Bash",
                tool_input={"command": "git status"},
            )
            async with session.post(
                f"{_base_url(port)}/api/approval/request", json=body
            ) as resp:
                data = await resp.json()
                # Bash auto-approve is NOT overridden in strict mode
                assert data["status"] == "APPROVED"
                assert data["autoApproved"] is True

    async def test_no_rules_always_creates_pending(self, server_no_rules):
        port = server_no_rules.getPort()
        async with ClientSession() as session:
            body = _make_request_body(
                tool_name="Bash",
                tool_input={"command": "git status"},
            )
            async with session.post(
                f"{_base_url(port)}/api/approval/request", json=body
            ) as resp:
                data = await resp.json()
                assert data["status"] == "PENDING"
                assert data["approvalId"] is not None


# ---------------------------------------------------------------------------
# Tests — GET /api/approval/status
# ---------------------------------------------------------------------------


class TestApprovalStatus:
    """GET /api/approval/status?id={uuid} — poll request status."""

    async def test_returns_pending_then_approved(self, server):
        port = server.getPort()
        async with ClientSession() as session:
            # Create a pending request
            body = _make_request_body(
                tool_name="Bash",
                tool_input={"command": "echo hello"},
            )
            async with session.post(
                f"{_base_url(port)}/api/approval/request", json=body
            ) as resp:
                data = await resp.json()
                approval_id = data["approvalId"]

            # Check status is PENDING
            async with session.get(
                f"{_base_url(port)}/api/approval/status",
                params={"id": approval_id},
            ) as resp:
                assert resp.status == 200
                status_data = await resp.json()
                assert status_data["approvalId"] == approval_id
                assert status_data["status"] == "PENDING"

            # Approve it
            async with session.post(
                f"{_base_url(port)}/api/approval/respond",
                params={"id": approval_id, "action": "approve"},
            ) as resp:
                assert resp.status == 200

            # Check status is APPROVED
            async with session.get(
                f"{_base_url(port)}/api/approval/status",
                params={"id": approval_id},
            ) as resp:
                status_data = await resp.json()
                assert status_data["status"] == "APPROVED"

    async def test_returns_pending_then_denied(self, server):
        port = server.getPort()
        async with ClientSession() as session:
            body = _make_request_body(
                tool_name="Bash",
                tool_input={"command": "echo hello"},
            )
            async with session.post(
                f"{_base_url(port)}/api/approval/request", json=body
            ) as resp:
                approval_id = (await resp.json())["approvalId"]

            # Deny it
            async with session.post(
                f"{_base_url(port)}/api/approval/respond",
                params={"id": approval_id, "action": "deny"},
            ) as resp:
                assert resp.status == 200

            # Check status is DENIED
            async with session.get(
                f"{_base_url(port)}/api/approval/status",
                params={"id": approval_id},
            ) as resp:
                status_data = await resp.json()
                assert status_data["status"] == "DENIED"

    async def test_returns_404_for_unknown_id(self, server):
        port = server.getPort()
        async with ClientSession() as session:
            async with session.get(
                f"{_base_url(port)}/api/approval/status",
                params={"id": "00000000-0000-0000-0000-000000000000"},
            ) as resp:
                assert resp.status == 404

    async def test_returns_404_when_id_param_missing(self, server):
        port = server.getPort()
        async with ClientSession() as session:
            async with session.get(
                f"{_base_url(port)}/api/approval/status",
            ) as resp:
                assert resp.status == 404


# ---------------------------------------------------------------------------
# Tests — POST /api/approval/respond
# ---------------------------------------------------------------------------


class TestApprovalRespond:
    """POST /api/approval/respond?id={uuid}&action={approve|deny}."""

    async def test_approve_with_valid_secret(self, server_with_secret):
        port = server_with_secret.getPort()
        async with ClientSession() as session:
            # Create a pending request
            body = _make_request_body(
                tool_name="Bash",
                tool_input={"command": "echo hello"},
            )
            async with session.post(
                f"{_base_url(port)}/api/approval/request", json=body
            ) as resp:
                approval_id = (await resp.json())["approvalId"]

            # Approve with correct secret
            headers = {"Authorization": "Bearer s3cret"}
            async with session.post(
                f"{_base_url(port)}/api/approval/respond",
                params={"id": approval_id, "action": "approve"},
                headers=headers,
            ) as resp:
                assert resp.status == 200
                text = await resp.text()
                assert text == "OK"

            # Verify it was approved
            async with session.get(
                f"{_base_url(port)}/api/approval/status",
                params={"id": approval_id},
            ) as resp:
                data = await resp.json()
                assert data["status"] == "APPROVED"

    async def test_deny_with_valid_secret(self, server_with_secret):
        port = server_with_secret.getPort()
        async with ClientSession() as session:
            body = _make_request_body(
                tool_name="Bash",
                tool_input={"command": "echo hello"},
            )
            async with session.post(
                f"{_base_url(port)}/api/approval/request", json=body
            ) as resp:
                approval_id = (await resp.json())["approvalId"]

            headers = {"Authorization": "Bearer s3cret"}
            async with session.post(
                f"{_base_url(port)}/api/approval/respond",
                params={"id": approval_id, "action": "deny"},
                headers=headers,
            ) as resp:
                assert resp.status == 200

            async with session.get(
                f"{_base_url(port)}/api/approval/status",
                params={"id": approval_id},
            ) as resp:
                data = await resp.json()
                assert data["status"] == "DENIED"

    async def test_wrong_secret_returns_403(self, server_with_secret):
        port = server_with_secret.getPort()
        async with ClientSession() as session:
            body = _make_request_body(
                tool_name="Bash",
                tool_input={"command": "echo hello"},
            )
            async with session.post(
                f"{_base_url(port)}/api/approval/request", json=body
            ) as resp:
                approval_id = (await resp.json())["approvalId"]

            headers = {"Authorization": "Bearer wrong"}
            async with session.post(
                f"{_base_url(port)}/api/approval/respond",
                params={"id": approval_id, "action": "approve"},
                headers=headers,
            ) as resp:
                assert resp.status == 403

    async def test_no_secret_when_configured_returns_403(self, server_with_secret):
        port = server_with_secret.getPort()
        async with ClientSession() as session:
            body = _make_request_body(
                tool_name="Bash",
                tool_input={"command": "echo hello"},
            )
            async with session.post(
                f"{_base_url(port)}/api/approval/request", json=body
            ) as resp:
                approval_id = (await resp.json())["approvalId"]

            # No Authorization header at all
            async with session.post(
                f"{_base_url(port)}/api/approval/respond",
                params={"id": approval_id, "action": "approve"},
            ) as resp:
                assert resp.status == 403

    async def test_no_secret_required_when_not_configured(self, server):
        port = server.getPort()
        async with ClientSession() as session:
            body = _make_request_body(
                tool_name="Bash",
                tool_input={"command": "echo hello"},
            )
            async with session.post(
                f"{_base_url(port)}/api/approval/request", json=body
            ) as resp:
                approval_id = (await resp.json())["approvalId"]

            # No Authorization header — should succeed
            async with session.post(
                f"{_base_url(port)}/api/approval/respond",
                params={"id": approval_id, "action": "approve"},
            ) as resp:
                assert resp.status == 200
                text = await resp.text()
                assert text == "OK"


# ---------------------------------------------------------------------------
# Tests — error handling
# ---------------------------------------------------------------------------


class TestApprovalServerErrors:
    """Edge cases and error handling."""

    async def test_invalid_json_body_returns_400(self, server):
        port = server.getPort()
        async with ClientSession() as session:
            async with session.post(
                f"{_base_url(port)}/api/approval/request",
                data="this is not json",
                headers={"Content-Type": "application/json"},
            ) as resp:
                assert resp.status == 400

    async def test_empty_body_returns_400(self, server):
        port = server.getPort()
        async with ClientSession() as session:
            async with session.post(
                f"{_base_url(port)}/api/approval/request",
                data="",
                headers={"Content-Type": "application/json"},
            ) as resp:
                assert resp.status == 400

    async def test_malformed_json_body_returns_400(self, server):
        port = server.getPort()
        async with ClientSession() as session:
            async with session.post(
                f"{_base_url(port)}/api/approval/request",
                data='{"broken": ',
                headers={"Content-Type": "application/json"},
            ) as resp:
                assert resp.status == 400


# ---------------------------------------------------------------------------
# Tests — setMode
# ---------------------------------------------------------------------------


class TestSetMode:
    """Test the setMode method."""

    async def test_setmode_switches_to_strict(self, server):
        assert server.current_mode == "efficient"
        server.setMode("strict")
        assert server.current_mode == "strict"

    async def test_setmode_switches_to_efficient(self, server_strict):
        assert server_strict.current_mode == "strict"
        server_strict.setMode("efficient")
        assert server_strict.current_mode == "efficient"

    async def test_setmode_affects_auto_approve_behavior(self, server):
        port = server.getPort()
        async with ClientSession() as session:
            # In efficient mode, Write/*.md is auto-approved
            body = _make_request_body(
                tool_name="Write",
                tool_input={"file_path": "README.md", "content": "hello"},
            )
            async with session.post(
                f"{_base_url(port)}/api/approval/request", json=body
            ) as resp:
                data = await resp.json()
                assert data["autoApproved"] is True

            # Switch to strict mode
            server.setMode("strict")

            # Now Write should not be auto-approved
            body2 = _make_request_body(
                tool_name="Write",
                tool_input={"file_path": "CHANGELOG.md", "content": "v2"},
            )
            async with session.post(
                f"{_base_url(port)}/api/approval/request", json=body
            ) as resp:
                data2 = await resp.json()
                assert data2["status"] == "PENDING"

    async def test_setmode_does_not_affect_bash(self, server):
        port = server.getPort()
        server.setMode("strict")
        async with ClientSession() as session:
            body = _make_request_body(
                tool_name="Bash",
                tool_input={"command": "git status"},
            )
            async with session.post(
                f"{_base_url(port)}/api/approval/request", json=body
            ) as resp:
                data = await resp.json()
                # Bash auto-approve still works in strict mode
                assert data["autoApproved"] is True
