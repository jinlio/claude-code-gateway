"""ApprovalServer — two-phase polling HTTP server for approval control.

Port of openclaw-plugin/src/core/approval-server.js.
CRITICAL: Must implement the EXACT HTTP API per shared/approval-api.md specification.

Uses aiohttp for the HTTP server.  Three endpoints:
  - POST /api/approval/request
  - GET  /api/approval/status
  - POST /api/approval/respond

See: cc-bridge-v3-final-plan.md Section 3, shared/approval-api.md
"""

import asyncio
import hmac
import json
import logging
from typing import Any, Callable, Optional

from aiohttp import web

from .approval_rules import ApprovalRules
from .approval_store import ApprovalStore

logger = logging.getLogger(__name__)


class ApprovalServer:
    """HTTP server implementing the CC Gateway Approval API."""

    def __init__(
        self,
        data_dir: str,
        port: int = 0,
        notify_callback: Optional[Callable] = None,
        approval_rules: Optional[ApprovalRules] = None,
        current_mode: str = "efficient",
        shared_secret: Optional[str] = None,
    ) -> None:
        self.port: int = port
        self.data_dir: str = data_dir
        self.site: Optional[web.TCPSite] = None
        self.runner: Optional[web.AppRunner] = None
        self.store: ApprovalStore = ApprovalStore(data_dir)
        self.notify_callback: Optional[Callable] = notify_callback
        self.approval_rules: Optional[ApprovalRules] = approval_rules
        self.current_mode: str = current_mode
        self.shared_secret: Optional[str] = shared_secret
        self.onApprovalNeeded: Optional[Callable] = None
        self._cleanup_task: Optional[asyncio.Task] = None

    @web.middleware
    async def _security_headers_middleware(self, request, handler):
        """Add X-Content-Type-Options: nosniff to all responses."""
        response = await handler(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    def setMode(self, mode: str) -> None:
        """Switch the approval mode (efficient or strict)."""
        self.current_mode = mode

    async def start(self) -> int:
        """Start the HTTP server. Returns the actual port (OS-assigned if port=0)."""
        timed_out_count = self.store._load_timed_out_count()
        if timed_out_count > 0:
            self._notify_timed_out_requests(timed_out_count)

        app = web.Application(middlewares=[self._security_headers_middleware])
        app.router.add_post("/api/approval/request", self._handle_request)
        app.router.add_get("/api/approval/status", self._handle_status)
        app.router.add_post("/api/approval/respond", self._handle_respond)

        self.runner = web.AppRunner(app)
        await self.runner.setup()

        # Bind to 127.0.0.1; port=0 means OS-assigned
        self.site = web.TCPSite(self.runner, "127.0.0.1", self.port)
        await self.site.start()

        # Start periodic cleanup
        self._cleanup_task = asyncio.create_task(self._periodic_cleanup())

        # Retrieve the actual assigned port
        # In aiohttp >=3.9, the bound sockets live on the TCPSite's
        # underlying asyncio.Server, not on the AppRunner's Server object.
        server = self.site._server if hasattr(self.site, "_server") else None
        sockets = server.sockets if server else None
        if sockets:
            for sock in sockets:
                actual_port = sock.getsockname()[1]
                self.port = actual_port
                break

        return self.port

    async def stop(self) -> None:
        """Stop the server and mark all pending requests as TIMEOUT."""
        if self._cleanup_task:
            self._cleanup_task.cancel()
            self._cleanup_task = None
        self.store.markAllPendingAsTimeout()
        self.store.flush()
        if self.site:
            await self.site.stop()
        if self.runner:
            await self.runner.cleanup()
        self.site = None
        self.runner = None

    async def _periodic_cleanup(self) -> None:
        """Periodically cleanup old approval requests every 10 minutes."""
        while True:
            await asyncio.sleep(600)  # 10 minutes
            self.store.cleanup()

    def _notify_timed_out_requests(self, timed_out_count: int) -> None:
        """Notify about requests that timed out on server restart."""
        if timed_out_count > 0 and self.notify_callback:
            self.notify_callback({
                "type": "restart_timeout",
                "text": f"⚠ 审批服务重启，有 {timed_out_count} 条审批请求已超时中断。"
            })

    def getPort(self) -> int:
        """Return the actual bound port."""
        return self.port

    # ---- HTTP handlers ----

    async def _handle_request(self, request: web.Request) -> web.Response:
        """POST /api/approval/request — create an approval request or auto-approve."""
        try:
            body = await request.text()
            params = json.loads(body)
        except json.JSONDecodeError:
            return web.Response(status=400, text="Invalid JSON body")

        # Validate required fields
        REQUIRED_FIELDS = ("sessionId", "toolName", "toolInput", "cwd")
        for field in REQUIRED_FIELDS:
            if not params.get(field):
                return web.Response(status=400, text=f"Missing required field: {field}")

        # Rule-based pre-check: auto_approve if rules match
        if self.approval_rules:
            tool_input_parsed: dict[str, Any] = {}
            try:
                tool_input_parsed = json.loads(params.get("toolInput", "{}"))
            except (json.JSONDecodeError, TypeError):
                pass

            match_result = self.approval_rules.match(
                params.get("toolName", ""),
                {
                    "command": tool_input_parsed.get("command"),
                    "filePath": tool_input_parsed.get("file_path"),
                },
            )

            # In strict mode, override auto_approve for Write/Edit
            is_strict_override = (
                self.current_mode == "strict"
                and params.get("toolName") in ("Write", "Edit")
                and match_result.get("action") == "auto_approve"
            )

            if match_result.get("action") == "auto_approve" and not is_strict_override:
                return web.Response(
                    status=200,
                    content_type="application/json",
                    text=json.dumps({
                        "approvalId": None,
                        "status": "APPROVED",
                        "autoApproved": True,
                        "sensitive": match_result.get("sensitive", False),
                    }),
                )

        # require_approval: create PENDING request
        id_ = self.store.create(params)
        response_data = {
            "approvalId": id_,
            "status": "PENDING",
        }
        if self.onApprovalNeeded:
            self.onApprovalNeeded(id_, params)
        return web.Response(
            status=200,
            content_type="application/json",
            text=json.dumps(response_data),
        )

    async def _handle_status(self, request: web.Request) -> web.Response:
        """GET /api/approval/status?id={uuid} — poll the status of a request."""
        id_ = request.query.get("id")
        if not id_ or len(id_) < 8:
            return web.Response(status=400, text="Invalid or missing id parameter")

        item = self.store.get(id_)
        if not item:
            return web.Response(status=404, text="NOT FOUND")

        return web.Response(
            status=200,
            content_type="application/json",
            text=json.dumps({
                "approvalId": id_,
                "status": item.get("status"),
            }),
        )

    async def _handle_respond(self, request: web.Request) -> web.Response:
        """POST /api/approval/respond?id={uuid}&action={approve|deny}

        Require Bearer sharedSecret authentication on this endpoint.
        """
        # Deny all respond requests when shared_secret is not configured
        if not self.shared_secret:
            return web.Response(status=403, text="Forbidden: no shared secret configured")

        auth_header = request.headers.get("Authorization", "")
        expected = f"Bearer {self.shared_secret}"
        if not hmac.compare_digest(auth_header.encode(), expected.encode()):
            logger.warning("Approval respond auth failure from %s", request.remote)
            return web.Response(status=403, text="Forbidden")

        id_ = request.query.get("id")
        if not id_:
            return web.Response(status=400, text="Missing id parameter")

        action = request.query.get("action")
        if action not in ("approve", "deny"):
            return web.Response(status=400, text="Invalid action")

        new_status = "APPROVED" if action == "approve" else "DENIED"
        logger.info("Approval %s for request %s", new_status, id_)
        self.store.resolve(id_, new_status)

        return web.Response(status=200, text="OK")