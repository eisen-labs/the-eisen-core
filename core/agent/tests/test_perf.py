"""Tests for performance tuning utilities (Phase 4E)."""

import asyncio
import json
import os
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from eisen_agent.perf import SymbolTreeCache, StartupTimer, parallel_dspy_calls


@pytest.fixture
def tmp_cache(tmp_path):
    """Create a SymbolTreeCache with a temp directory."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    # Create some files
    (workspace / "main.py").write_text("def main(): pass")
    (workspace / "utils.py").write_text("def helper(): pass")
    return SymbolTreeCache(str(workspace), cache_dir=tmp_path / "cache")


def test_cache_invalidate(tmp_cache):
    tmp_cache._tree_json = "cached"
    tmp_cache._mtimes = {"a": 1.0}
    tmp_cache.invalidate()
    assert tmp_cache._tree_json is None
    assert tmp_cache._mtimes == {}


def test_is_stale_no_mtimes(tmp_cache):
    assert tmp_cache._is_stale() is True


def test_is_stale_after_recording(tmp_cache):
    tmp_cache._record_mtimes()
    assert tmp_cache._is_stale() is False


def test_is_stale_after_file_change(tmp_cache):
    tmp_cache._record_mtimes()
    # Modify a file
    workspace = Path(tmp_cache._workspace)
    (workspace / "main.py").write_text("def main(): return 42")
    # Force mtime change (some filesystems have 1s resolution)
    os.utime(str(workspace / "main.py"), (time.time() + 1, time.time() + 1))
    assert tmp_cache._is_stale() is True


def test_disk_cache_roundtrip(tmp_cache):
    tmp_cache._save_disk_cache("test.json", '{"hello": "world"}')
    loaded = tmp_cache._load_disk_cache("test.json")
    assert loaded == '{"hello": "world"}'


def test_disk_cache_missing(tmp_cache):
    assert tmp_cache._load_disk_cache("nonexistent.json") is None


def test_reparse_tree(tmp_cache):
    mock_bridge = MagicMock()
    mock_bridge.parse_workspace.return_value = '{"name": "root"}'
    with patch.dict("sys.modules", {"eisen_bridge": mock_bridge}):
        result = tmp_cache._reparse_tree()
    assert result == '{"name": "root"}'
    assert tmp_cache._tree_json == '{"name": "root"}'
    mock_bridge.parse_workspace.assert_called_once()


def test_get_workspace_tree_uses_cache(tmp_cache):
    mock_bridge = MagicMock()
    mock_bridge.parse_workspace.return_value = '{"name": "root"}'
    with patch.dict("sys.modules", {"eisen_bridge": mock_bridge}):
        # First call: reparse
        result1 = tmp_cache.get_workspace_tree()
        assert mock_bridge.parse_workspace.call_count == 1

        # Second call: should use cache (files unchanged)
        result2 = tmp_cache.get_workspace_tree()
        assert result2 == result1
        # Still 1 call since cache was fresh
        assert mock_bridge.parse_workspace.call_count == 1


# Startup timer tests


def test_startup_timer():
    timer = StartupTimer()
    time.sleep(0.01)
    timer.mark("step1")
    time.sleep(0.01)
    timer.mark("step2")

    summary = timer.summary()
    assert "Startup timing:" in summary
    assert "step1" in summary
    assert "step2" in summary
    assert "Total" in summary


# Parallel DSPy calls tests


async def test_parallel_dspy_calls():
    """Test that parallel_dspy_calls runs multiple calls concurrently."""
    call_count = 0

    def mock_module(**kwargs):
        nonlocal call_count
        call_count += 1
        return {"result": kwargs.get("input", "")}

    calls = [
        (mock_module, {"input": "a"}),
        (mock_module, {"input": "b"}),
        (mock_module, {"input": "c"}),
    ]

    results = await parallel_dspy_calls(calls)
    assert len(results) == 3
    assert call_count == 3


async def test_parallel_dspy_calls_empty():
    results = await parallel_dspy_calls([])
    assert results == []


async def test_parallel_dspy_calls_handles_exceptions():
    def fail_module(**kwargs):
        raise ValueError("test error")

    def ok_module(**kwargs):
        return "ok"

    calls = [(fail_module, {}), (ok_module, {})]
    results = await parallel_dspy_calls(calls)
    assert len(results) == 2
    assert isinstance(results[0], ValueError)
    assert results[1] == "ok"
