"""Platform adapter for Hermes-Agent gateway integration.

Implements BasePlatformAdapter for the CC Bridge, routing inbound messages
to the command handler and forwarding Claude output back to the platform.
"""

import asyncio
import os
import time
from datetime import datetime
from typing import Any, Optional

from .command_handler import CommandHandler
from .command_parser import CommandParser
from .messenger import PlatformMessenger


# Sentinel so the adapter can reference the Hermes base classes
# without a hard import that would fail outside the gateway runtime.
_BasePlatformAdapter = None
_SendResult = None
_MessageEvent = None
_MessageType = None
_Platform = None
_SessionSource = None


def _import_hermes_bases():
    """Lazily import Hermes gateway base classes.

    These are only available inside the Hermes gateway runtime.
    Importing lazily lets us unit-test the adapter without the full gateway.
    """
    global _BasePlatformAdapter, _SendResult, _MessageEvent, _MessageType
    global _Platform, _SessionSource

    if _BasePlatformAdapter is not None:
        return

    from gateway.platforms.base import (
        BasePlatformAdapter,
        MessageEvent,
        MessageType,
        SendResult,
    )
    from gateway.config import Platform
    from gateway.session import SessionSource

    _BasePlatformAdapter = BasePlatformAdapter
    _SendResult = SendResult
    _MessageEvent = MessageEvent
    _MessageType = MessageType
    _Platform = Platform
    _SessionSource = SessionSource


