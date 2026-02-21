"""Verify that the PyO3 bridge is callable from Python."""

import json

import eisen_bridge


def test_parse_workspace():
    result = eisen_bridge.parse_workspace(".")
    data = json.loads(result)
    assert isinstance(data, (dict, list))


def test_snapshot():
    result = eisen_bridge.snapshot(".")
    data = json.loads(result)
    assert "nodes" in data
    assert "seq" in data


def test_lookup_symbol_returns_json():
    result = eisen_bridge.lookup_symbol(".", "nonexistent_symbol_xyz")
    data = json.loads(result)
    assert isinstance(data, list)
    assert len(data) == 0
