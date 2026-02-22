"""A2A Router: resolves cross-region dependency queries.

Resolution order:
  1. PyO3 symbol tree (zero cost -- tree-sitter parse, no LLM tokens)
  2. Owning agent (routes query to the agent assigned to that region)
  3. Graceful fallback (return "symbol not found" with available context)
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from eisen_agent.acp_session import ACPSession

logger = logging.getLogger(__name__)


class A2ARouter:
    """Routes cross-region dependency queries between agents.

    When an agent needs information about a symbol outside its assigned
    workspace region, the router resolves it:
      1. Zero-cost lookup via the PyO3 symbol tree (tree-sitter)
      2. Route to the agent that owns the relevant region
      3. Return a "not found" message with available context
    """

    def __init__(self, workspace: str):
        self._workspace = workspace
        self._region_map: dict[str, str] = {}  # region -> agent_id
        self._sessions: dict[str, "ACPSession"] = {}  # agent_id -> session
        self._symbol_cache: dict[str, str] = {}  # symbol_name -> resolved text

    def register_agent(self, region: str, agent_id: str, session: "ACPSession") -> None:
        """Register an agent as the owner of a workspace region."""
        self._region_map[region] = agent_id
        self._sessions[agent_id] = session
        logger.info(f"Router: registered {agent_id} for region {region}")

    def unregister_agent(self, agent_id: str) -> None:
        """Remove an agent from the router."""
        self._region_map = {r: a for r, a in self._region_map.items() if a != agent_id}
        self._sessions.pop(agent_id, None)
        logger.info(f"Router: unregistered {agent_id}")

    @property
    def registered_agents(self) -> dict[str, str]:
        """Map of region -> agent_id for all registered agents."""
        return dict(self._region_map)

    @property
    def cache_size(self) -> int:
        """Number of cached symbol resolutions."""
        return len(self._symbol_cache)

    def clear_cache(self) -> None:
        """Clear the symbol resolution cache."""
        self._symbol_cache.clear()

    async def resolve(
        self, requesting_agent: str, symbol_name: str, context: str = ""
    ) -> str:
        """Resolve a cross-region dependency.

        Args:
            requesting_agent: ID of the agent making the request
            symbol_name: name of the symbol to look up
            context: additional context (e.g., import path, usage site)

        Returns:
            Compact answer: type signature, function params, struct fields, etc.
        """
        # Step 1: PyO3 symbol tree oracle (zero cost)
        result = self._lookup_symbol_tree(symbol_name)
        if result:
            logger.info(f"Router: resolved '{symbol_name}' via symbol tree (zero cost)")
            return result

        # Step 2: Route to owning agent
        owner = self._find_owner(symbol_name, context)
        if owner and owner != requesting_agent:
            logger.info(
                f"Router: routing '{symbol_name}' query to owning agent {owner}"
            )
            agent_result = await self._query_agent(owner, symbol_name, context)
            if agent_result:
                return agent_result

        # Step 3: Graceful fallback
        logger.info(f"Router: '{symbol_name}' not found via tree or agents")
        return f"Symbol '{symbol_name}' not found in workspace symbol tree or active agents."

    def _lookup_symbol_tree(self, symbol_name: str) -> str | None:
        """Query the PyO3 bridge for a symbol definition."""
        if symbol_name in self._symbol_cache:
            return self._symbol_cache[symbol_name]

        try:
            import eisen_bridge

            result_json = eisen_bridge.lookup_symbol(self._workspace, symbol_name)
            matches = json.loads(result_json)

            if not matches:
                return None

            formatted = self._format_symbol_matches(matches)
            self._symbol_cache[symbol_name] = formatted
            return formatted

        except ImportError:
            logger.warning("eisen_bridge not available for symbol lookup")
            return None
        except Exception as e:
            logger.warning(f"Symbol tree lookup failed for '{symbol_name}': {e}")
            return None

    def _find_owner(self, symbol_name: str, context: str) -> str | None:
        """Determine which agent owns the region containing the symbol.

        Uses import path context to guess the region. For example:
          "from core.parser import X" -> region containing "core"
          "import { AuthValidator } from '../../core/src/auth'" -> region "core"
        """
        combined = f"{symbol_name} {context}".lower()

        for region, agent_id in self._region_map.items():
            # Normalize region for comparison
            region_key = region.lstrip("/").lower()
            if region_key and region_key in combined:
                return agent_id

        return None

    async def _query_agent(
        self, agent_id: str, symbol_name: str, context: str
    ) -> str | None:
        """Ask the owning agent about a symbol.

        Sends a focused query to the agent's existing ACP session.
        The agent answers from its already-loaded context.
        """
        session = self._sessions.get(agent_id)
        if not session or session.session_id is None:
            logger.warning(f"Agent {agent_id} session not available for query")
            return None

        query = (
            f"I need the type signature and brief description of `{symbol_name}`. "
            f"Context: {context}. "
            f"Reply with ONLY the signature/definition, no explanation."
        )

        response_text = ""
        try:
            async for update in session.prompt(query):
                if update.kind == "text":
                    response_text += update.text
                elif update.kind == "done":
                    break
                elif update.kind == "error":
                    logger.warning(f"Agent query error: {update.text}")
                    return None
        except Exception as e:
            logger.warning(f"Failed to query agent {agent_id}: {e}")
            return None

        if response_text.strip():
            # Cache the result for future queries
            self._symbol_cache[symbol_name] = response_text.strip()
            return response_text.strip()

        return None

    def _format_symbol_matches(self, matches: list[dict[str, Any]]) -> str:
        """Format symbol tree matches as compact signatures."""
        lines = []
        for m in matches:
            kind = m.get("kind", "unknown")
            name = m.get("name", "?")
            path = m.get("path", "?")
            start = m.get("startLine", m.get("start_line", 0))
            end = m.get("endLine", m.get("end_line", 0))
            lines.append(f"{kind} {name} ({path}:{start}-{end})")
        return "\n".join(lines)
