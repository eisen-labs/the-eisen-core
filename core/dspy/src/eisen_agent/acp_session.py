"""ACP session management for spawning and communicating with coding agents."""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import acp
from acp.connection import Connection

from eisen_agent.config import AgentConfig

logger = logging.getLogger(__name__)

# Pattern emitted by eisen-core on stderr: "eisen-core tcp port: 12345"
_TCP_PORT_RE = re.compile(r"eisen-core tcp port:\s*(\d+)")

PROTOCOL_VERSION = acp.PROTOCOL_VERSION

# Default timeout for ACP session/new (seconds)
_SESSION_NEW_TIMEOUT = 30


def _find_eisen_core_binary() -> str:
    """Locate the eisen-core binary.

    Checks PATH first, falls back to local dev build paths.
    """
    found = shutil.which("eisen-core")
    if found:
        return found

    # Dev fallback: check workspace build outputs
    candidates = [
        os.path.join(
            os.path.dirname(__file__),
            "..",
            "..",
            "..",
            "target",
            "release",
            "eisen-core",
        ),
        os.path.join(
            os.path.dirname(__file__), "..", "..", "..", "target", "debug", "eisen-core"
        ),
    ]
    for path in candidates:
        resolved = os.path.realpath(path)
        if os.path.isfile(resolved) and os.access(resolved, os.X_OK):
            return resolved

    raise FileNotFoundError(
        "eisen-core binary not found on PATH or in target/. "
        "Build it with: cargo build -p eisen-core"
    )


class AgentAuthenticationError(Exception):
    """Raised when an ACP agent requires authentication before use."""

    def __init__(self, agent_name: str, auth_methods: list[dict[str, Any]]):
        self.agent_name = agent_name
        self.auth_methods = auth_methods
        instructions = []
        for method in auth_methods:
            name = method.get("name", "Unknown")
            desc = method.get("description", "")
            if desc:
                instructions.append(f"  - {name}: {desc}")
            else:
                instructions.append(f"  - {name}")
        methods_text = "\n".join(instructions)
        super().__init__(
            f"Agent '{agent_name}' requires authentication.\n"
            f"Available auth methods:\n{methods_text}"
        )


@dataclass
class SessionUpdate:
    """A single update received during an ACP prompt session."""

    kind: str  # "text", "thought", "tool_call", "usage", "other"
    text: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


