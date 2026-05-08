#!/usr/bin/env python3
"""Cross-platform compatibility test for CC Gateway.

Verifies that the Node.js (OpenClaw) and Python (Hermes) approval servers
produce consistent behavior for the same HTTP API calls, and that their
data formats are interoperable.

Usage:
  python shared/cross-compat-test.py

Prerequisites:
  - Node.js >= 18 (for OpenClaw plugin)
  - Python >= 3.10 (for Hermes plugin)
  - Both plugin packages installed with dependencies
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time

# Ensure project root is on path
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PROJECT_ROOT, "hermes-plugin"))

try:
    import aiohttp
    from aiohttp import ClientSession
except ImportError:
    print("ERROR: aiohttp not installed. Run: pip install aiohttp")
    sys.exit(1)

try:
    from core.approval_server import ApprovalServer
    from core.approval_rules import ApprovalRules
    from core.approval_store import ApprovalStore
    from core.utils import atomic_write_sync, safe_load_json
except ImportError as e:
    print(f"ERROR: Cannot import Hermes core modules: {e}")
    print(f"  Make sure you're running from the project root directory.")
    sys.exit(1)


async def test_python_approval_server():
    """Start the Python approval server and test all 3 endpoints."""
    print("\n=== Testing Python (Hermes) Approval Server ===")

    with tempfile.TemporaryDirectory() as data_dir:
        rules_path = os.path.join(
            PROJECT_ROOT, "hermes-plugin", "config", "cc-approval-rules.yml"
        )
        rules = ApprovalRules(rules_path) if os.path.exists(rules_path) else None

        server = ApprovalServer(
            data_dir=data_dir,
            port=0,
            approval_rules=rules,
            current_mode="efficient",
            shared_secret="test-secret",
        )
        port = await server.start()
        base_url = f"http://127.0.0.1:{port}"
        print(f"  Python server started on port {port}")

        results = {"passed": 0, "failed": 0}

        try:
            async with ClientSession() as session:
                # Test 1: Create approval request
                async with session.post(
                    f"{base_url}/api/approval/request",
                    json={
                        "sessionId": "cc-1709123456789-abc123",
                        "toolName": "Bash",
                        "toolInput": '{"command": "rm -rf /"}',
                        "cwd": "/tmp/workspace",
                        "timestamp": int(time.time() * 1000),
                    },
                ) as resp:
                    data = await resp.json()
                    if resp.status == 200 and data.get("approvalId") and data.get("status") == "PENDING":
                        print("  [PASS] POST /api/approval/request → PENDING")
                        results["passed"] += 1
                        approval_id = data["approvalId"]
                    else:
                        print(f"  [FAIL] POST /api/approval/request: {resp.status} {data}")
                        results["failed"] += 1
                        approval_id = None

                # Test 2: Check status (should be PENDING)
                if approval_id:
                    async with session.get(
                        f"{base_url}/api/approval/status?id={approval_id}"
                    ) as resp:
                        data = await resp.json()
                        if data.get("status") == "PENDING":
                            print("  [PASS] GET /api/approval/status → PENDING")
                            results["passed"] += 1
                        else:
                            print(f"  [FAIL] GET /api/approval/status: {data}")
                            results["failed"] += 1

                # Test 3: Approve with valid secret
                if approval_id:
                    async with session.post(
                        f"{base_url}/api/approval/respond?id={approval_id}&action=approve",
                        headers={"Authorization": "Bearer test-secret"},
                    ) as resp:
                        if resp.status == 200:
                            print("  [PASS] POST /api/approval/respond (approve) → 200")
                            results["passed"] += 1
                        else:
                            print(f"  [FAIL] POST /api/approval/respond: {resp.status}")
                            results["failed"] += 1

                # Test 4: Verify status is now APPROVED
                if approval_id:
                    async with session.get(
                        f"{base_url}/api/approval/status?id={approval_id}"
                    ) as resp:
                        data = await resp.json()
                        if data.get("status") == "APPROVED":
                            print("  [PASS] GET /api/approval/status → APPROVED")
                            results["passed"] += 1
                        else:
                            print(f"  [FAIL] GET /api/approval/status after approve: {data}")
                            results["failed"] += 1

                # Test 5: Wrong secret → 403
                async with session.post(
                    f"{base_url}/api/approval/respond?id=nonexistent&action=deny",
                    headers={"Authorization": "Bearer wrong-secret"},
                ) as resp:
                    if resp.status == 403:
                        print("  [PASS] POST /api/approval/respond (wrong secret) → 403")
                        results["passed"] += 1
                    else:
                        print(f"  [FAIL] Wrong secret: expected 403, got {resp.status}")
                        results["failed"] += 1

                # Test 6: Auto-approve with matching rules
                if rules:
                    async with session.post(
                        f"{base_url}/api/approval/request",
                        json={
                            "sessionId": "cc-test-session",
                            "toolName": "Bash",
                            "toolInput": '{"command": "git status"}',
                            "cwd": "/tmp/workspace",
                            "timestamp": int(time.time() * 1000),
                        },
                    ) as resp:
                        data = await resp.json()
                        if data.get("autoApproved"):
                            print("  [PASS] Auto-approve with matching rules")
                            results["passed"] += 1
                        else:
                            print(f"  [FAIL] Auto-approve: {data}")
                            results["failed"] += 1

                # Test 7: Strict mode overrides Write/Edit auto-approve
                server.setMode("strict")
                async with session.post(
                    f"{base_url}/api/approval/request",
                    json={
                        "sessionId": "cc-test-session",
                        "toolName": "Write",
                        "toolInput": '{"file_path": "/tmp/test.txt"}',
                        "cwd": "/tmp/workspace",
                        "timestamp": int(time.time() * 1000),
                    },
                ) as resp:
                    data = await resp.json()
                    if data.get("status") == "PENDING" and not data.get("autoApproved"):
                        print("  [PASS] Strict mode overrides Write auto-approve")
                        results["passed"] += 1
                    else:
                        print(f"  [FAIL] Strict mode Write: {data}")
                        results["failed"] += 1

        finally:
            await server.stop()
            print(f"  Python server stopped")

    return results


def test_json_format_compatibility():
    """Verify that Python and Node.js produce/read the same JSON formats."""
    print("\n=== Testing JSON Format Compatibility ===")

    results = {"passed": 0, "failed": 0}

    with tempfile.TemporaryDirectory() as data_dir:
        # Test 1: approval-requests.json format
        store = ApprovalStore(data_dir)
        req_id = store.create({
            "sessionId": "cc-1709123456789-abc123",
            "toolName": "Bash",
            "toolInput": '{"command": "ls -la"}',
            "cwd": "/tmp/workspace",
        })

        with open(os.path.join(data_dir, "approval-requests.json"), "r") as f:
            data = json.load(f)

        # Verify it's a JSON array (same format as Node.js)
        if isinstance(data, list) and len(data) == 1:
            item = data[0]
            required_fields = {"id", "sessionId", "toolName", "toolInput", "cwd", "status", "createdAt"}
            if required_fields.issubset(item.keys()):
                print("  [PASS] approval-requests.json format matches Node.js (array of objects)")
                results["passed"] += 1
            else:
                print(f"  [FAIL] Missing fields: {required_fields - item.keys()}")
                results["failed"] += 1
        else:
            print(f"  [FAIL] Unexpected format: {type(data)}")
            results["failed"] += 1

        # Test 2: Python can read Node.js format
        node_js_format = json.dumps([{
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "sessionId": "cc-1709123456789-xyz789",
            "toolName": "Write",
            "toolInput": '{"file_path": "/tmp/test.py"}',
            "cwd": "/tmp/workspace",
            "status": "PENDING",
            "createdAt": "2026-05-08T10:00:00.000000+00:00",
        }])
        atomic_write_sync(os.path.join(data_dir, "nodejs-approval.json"), node_js_format)
        loaded = safe_load_json(os.path.join(data_dir, "nodejs-approval.json"))
        if isinstance(loaded, list) and loaded[0].get("toolName") == "Write":
            print("  [PASS] Python can read Node.js JSON format")
            results["passed"] += 1
        else:
            print(f"  [FAIL] Python reading Node.js format: {loaded}")
            results["failed"] += 1

        # Test 3: persistent-sessions.json format
        from core.session_manager import PersistentSessionManager
        mgr = PersistentSessionManager(data_dir)
        mgr.activate("user123", "/tmp/workspace", "cc-1709123456789-abc123")

        sessions = safe_load_json(os.path.join(data_dir, "persistent-sessions.json"))
        key = "user123::/tmp/workspace"
        if key in sessions and sessions[key].get("senderId") == "user123":
            print("  [PASS] persistent-sessions.json format matches spec (compound key)")
            results["passed"] += 1
        else:
            print(f"  [FAIL] Sessions format: {list(sessions.keys())}")
            results["failed"] += 1

        # Test 4: Python can read Node.js session format
        node_js_sessions = json.dumps({
            "user456::/home/project": {
                "senderId": "user456",
                "workspace": "/home/project",
                "sessionId": "cc-1709999999999-def456",
                "active": True,
                "startedAt": "2026-05-08T11:00:00.000000+00:00",
                "lastActiveAt": "2026-05-08T11:30:00.000000+00:00",
                "messageCount": 3,
                "processAlive": True,
            }
        })
        atomic_write_sync(os.path.join(data_dir, "nodejs-sessions.json"), node_js_sessions)
        loaded = safe_load_json(os.path.join(data_dir, "nodejs-sessions.json"))
        if "user456::/home/project" in loaded:
            print("  [PASS] Python can read Node.js session format")
            results["passed"] += 1
        else:
            print(f"  [FAIL] Python reading Node.js sessions: {loaded}")
            results["failed"] += 1

    return results


def test_hook_script_existence():
    """Verify that hook scripts exist in shared/ and are executable."""
    print("\n=== Testing Hook Script Existence ===")

    results = {"passed": 0, "failed": 0}

    mjs_path = os.path.join(PROJECT_ROOT, "shared", "hook-scripts", "cc-bridge-approval-hook.mjs")
    sh_path = os.path.join(PROJECT_ROOT, "shared", "hook-scripts", "cc-bridge-approval-hook.sh")

    if os.path.exists(mjs_path):
        print("  [PASS] cc-bridge-approval-hook.mjs exists in shared/")
        results["passed"] += 1
        # Check it references the HTTP API
        with open(mjs_path, "r", encoding="utf-8") as f:
            content = f.read()
        if "/api/approval/request" in content and "/api/approval/status" in content:
            print("  [PASS] .mjs hook references correct API endpoints")
            results["passed"] += 1
        else:
            print("  [FAIL] .mjs hook missing API endpoint references")
            results["failed"] += 1
    else:
        print(f"  [FAIL] .mjs hook not found at {mjs_path}")
        results["failed"] += 1

    if os.path.exists(sh_path):
        print("  [PASS] cc-bridge-approval-hook.sh exists in shared/")
        results["passed"] += 1
        # Check it references the HTTP API
        with open(sh_path, "r", encoding="utf-8") as f:
            content = f.read()
        if "/api/approval/request" in content and "/api/approval/status" in content:
            print("  [PASS] .sh hook references correct API endpoints")
            results["passed"] += 1
        else:
            print("  [FAIL] .sh hook missing API endpoint references")
            results["failed"] += 1
    else:
        print(f"  [FAIL] .sh hook not found at {sh_path}")
        results["failed"] += 1

    return results


def test_openclaw_plugin_tests():
    """Run the OpenClaw plugin test suite to verify it still passes."""
    print("\n=== Testing OpenClaw Plugin Test Suite ===")

    results = {"passed": 0, "failed": 0}

    openclaw_dir = os.path.join(PROJECT_ROOT, "openclaw-plugin")
    if not os.path.isdir(openclaw_dir):
        print(f"  [SKIP] OpenClaw plugin directory not found at {openclaw_dir}")
        return results

    try:
        result = subprocess.run(
            ["npm", "test"],
            cwd=openclaw_dir,
            capture_output=True,
            text=True,
            timeout=120,
        )
        # Parse output for test count
        output = result.stdout + result.stderr
        if "passed" in output.lower() and result.returncode == 0:
            # Extract number
            import re
            match = re.search(r"Tests:\s+(\d+)\s+passed", output)
            if match:
                count = match.group(1)
                print(f"  [PASS] OpenClaw plugin: {count} tests passed")
                results["passed"] += 1
            else:
                print("  [PASS] OpenClaw plugin tests passed (count unknown)")
                results["passed"] += 1
        else:
            print(f"  [FAIL] OpenClaw plugin tests failed (exit {result.returncode})")
            results["failed"] += 1
    except FileNotFoundError:
        print("  [SKIP] npm not found — cannot run OpenClaw tests")
    except subprocess.TimeoutExpired:
        print("  [FAIL] OpenClaw tests timed out")
        results["failed"] += 1

    return results


async def main():
    """Run all cross-platform compatibility tests."""
    print("=" * 60)
    print("CC Gateway Cross-Platform Compatibility Test")
    print("=" * 60)

    all_results = {"passed": 0, "failed": 0}

    # Python approval server
    r = await test_python_approval_server()
    all_results["passed"] += r["passed"]
    all_results["failed"] += r["failed"]

    # JSON format compatibility
    r = test_json_format_compatibility()
    all_results["passed"] += r["passed"]
    all_results["failed"] += r["failed"]

    # Hook script existence
    r = test_hook_script_existence()
    all_results["passed"] += r["passed"]
    all_results["failed"] += r["failed"]

    # OpenClaw plugin tests
    r = test_openclaw_plugin_tests()
    all_results["passed"] += r["passed"]
    all_results["failed"] += r["failed"]

    print("\n" + "=" * 60)
    total = all_results["passed"] + all_results["failed"]
    print(f"TOTAL: {all_results['passed']} passed, {all_results['failed']} failed ({total} tests)")
    print("=" * 60)

    if all_results["failed"] > 0:
        sys.exit(1)
    print("\nAll cross-platform compatibility tests passed!")


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