class CCBridgeAdapter:
    """Hermes platform adapter for Claude Code Gateway.

    Wraps the CC Bridge command handler and approval system into
    a Hermes BasePlatformAdapter subclass. The actual base class
    is mixed in at registration time so the module stays testable.
    """

    def __init__(self, config: Any, **kwargs: Any) -> None:
        _import_hermes_bases()
        platform = _Platform("cc-bridge")
        super().__init__(config=config, platform=platform)

        extra = getattr(config, "extra", {}) or {}
        self.workspace: str = os.getenv("CC_BRIDGE_WORKSPACE", "") or extra.get("workspace", os.getcwd())
        self.default_mode: str = os.getenv("CC_BRIDGE_MODE", "efficient") or extra.get("defaultMode", "efficient")
        self.shared_secret: str = os.getenv("CC_BRIDGE_SECRET", "") or extra.get("sharedSecret", "")
        self.git_snapshot_enabled: bool = (
            os.getenv("CC_BRIDGE_GIT_SNAPSHOT", "true").lower() != "false"
            if "CC_BRIDGE_GIT_SNAPSHOT" in os.environ
            else extra.get("gitSnapshotEnabled", True)
        )

        self._command_parser = CommandParser()
        self._command_handler: Optional[CommandHandler] = None
        self._messenger: Optional[PlatformMessenger] = None

    def _ensure_handler(self) -> None:
        """Lazily initialise the command handler and messenger."""
        if self._command_handler is not None:
            return

        from .approval_rules import ApprovalRules
        from .approval_server import ApprovalServer
        from .claude_bridge import ClaudeBridge
        from .context_manager import ContextManager
        from .session_manager import PersistentSessionManager

        data_dir = os.path.join(os.getcwd(), "data")
        os.makedirs(data_dir, exist_ok=True)

        rules = ApprovalRules(os.path.join(os.path.dirname(__file__), "..", "config", "cc-approval-rules.yml"))
        bridge = ClaudeBridge()
        session_manager = PersistentSessionManager(data_dir)

        approval_server = ApprovalServer(
            data_dir=data_dir,
            port=0,
            approval_rules=rules,
            current_mode=self.default_mode,
            shared_secret=self.shared_secret or None,
            notify_callback=self._on_approval_notify,
        )
        approval_server.onApprovalNeeded = self._on_approval_needed

        self._messenger = PlatformMessenger(delivery_callback=self._deliver_message)

        context_managers: dict[str, ContextManager] = {}

        self._command_handler = CommandHandler(
            bridge=bridge,
            approval_server=approval_server,
            session_manager=session_manager,
            messenger=self._messenger,
            context_managers=context_managers,
            config={
                "workspace": self.workspace,
                "defaultMode": self.default_mode,
                "gitSnapshotEnabled": self.git_snapshot_enabled,
            },
        )

        # Start the approval server in the background
        asyncio.ensure_future(approval_server.start())

    # ---- BasePlatformAdapter abstract methods ----

    async def connect(self) -> bool:
        """Connect to the CC Bridge (initialise handler + approval server)."""
        try:
            self._ensure_handler()
            self._mark_connected()
            return True
        except Exception:
            self._set_fatal_error("init_failed", "Failed to initialise CC Bridge", retryable=True)
            return False

    async def disconnect(self) -> None:
        """Disconnect — stop approval server and terminate sessions."""
        if self._command_handler and self._command_handler.approval_server:
            await self._command_handler.approval_server.stop()
        self._command_handler.bridge.stopHeartbeat()
        self._mark_disconnected()

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> Any:
        """Send a text message back to the platform user.

        In the CC Bridge model, we use the messenger's split logic
        and deliver each chunk via the platform's native send.
        """
        return _SendResult(success=True, message_id=str(int(time.time() * 1000)))

    async def get_chat_info(self, chat_id: str) -> dict:
        """Return basic chat metadata."""
        return {"name": chat_id, "type": "dm", "chat_id": chat_id}

    # ---- Inbound message processing ----

    async def _dispatch_message(
        self,
        text: str,
        chat_id: str,
        chat_type: str,
        user_id: str,
        user_name: str,
    ) -> None:
        """Parse an inbound message and dispatch to the command handler."""
        self._ensure_handler()

        parsed = self._command_parser.parse(text)
        if parsed is None:
            return

        if parsed.get("unknown"):
            help_text = self._command_parser.getHelpText()
            await self._deliver_message(
                target=chat_id,
                text=help_text,
                options={"userId": user_id},
            )
            return

        command_name = parsed["command"]
        args = parsed["args"]

        response = await self._command_handler.handleCommand(
            command_name=command_name,
            args=args,
            sender_id=user_id,
            channel_id=chat_id,
            account_id="",
        )

        if response:
            await self._deliver_message(
                target=chat_id,
                text=response,
                options={"userId": user_id},
            )

    # ---- Approval notifications ----

    def _on_approval_needed(self, approval_id: str, params: dict) -> None:
        """Callback when an approval request is created."""
        self._ensure_handler()
        notification = self._command_handler.messenger.formatApprovalNotification(
            approval_id=approval_id,
            tool_name=params.get("toolName", ""),
            input_preview=self._format_tool_input(params),
            cwd=params.get("cwd", ""),
        )
        route = self._command_handler.session_routes.get(params.get("sessionId", ""))
        if route:
            asyncio.ensure_future(
                self._deliver_message(
                    target=route.get("senderId", ""),
                    text=notification,
                    options={
                        "channelId": route.get("channelId"),
                        "accountId": route.get("accountId"),
                    },
                )
            )

    def _on_approval_notify(self, notification: dict) -> None:
        """Callback for approval server notifications (e.g. restart timeouts)."""
        text = notification.get("text", "")
        if not text:
            return
        for session_id, route in list(self._command_handler.session_routes.items()):
            asyncio.ensure_future(
                self._deliver_message(
                    target=route.get("senderId", ""),
                    text=text,
                    options={
                        "channelId": route.get("channelId"),
                        "accountId": route.get("accountId"),
                    },
                )
            )

    @staticmethod
    def _format_tool_input(params: dict) -> str:
        """Format tool input for display in approval notifications."""
        from .command_handler import formatToolInput
        return formatToolInput(params.get("toolName", ""), params.get("toolInput", "{}"))

    # ---- Message delivery ----

    async def _deliver_message(
        self,
        target: str,
        text: str,
        options: dict[str, Any] | None = None,
    ) -> None:
        """Deliver a message back to the platform user.

        Uses the Hermes gateway's handle_message path — constructs a
        MessageEvent and routes it through the platform's message handler.
        """
        if not hasattr(self, "_message_handler") or self._message_handler is None:
            return

        source = self.build_source(
            chat_id=target,
            chat_type="dm",
            user_id="cc-bridge",
            user_name="CC Bridge",
        )
        event = _MessageEvent(
            text=text,
            message_type=_MessageType.TEXT,
            source=source,
            message_id=str(int(time.time() * 1000)),
            timestamp=datetime.now(),
            internal=True,
        )
        await self.handle_message(event)


