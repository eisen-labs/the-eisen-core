"""Performance tuning utilities (Phase 4E).

Includes symbol tree caching, parallel DSPy execution helpers,
and startup optimization.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

CACHE_DIR = Path.home() / ".eisen" / "cache"


class SymbolTreeCache:
    """Caches the PyO3 parse_workspace() result.

    The full workspace parse is O(N) over all files.  This cache stores
    the result in memory (for the duration of a run) and optionally on
    disk (~/.eisen/cache/symbol_tree.json).  File modification times
    are used to detect staleness.
    """

    def __init__(self, workspace: str, cache_dir: Path | None = None) -> None:
        self._workspace = os.path.abspath(workspace)
        self._cache_dir = cache_dir or CACHE_DIR
        self._cache_dir.mkdir(parents=True, exist_ok=True)

        self._tree_json: str | None = None
        self._snapshot_json: str | None = None
        self._mtimes: dict[str, float] = {}
        self._cache_time: float = 0.0

    def get_workspace_tree(self) -> str:
        """Get the cached workspace tree, reparsing only if stale."""
        if self._tree_json and not self._is_stale():
            logger.debug("Symbol tree cache hit (in-memory)")
            return self._tree_json

        # Check disk cache
        disk_tree = self._load_disk_cache("symbol_tree.json")
        if disk_tree and not self._is_stale():
            self._tree_json = disk_tree
            logger.debug("Symbol tree cache hit (disk)")
            return disk_tree

        # Reparse
        return self._reparse_tree()

    def get_snapshot(self) -> str:
        """Get the cached workspace snapshot, reparsing only if stale."""
        if self._snapshot_json and not self._is_stale():
            return self._snapshot_json

        disk_snapshot = self._load_disk_cache("snapshot.json")
        if disk_snapshot and not self._is_stale():
            self._snapshot_json = disk_snapshot
            return disk_snapshot

        return self._reparse_snapshot()

    def invalidate(self) -> None:
        """Force cache invalidation."""
        self._tree_json = None
        self._snapshot_json = None
        self._mtimes.clear()
        self._cache_time = 0.0
        logger.debug("Symbol tree cache invalidated")

    def _is_stale(self) -> bool:
        """Check if any tracked files have been modified since last parse.

        Uses sampling: checks up to 50 files for modification time changes.
        """
        if not self._mtimes:
            return True

        checked = 0
        for filepath, cached_mtime in self._mtimes.items():
            if checked >= 50:
                break
            try:
                current_mtime = os.path.getmtime(filepath)
                if current_mtime != cached_mtime:
                    logger.debug(f"Cache stale: {filepath} modified")
                    return True
            except OSError:
                pass  # file deleted is a staleness signal but not critical
            checked += 1

        return False

    def _record_mtimes(self) -> None:
        """Record modification times of source files for staleness checking."""
        self._mtimes.clear()
        count = 0
        for dirpath, _dirnames, filenames in os.walk(self._workspace):
            # Skip hidden dirs, node_modules, target, .venv, etc.
            basename = os.path.basename(dirpath)
            if basename.startswith(".") or basename in (
                "node_modules",
                "target",
                ".venv",
                "__pycache__",
            ):
                continue

            for fname in filenames:
                if count >= 500:
                    break
                full = os.path.join(dirpath, fname)
                try:
                    self._mtimes[full] = os.path.getmtime(full)
                    count += 1
                except OSError:
                    pass

        self._cache_time = time.time()

    def _reparse_tree(self) -> str:
        """Reparse workspace and update caches."""
        try:
            import eisen_bridge

            raw = eisen_bridge.parse_workspace(self._workspace)
            self._tree_json = raw
            self._record_mtimes()
            self._save_disk_cache("symbol_tree.json", raw)
            logger.info("Reparsed workspace tree (cache updated)")
            return raw
        except Exception as e:
            logger.warning(f"Failed to parse workspace: {e}")
            return "{}"

    def _reparse_snapshot(self) -> str:
        """Reparse workspace snapshot and update caches."""
        try:
            import eisen_bridge

            raw = eisen_bridge.snapshot(self._workspace)
            self._snapshot_json = raw
            self._record_mtimes()
            self._save_disk_cache("snapshot.json", raw)
            return raw
        except Exception as e:
            logger.warning(f"Failed to get snapshot: {e}")
            return "{}"

    def _save_disk_cache(self, filename: str, content: str) -> None:
        """Save content to disk cache."""
        try:
            filepath = self._cache_dir / filename
            filepath.write_text(content)
        except Exception as e:
            logger.debug(f"Failed to save disk cache {filename}: {e}")

    def _load_disk_cache(self, filename: str) -> str | None:
        """Load content from disk cache."""
        try:
            filepath = self._cache_dir / filename
            if filepath.exists():
                return filepath.read_text()
        except Exception:
            pass
        return None


async def parallel_dspy_calls(
    calls: list[tuple[Any, dict[str, Any]]],
) -> list[Any]:
    """Execute multiple DSPy module calls in parallel.

    Args:
        calls: List of (module, kwargs) tuples.  Each module is called
               with **kwargs in a separate thread (DSPy calls are sync).

    Returns:
        List of results in the same order as inputs.
    """
    loop = asyncio.get_event_loop()

    async def _run_one(module: Any, kwargs: dict[str, Any]) -> Any:
        return await loop.run_in_executor(None, lambda: module(**kwargs))

    tasks = [_run_one(module, kwargs) for module, kwargs in calls]
    return await asyncio.gather(*tasks, return_exceptions=True)


class StartupTimer:
    """Tracks import and initialization times for performance profiling."""

    def __init__(self) -> None:
        self._marks: list[tuple[str, float]] = []
        self._start = time.time()

    def mark(self, label: str) -> None:
        """Record a timing mark."""
        self._marks.append((label, time.time() - self._start))

    def summary(self) -> str:
        """Human-readable startup timing summary."""
        lines = ["Startup timing:"]
        for label, elapsed in self._marks:
            lines.append(f"  {label}: {elapsed:.3f}s")
        lines.append(f"  Total: {time.time() - self._start:.3f}s")
        return "\n".join(lines)
