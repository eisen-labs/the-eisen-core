"""TCP listener for BlockedAccess messages from eisen-core.

When a zone-enforced eisen-core proxy blocks an agent's file access,
it broadcasts a BlockedAccess message on its TCP stream. This module
connects to that stream and routes blocked access events to the A2A
router for automatic resolution.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from eisen_agent.router import A2ARouter

logger = logging.getLogger(__name__)


@dataclass
class BlockedAccessEvent:
    """Parsed BlockedAccess message from eisen-core TCP stream."""

    agent_id: str
    session_id: str
    path: str
    action: str  # "read" | "write"
    timestamp_ms: int


class BlockedAccessListener:
    """Listens for BlockedAccess messages on eisen-core TCP streams.

    For each blocked access, routes the request through the A2A router
    to resolve the dependency and provides the result back to the
    orchestrator for injection into the agent's next prompt.
    """

    def __init__(self, router: "A2ARouter") -> None:
        self._router = router
        self._blocked_events: list[BlockedAccessEvent] = []
        self._pending_resolutions: dict[str, str] = {}  # agent_id -> resolved text
        self._listeners: dict[str, asyncio.Task[None]] = {}  # agent_id -> task
        self._lock = asyncio.Lock()

    @property
    def blocked_events(self) -> list[BlockedAccessEvent]:
        """All recorded blocked access events."""
        return list(self._blocked_events)

    @property
    def pending_resolutions(self) -> dict[str, str]:
        """Map of agent_id -> resolved cross-region text ready for injection."""
        return dict(self._pending_resolutions)

    def take_resolution(self, agent_id: str) -> str | None:
        """Take and remove a pending resolution for an agent.

        Returns the resolved text if available, None otherwise.
        """
        return self._pending_resolutions.pop(agent_id, None)

    async def start_listening(self, agent_id: str, tcp_port: int) -> None:
        """Start listening for BlockedAccess messages from an agent's eisen-core instance.

        Connects to the TCP port and filters for 'blocked' message types.
        """
        if agent_id in self._listeners:
            logger.warning(f"Already listening for agent {agent_id}")
            return

        task = asyncio.create_task(self._listen_loop(agent_id, tcp_port))
        self._listeners[agent_id] = task
        logger.info(
            f"Started blocked access listener for {agent_id} on port {tcp_port}"
        )

    def stop_listening(self, agent_id: str) -> None:
        """Stop listening for an agent."""
        task = self._listeners.pop(agent_id, None)
        if task and not task.done():
            task.cancel()
            logger.info(f"Stopped blocked access listener for {agent_id}")

    def stop_all(self) -> None:
        """Stop all listeners."""
        for agent_id in list(self._listeners):
            self.stop_listening(agent_id)

    async def _listen_loop(self, agent_id: str, tcp_port: int) -> None:
        """Connect to eisen-core TCP and listen for blocked messages."""
        try:
            reader, _ = await asyncio.open_connection("127.0.0.1", tcp_port)
        except (ConnectionRefusedError, OSError) as e:
            logger.warning(f"Failed to connect to eisen-core TCP for {agent_id}: {e}")
            return

        try:
            while True:
                line = await reader.readline()
                if not line:
                    break

                text = line.decode("utf-8", errors="replace").strip()
                if not text:
                    continue

                try:
                    msg = json.loads(text)
                except json.JSONDecodeError:
                    continue

                if msg.get("type") == "blocked":
                    await self._handle_blocked(msg)

        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.warning(f"Blocked access listener error for {agent_id}: {e}")

    async def _handle_blocked(self, msg: dict[str, Any]) -> None:
        """Handle a BlockedAccess message: record it and resolve via A2A router."""
        event = BlockedAccessEvent(
            agent_id=msg.get("agent_id", ""),
            session_id=msg.get("session_id", ""),
            path=msg.get("path", ""),
            action=msg.get("action", ""),
            timestamp_ms=msg.get("timestamp_ms", 0),
        )

        async with self._lock:
            self._blocked_events.append(event)

        logger.info(
            f"Blocked access detected: agent={event.agent_id} "
            f"path={event.path} action={event.action}"
        )

        # Resolve through A2A router
        # Extract a symbol hint from the file path
        symbol_hint = self._path_to_symbol_hint(event.path)
        context = f"Blocked {event.action} access to {event.path}"

        try:
            resolved = await self._router.resolve(
                requesting_agent=event.agent_id,
                symbol_name=symbol_hint,
                context=context,
            )

            async with self._lock:
                # Append to any existing resolution for this agent
                existing = self._pending_resolutions.get(event.agent_id, "")
                resolution_text = f"\n[Cross-region info for {event.path}]:\n{resolved}"
                self._pending_resolutions[event.agent_id] = existing + resolution_text

            logger.info(
                f"Resolved blocked access for {event.agent_id}: "
                f"{event.path} -> {len(resolved)} chars"
            )

        except Exception as e:
            logger.warning(f"Failed to resolve blocked access for {event.path}: {e}")

    @staticmethod
    def _path_to_symbol_hint(path: str) -> str:
        """Extract a meaningful symbol hint from a file path.

        For example: '/core/src/auth.rs' -> 'auth'
                     '/ui/components/Button.tsx' -> 'Button'
        """
        import os

        basename = os.path.basename(path)
        name, _ = os.path.splitext(basename)
        return name