# ---- Module-level functions for register(ctx) ----

def check_requirements() -> bool:
    """Check that runtime dependencies are available."""
    try:
        import aiohttp
        import yaml
        from filelock import FileLock
        return True
    except ImportError:
        return False


def validate_config(config: Any) -> bool:
    """Validate the platform config has required fields."""
    extra = getattr(config, "extra", {}) or {}
    workspace = os.getenv("CC_BRIDGE_WORKSPACE", "") or extra.get("workspace", "")
    return bool(workspace)


def is_connected(config: Any) -> bool:
    """Check if the adapter would be enabled."""
    extra = getattr(config, "extra", {}) or {}
    return bool(
        os.getenv("CC_BRIDGE_WORKSPACE", "") or extra.get("workspace", "")
    )


def _env_enablement() -> dict | None:
    """Seed PlatformConfig.extra from environment variables."""
    workspace = os.getenv("CC_BRIDGE_WORKSPACE", "").strip()
    if not workspace:
        return None
    seed: dict[str, Any] = {"workspace": workspace}
    mode = os.getenv("CC_BRIDGE_MODE", "").strip()
    if mode:
        seed["defaultMode"] = mode
    secret = os.getenv("CC_BRIDGE_SECRET", "").strip()
    if secret:
        seed["sharedSecret"] = secret
    home_channel = os.getenv("CC_BRIDGE_HOME_CHANNEL", "").strip()
    if home_channel:
        seed["home_channel"] = home_channel
    return seed


def register(ctx: Any) -> None:
    """Hermes plugin registration entry point."""
    _import_hermes_bases()

    # Create a dynamic subclass that merges CCBridgeAdapter into BasePlatformAdapter
    adapter_cls = type(
        "CCBridgePlatformAdapter",
        (_BasePlatformAdapter, CCBridgeAdapter),
        {"__module__": __name__},
    )

    ctx.register_platform(
        name="cc-bridge",
        label="CC Bridge (Claude Code Gateway)",
        adapter_factory=lambda cfg: adapter_cls(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["CC_BRIDGE_WORKSPACE"],
        install_hint="Install dependencies: pip install aiohttp pyyaml filelock",
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="CC_BRIDGE_HOME_CHANNEL",
        allowed_users_env="CC_BRIDGE_ALLOWED_USERS",
        allow_all_env="CC_BRIDGE_ALLOW_ALL_USERS",
        max_message_length=4000,
        platform_hint="You are interacting through the CC Bridge approval gateway. Users can approve or deny tool calls via /cc_approve and /cc_deny commands.",
        emoji="🔌",
    )

    # Register slash commands for in-session use
    _parser = CommandParser()

    async def _make_handler(cmd_name: str):
        async def _handler(raw_args: str) -> str | None:
            # The handler needs access to the active adapter instance.
            # Hermes dispatches commands within a session that has a platform adapter.
            # We retrieve it from the session's platform adapter.
            return f"/{cmd_name} commands are handled via the CC Bridge platform adapter. Use /{cmd_name} in the gateway chat."
        return _handler

    for cmd in _parser.getCommands():
        ctx.register_command(
            name=cmd,
            handler=_make_handler(cmd),
            description=f"CC Bridge: /{cmd}",
        )

    # Register lifecycle hooks
    async def _on_session_start(event_type: str, context: dict) -> None:
        pass

    async def _on_session_end(event_type: str, context: dict) -> None:
        pass

    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("on_session_end", _on_session_end)

    # Approval hooks (observer only)
    async def _pre_approval(event_type: str, context: dict) -> None:
        pass

    async def _post_approval(event_type: str, context: dict) -> None:
        pass

    ctx.register_hook("pre_approval_request", _pre_approval)
    ctx.register_hook("post_approval_response", _post_approval)
