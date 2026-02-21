"""Tests for cross-session context handoff (Phase 4C)."""

import json
import time
from pathlib import Path

import pytest

from eisen_agent.session_memory import SessionContext, SessionMemory, _text_similarity


@pytest.fixture
def tmp_memory(tmp_path):
    """Create a SessionMemory with a temp directory."""
    return SessionMemory(sessions_dir=tmp_path / "sessions")


def _make_context(
    session_id: str = "abc",
    intent: str = "implement auth",
    workspace: str = "/project",
    status: str = "completed",
) -> SessionContext:
    return SessionContext(
        session_id=session_id,
        timestamp=time.time(),
        user_intent=intent,
        workspace=workspace,
        modified_files={"/ui": ["login.ts", "register.ts"]},
        key_decisions=["Used JWT for auth tokens"],
        resolved_symbols=["AuthValidator"],
        status=status,
    )


def test_save_and_load(tmp_memory):
    ctx = _make_context()
    tmp_memory.save_session(ctx)

    loaded = tmp_memory.load_session("abc")
    assert loaded is not None
    assert loaded.session_id == "abc"
    assert loaded.user_intent == "implement auth"
    assert loaded.modified_files == {"/ui": ["login.ts", "register.ts"]}


def test_load_nonexistent(tmp_memory):
    assert tmp_memory.load_session("nonexistent") is None


def test_load_relevant_context(tmp_memory):
    # Save two sessions with overlapping words
    tmp_memory.save_session(_make_context("s1", "implement auth login feature"))
    tmp_memory.save_session(_make_context("s2", "add search feature"))

    # Query for something related to auth -- uses word overlap
    results = tmp_memory.load_relevant_context(
        "update auth login page", "/project", min_similarity=0.1
    )
    assert len(results) >= 1
    assert results[0].session_id == "s1"  # auth+login overlap is higher


def test_load_relevant_context_same_workspace_only(tmp_memory):
    tmp_memory.save_session(_make_context("s1", "auth", workspace="/project-a"))
    tmp_memory.save_session(_make_context("s2", "auth", workspace="/project-b"))

    results = tmp_memory.load_relevant_context("auth feature", "/project-a")
    assert len(results) == 1
    assert results[0].session_id == "s1"


def test_load_relevant_context_empty(tmp_memory):
    results = tmp_memory.load_relevant_context("anything", "/project")
    assert results == []


def test_inject_into_prompt_empty(tmp_memory):
    prompt = "Do the thing"
    result = tmp_memory.inject_into_prompt([], prompt)
    assert result == prompt


def test_inject_into_prompt(tmp_memory):
    ctx = _make_context()
    prompt = "Implement the login page"
    result = tmp_memory.inject_into_prompt([ctx], prompt)

    assert "CONTEXT FROM PREVIOUS SESSIONS" in result
    assert "implement auth" in result
    assert "login.ts" in result
    assert "JWT" in result
    assert "Implement the login page" in result


def test_inject_into_prompt_multiple_contexts(tmp_memory):
    ctx1 = _make_context("s1", "implement auth")
    ctx2 = _make_context("s2", "add database models")
    prompt = "Update the system"
    result = tmp_memory.inject_into_prompt([ctx1, ctx2], prompt)

    assert "implement auth" in result
    assert "add database models" in result


def test_list_sessions(tmp_memory):
    tmp_memory.save_session(_make_context("s1", "task one"))
    tmp_memory.save_session(_make_context("s2", "task two"))

    sessions = tmp_memory.list_sessions()
    assert len(sessions) == 2
    ids = {s[0] for s in sessions}
    assert ids == {"s1", "s2"}


def test_clear(tmp_memory):
    tmp_memory.save_session(_make_context("s1"))
    tmp_memory.save_session(_make_context("s2"))
    assert len(tmp_memory.list_sessions()) == 2

    deleted = tmp_memory.clear()
    assert deleted == 2
    assert len(tmp_memory.list_sessions()) == 0


# Text similarity tests


def test_text_similarity_identical():
    assert _text_similarity("hello world", "hello world") == 1.0


def test_text_similarity_no_overlap():
    assert _text_similarity("hello world", "foo bar") == 0.0


def test_text_similarity_partial():
    sim = _text_similarity("implement auth feature", "update auth login")
    assert 0.0 < sim < 1.0
    assert sim > 0.1  # "auth" overlaps


def test_text_similarity_empty():
    assert _text_similarity("", "hello") == 0.0
    assert _text_similarity("hello", "") == 0.0
    assert _text_similarity("", "") == 0.0


def test_session_context_roundtrip():
    ctx = _make_context()
    d = ctx.to_dict()
    restored = SessionContext.from_dict(d)
    assert restored.session_id == ctx.session_id
    assert restored.modified_files == ctx.modified_files
    assert restored.key_decisions == ctx.key_decisions
