"""Cross-session context handoff (Phase 4C).

Persists context from completed orchestration sessions and retrieves
relevant context when a new task relates to a previous one.  This lets
agents build on prior work instead of starting from scratch.

Storage: ~/.eisen/sessions/ directory, one JSON file per session.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

SESSIONS_DIR = Path.home() / ".eisen" / "sessions"


@dataclass
class SessionContext:
    """Captured context from a completed orchestration session."""

    session_id: str
    timestamp: float
    user_intent: str
    workspace: str
    modified_files: dict[str, list[str]] = field(
        default_factory=dict
    )  # region -> [files]
    key_decisions: list[str] = field(default_factory=list)
    resolved_symbols: list[str] = field(default_factory=list)  # A2A resolutions
    conflict_resolutions: list[str] = field(default_factory=list)
    subtask_summaries: list[dict[str, Any]] = field(default_factory=list)
    status: str = ""  # "completed" | "done" | etc.

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SessionContext:
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


def _text_similarity(a: str, b: str) -> float:
    """Simple word-overlap similarity between two strings.

    Returns a value between 0.0 and 1.0. Uses Jaccard similarity
    on lowercased word sets.
    """
    words_a = set(a.lower().split())
    words_b = set(b.lower().split())
    if not words_a or not words_b:
        return 0.0
    intersection = words_a & words_b
    union = words_a | words_b
    return len(intersection) / len(union)


class SessionMemory:
    """Persists context from completed orchestration sessions.

    Stores:
      - Which files were modified per region
      - Key decisions made (from agent output summaries)
      - Symbol signatures that were resolved via A2A
      - Conflict resolutions applied
    """

    def __init__(self, sessions_dir: Path | None = None) -> None:
        self._sessions_dir = sessions_dir or SESSIONS_DIR
        self._sessions_dir.mkdir(parents=True, exist_ok=True)

    def save_session(self, context: SessionContext) -> None:
        """Persist session context to disk."""
        filepath = self._sessions_dir / f"sess_{context.session_id}.json"
        filepath.write_text(json.dumps(context.to_dict(), indent=2))
        logger.info(f"Saved session context {context.session_id} to {filepath}")

    def load_session(self, session_id: str) -> SessionContext | None:
        """Load a specific session by ID."""
        filepath = self._sessions_dir / f"sess_{session_id}.json"
        if not filepath.exists():
            return None
        try:
            data = json.loads(filepath.read_text())
            return SessionContext.from_dict(data)
        except Exception as e:
            logger.warning(f"Failed to load session {session_id}: {e}")
            return None

    def load_relevant_context(
        self,
        user_intent: str,
        workspace: str,
        min_similarity: float = 0.2,
        max_results: int = 3,
    ) -> list[SessionContext]:
        """Find the most relevant previous sessions for the current task.

        Uses simple text similarity between user intents.  Only returns
        sessions from the same workspace.

        Args:
            user_intent: The current user's task description
            workspace: The current workspace path
            min_similarity: Minimum Jaccard similarity threshold
            max_results: Maximum number of relevant sessions to return

        Returns:
            List of SessionContext objects, sorted by relevance (most relevant first).
        """
        if not self._sessions_dir.exists():
            return []

        scored: list[tuple[float, SessionContext]] = []

        for filepath in self._sessions_dir.glob("sess_*.json"):
            try:
                data = json.loads(filepath.read_text())
                ctx = SessionContext.from_dict(data)

                # Only consider sessions from the same workspace
                if ctx.workspace != workspace:
                    continue

                sim = _text_similarity(user_intent, ctx.user_intent)
                if sim >= min_similarity:
                    scored.append((sim, ctx))
            except Exception as e:
                logger.warning(f"Failed to read session {filepath}: {e}")

        # Sort by similarity (descending), then by timestamp (most recent first)
        scored.sort(key=lambda x: (-x[0], -x[1].timestamp))

        results = [ctx for _, ctx in scored[:max_results]]
        if results:
            logger.info(
                f"Found {len(results)} relevant previous session(s) "
                f"for intent: {user_intent[:60]}..."
            )
        return results

    def inject_into_prompt(self, contexts: list[SessionContext], prompt: str) -> str:
        """Augment a sub-agent prompt with context from previous sessions.

        Injects a summary of prior work so the agent can build on it.
        """
        if not contexts:
            return prompt

        injection_parts: list[str] = []
        for ctx in contexts:
            parts: list[str] = [f"Previous related work ('{ctx.user_intent[:80]}'):"]

            if ctx.modified_files:
                for region, files in ctx.modified_files.items():
                    files_str = ", ".join(files[:5])
                    if len(files) > 5:
                        files_str += f" (+{len(files) - 5} more)"
                    parts.append(f"  Region {region}: modified {files_str}")

            if ctx.key_decisions:
                parts.append("  Key decisions:")
                for decision in ctx.key_decisions[:3]:
                    parts.append(f"    - {decision}")

            if ctx.resolved_symbols:
                symbols_str = ", ".join(ctx.resolved_symbols[:5])
                parts.append(f"  Resolved symbols: {symbols_str}")

            injection_parts.append("\n".join(parts))

        injection = "\n\n".join(injection_parts)
        return (
            f"CONTEXT FROM PREVIOUS SESSIONS:\n{injection}\n\n"
            f"Consider the above when implementing your changes.\n\n"
            f"{prompt}"
        )

    def list_sessions(self) -> list[tuple[str, str, str, float]]:
        """List all sessions: (session_id, intent_preview, status, timestamp)."""
        sessions: list[tuple[str, str, str, float]] = []
        if not self._sessions_dir.exists():
            return sessions

        for filepath in sorted(self._sessions_dir.glob("sess_*.json")):
            try:
                data = json.loads(filepath.read_text())
                ctx = SessionContext.from_dict(data)
                intent_preview = ctx.user_intent[:60]
                if len(ctx.user_intent) > 60:
                    intent_preview += "..."
                sessions.append(
                    (ctx.session_id, intent_preview, ctx.status, ctx.timestamp)
                )
            except Exception:
                pass

        return sessions

    def clear(self) -> int:
        """Delete all session files. Returns count deleted."""
        if not self._sessions_dir.exists():
            return 0
        count = 0
        for filepath in self._sessions_dir.glob("sess_*.json"):
            filepath.unlink()
            count += 1
        return count