class _ClientHandler:
    """ACP MethodHandler implementation for client-side communication.

    The ACP Connection expects a callable matching:
        (method: str, params: JsonValue | None, is_notification: bool) -> JsonValue | None

    This class dispatches ACP method calls/notifications to appropriate handlers
    and collects session updates into a queue for the session manager.
    """

    def __init__(self) -> None:
        self.updates: asyncio.Queue[SessionUpdate] = asyncio.Queue()
        self._done = asyncio.Event()
        self._stop_reason: str | None = None

    async def __call__(
        self, method: str, params: Any | None, is_notification: bool
    ) -> Any | None:
        """Dispatch incoming ACP methods and notifications."""
        if method == "session/update":
            await self._handle_session_update(params)
            return None
        elif method == "requestPermission":
            return self._handle_request_permission(params)
        elif method == "readTextFile":
            return self._handle_read_text_file(params)
        elif method == "writeTextFile":
            return None
        elif method in (
            "createTerminal",
            "terminalOutput",
            "releaseTerminal",
            "waitForTerminalExit",
            "killTerminal",
        ):
            return None
        else:
            logger.debug(f"Unhandled ACP method: {method}")
            return None

    async def _handle_session_update(self, params: Any) -> None:
        """Process a session/update notification from the agent."""
        if params is None:
            return

        # params is typically a dict with update type information
        if isinstance(params, dict):
            update_type = params.get("type", params.get("kind", ""))
            raw = params
        else:
            update_type = getattr(params, "type", "unknown")
            raw = params.model_dump() if hasattr(params, "model_dump") else {}

        # Dispatch by update content type
        if update_type in ("agentMessage", "AgentMessageChunk"):
            content = params.get("content", "") if isinstance(params, dict) else ""
            await self.updates.put(SessionUpdate(kind="text", text=str(content)))
        elif update_type in ("agentThought", "AgentThoughtChunk"):
            content = params.get("content", "") if isinstance(params, dict) else ""
            await self.updates.put(SessionUpdate(kind="thought", text=str(content)))
        elif update_type in ("toolCallStart", "ToolCallStart"):
            title = params.get("title", "") if isinstance(params, dict) else ""
            await self.updates.put(
                SessionUpdate(kind="tool_call", text=str(title), raw=raw)
            )
        elif update_type in ("usageUpdate", "UsageUpdate"):
            await self.updates.put(SessionUpdate(kind="usage", raw=raw))
        else:
            # Try to extract text from nested update field
            update_field = (
                params.get("update", params) if isinstance(params, dict) else params
            )
            if isinstance(update_field, dict):
                content = update_field.get("content", update_field.get("text", ""))
                kind = update_field.get("type", "other")
                if "message" in kind.lower() or "text" in kind.lower():
                    await self.updates.put(
                        SessionUpdate(kind="text", text=str(content))
                    )
                elif "thought" in kind.lower():
                    await self.updates.put(
                        SessionUpdate(kind="thought", text=str(content))
                    )
                elif "usage" in kind.lower():
                    await self.updates.put(
                        SessionUpdate(kind="usage", raw=update_field)
                    )
                elif "tool" in kind.lower():
                    await self.updates.put(
                        SessionUpdate(
                            kind="tool_call",
                            text=update_field.get("title", ""),
                            raw=update_field,
                        )
                    )
                else:
                    await self.updates.put(
                        SessionUpdate(kind="other", raw=update_field)
                    )
            else:
                await self.updates.put(
                    SessionUpdate(
                        kind="other", raw={"type": str(type(update_field).__name__)}
                    )
                )

    def _handle_request_permission(self, params: Any) -> dict[str, Any]:
        """Auto-approve all permission requests from the agent."""
        # Find the first 'allow' option and select it
        options = []
        if isinstance(params, dict):
            options = params.get("options", [])

        for opt in options:
            opt_dict = (
                opt
                if isinstance(opt, dict)
                else (opt.model_dump() if hasattr(opt, "model_dump") else {})
            )
            kind = opt_dict.get("kind", "")
            if kind in ("allow_once", "allow_always"):
                return {
                    "outcome": {
                        "optionId": opt_dict.get(
                            "optionId", opt_dict.get("option_id", "")
                        ),
                        "outcome": "selected",
                    }
                }

        # Fallback: if no allow option found, try the first option
        if options:
            opt = options[0]
            opt_dict = (
                opt
                if isinstance(opt, dict)
                else (opt.model_dump() if hasattr(opt, "model_dump") else {})
            )
            return {
                "outcome": {
                    "optionId": opt_dict.get("optionId", opt_dict.get("option_id", "")),
                    "outcome": "selected",
                }
            }

        return {"outcome": {"optionId": "", "outcome": "selected"}}

    def _handle_read_text_file(self, params: Any) -> dict[str, Any]:
        """Handle file read requests from the agent."""
        path = ""
        if isinstance(params, dict):
            path = params.get("path", "")

        try:
            with open(path) as f:
                content = f.read()
            return {"content": content}
        except Exception as e:
            logger.warning(f"Failed to read file {path}: {e}")
            return {"content": ""}

    def mark_done(self, stop_reason: str | None = None) -> None:
        self._stop_reason = stop_reason
        self._done.set()

    async def wait_done(self, timeout: float | None = None) -> None:
        if timeout:
            await asyncio.wait_for(self._done.wait(), timeout)
        else:
            await self._done.wait()


class ACPSession:
    """Manages a single ACP session with a coding agent.

    Wraps the agent process with eisen-core observe for activity tracking.
    Communicates via ACP JSON-RPC over stdio.
    """

    def __init__(
        self,
        agent_config: AgentConfig,
        workspace: str,
        agent_id: str,
    ):
        self._agent_config = agent_config
        self._workspace = os.path.abspath(workspace)
        self._agent_id = agent_id
        self._process: asyncio.subprocess.Process | None = None
        self._connection: Connection | None = None
        self._handler = _ClientHandler()
        self._tcp_port: int | None = None
        self._session_id: str | None = None
        self._agent: Any = None  # Proxy to call agent methods

    @property
    def tcp_port(self) -> int | None:
        """The eisen-core TCP port (for graph visualization)."""
        return self._tcp_port

    @property
    def session_id(self) -> str | None:
        """The active ACP session ID."""
        return self._session_id

    def build_spawn_command(
        self,
        zone_patterns: list[str] | None = None,
        deny_patterns: list[str] | None = None,
    ) -> list[str]:
        """Build the command to spawn the agent process with eisen-core wrapping.

        Args:
            zone_patterns: Glob patterns for allowed file paths (Phase 3 zones).
                           Each pattern is passed as a separate --zone flag.
            deny_patterns: Glob patterns for explicitly denied file paths.
                           Each pattern is passed as a separate --deny flag.

        Returns the command as a list of strings for subprocess exec.
        """
        eisen_core = _find_eisen_core_binary()
        cmd = [
            eisen_core,
            "observe",
            "--port",
            "0",
            "--agent-id",
            self._agent_id,
        ]
        if zone_patterns:
            for pattern in zone_patterns:
                cmd.extend(["--zone", pattern])
        if deny_patterns:
            for pattern in deny_patterns:
                cmd.extend(["--deny", pattern])
        cmd.append("--")
        cmd.extend([self._agent_config.command, *self._agent_config.args])
        return cmd

    async def start(
        self,
        zone_patterns: list[str] | None = None,
        deny_patterns: list[str] | None = None,
    ) -> None:
        """Spawn the agent process wrapped with eisen-core observe.

        Args:
            zone_patterns: Glob patterns for allowed file paths (Phase 3 zones).
            deny_patterns: Glob patterns for explicitly denied file paths.

        Parses 'eisen-core tcp port: XXXXX' from stderr to get the TCP port.
        """
        cmd = self.build_spawn_command(zone_patterns, deny_patterns)
        logger.info(f"Spawning agent: {' '.join(cmd)}")

        self._process = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self._workspace,
        )

        # Read stderr in background to capture TCP port
        if self._process.stderr:
            asyncio.create_task(self._read_stderr(self._process.stderr))

        # Set up ACP connection over stdio
        assert self._process.stdin is not None
        assert self._process.stdout is not None

        self._connection = Connection(
            self._handler,
            self._process.stdin,
            self._process.stdout,
        )

    async def _read_stderr(self, stream: asyncio.StreamReader) -> None:
        """Read stderr line-by-line, looking for the TCP port announcement."""
        while True:
            line = await stream.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").strip()
            if text:
                logger.debug(f"[agent stderr] {text}")
                match = _TCP_PORT_RE.search(text)
                if match:
                    self._tcp_port = int(match.group(1))
                    logger.info(f"eisen-core TCP port: {self._tcp_port}")

    async def initialize(self) -> dict:
        """Send ACP initialize request, receive capabilities.

        Raises:
            AgentAuthenticationError: if the agent requires authentication.
        """
        assert self._connection is not None, "Call start() first"

        response = await self._connection.send_request(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "clientInfo": {"name": "eisen-agent", "version": "0.1.0"},
            },
        )

        # Check if the agent requires authentication
        auth_methods = response.get("authMethods", [])
        if auth_methods:
            agent_info = response.get("agentInfo", {})
            agent_name = agent_info.get("name", self._agent_id)
            raise AgentAuthenticationError(agent_name, auth_methods)

        return response

    async def new_session(self, timeout: float = _SESSION_NEW_TIMEOUT) -> str:
        """Send session/new, return session_id.

        Args:
            timeout: Maximum seconds to wait for the agent to create a
                     session.  Defaults to _SESSION_NEW_TIMEOUT.

        Raises:
            TimeoutError: if the agent does not respond in time.
        """
        assert self._connection is not None, "Call start() first"

        try:
            response = await asyncio.wait_for(
                self._connection.send_request(
                    "session/new",
                    {"cwd": self._workspace, "mcpServers": []},
                ),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            raise TimeoutError(
                f"Agent did not respond to session/new within {timeout}s. "
                "The agent may require authentication, is unresponsive or hit rate limit."
            ) from None

        session_id = response.get("sessionId", "")
        self._session_id = session_id
        return session_id

    async def prompt(self, content: str) -> AsyncIterator[SessionUpdate]:
        """Send session/prompt with content, yield streaming session/update messages.

        The prompt is sent and then we collect updates from the handler's queue
        until the prompt response is received (indicates agent is done).
        """
        assert self._connection is not None, "Call start() first"
        assert self._session_id is not None, "Call new_session() first"

        # Send prompt as a request (non-blocking, response comes when agent finishes)
        prompt_task = asyncio.create_task(
            self._connection.send_request(
                "session/prompt",
                {
                    "sessionId": self._session_id,
                    "prompt": [{"type": "text", "text": content}],
                },
            )
        )

        # Yield updates from the handler queue while waiting for prompt to complete
        while not prompt_task.done():
            # Check if the agent process has exited unexpectedly
            if self._process is not None and self._process.returncode is not None:
                logger.error(
                    f"Agent process exited with code {self._process.returncode} "
                    "during prompt execution"
                )
                prompt_task.cancel()
                yield SessionUpdate(
                    kind="error",
                    text=f"Agent process exited unexpectedly (code {self._process.returncode})",
                    raw={"exitCode": self._process.returncode},
                )
                return

            try:
                update = await asyncio.wait_for(
                    self._handler.updates.get(), timeout=0.5
                )
                yield update
            except asyncio.TimeoutError:
                continue

        # Drain any remaining queued updates
        while not self._handler.updates.empty():
            yield await self._handler.updates.get()

        # Process the prompt response
        try:
            response = prompt_task.result()
            stop_reason = response.get("stopReason", "unknown")
            yield SessionUpdate(
                kind="done",
                text=f"Agent finished (stopReason: {stop_reason})",
                raw=response,
            )
        except Exception as e:
            yield SessionUpdate(
                kind="error",
                text=f"Prompt failed: {e}",
                raw={"error": str(e)},
            )

    async def kill(self) -> None:
        """Terminate the agent process and clean up."""
        if self._connection:
            try:
                await self._connection.close()
            except Exception:
                pass
            self._connection = None

        if self._process:
            try:
                self._process.kill()
                await self._process.wait()
            except Exception:
                pass
            self._process = None


def parse_tcp_port_from_stderr(line: str) -> int | None:
    """Extract the TCP port from an eisen-core stderr line.

    Returns the port number or None if the line doesn't contain it.
    """
    match = _TCP_PORT_RE.search(line)
    return int(match.group(1)) if match else None
