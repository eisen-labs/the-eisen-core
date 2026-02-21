"""Tests for shared zone configuration (Phase 3C)."""

import json
import os
import tempfile

from eisen_agent.zones import DEFAULT_SHARED_ZONES, SharedZoneConfig


def test_default_shared_zones_exist():
    """Default list should contain common config files."""
    assert "package.json" in DEFAULT_SHARED_ZONES
    assert "tsconfig.json" in DEFAULT_SHARED_ZONES
    assert "Cargo.toml" in DEFAULT_SHARED_ZONES
    assert "types/**" in DEFAULT_SHARED_ZONES
    assert "shared/**" in DEFAULT_SHARED_ZONES


def test_shared_zone_config_defaults():
    config = SharedZoneConfig()
    patterns = config.get_all_patterns()
    assert len(patterns) == len(DEFAULT_SHARED_ZONES)
    assert "package.json" in patterns


def test_shared_zone_config_custom():
    config = SharedZoneConfig(custom_patterns=["lib/**", "common/**"])
    patterns = config.get_all_patterns()
    # Should include defaults + custom
    assert "package.json" in patterns
    assert "lib/**" in patterns
    assert "common/**" in patterns
    assert len(patterns) == len(DEFAULT_SHARED_ZONES) + 2


def test_shared_zone_config_no_defaults():
    config = SharedZoneConfig(custom_patterns=["custom/**"], use_defaults=False)
    patterns = config.get_all_patterns()
    assert patterns == ["custom/**"]
    assert "package.json" not in patterns


def test_from_workspace_no_config():
    """Should return defaults when no .eisen/config.json exists."""
    with tempfile.TemporaryDirectory() as tmpdir:
        config = SharedZoneConfig.from_workspace(tmpdir)
        assert config.use_defaults is True
        assert config.custom_patterns == []


def test_from_workspace_with_config():
    """Should load custom patterns from .eisen/config.json."""
    with tempfile.TemporaryDirectory() as tmpdir:
        eisen_dir = os.path.join(tmpdir, ".eisen")
        os.makedirs(eisen_dir)
        config_path = os.path.join(eisen_dir, "config.json")
        with open(config_path, "w") as f:
            json.dump(
                {
                    "shared_zones": ["lib/**", "vendor/**"],
                    "use_default_shared_zones": True,
                },
                f,
            )

        config = SharedZoneConfig.from_workspace(tmpdir)
        assert config.custom_patterns == ["lib/**", "vendor/**"]
        assert config.use_defaults is True
        patterns = config.get_all_patterns()
        assert "lib/**" in patterns
        assert "package.json" in patterns


def test_from_workspace_disable_defaults():
    """Should allow disabling default zones."""
    with tempfile.TemporaryDirectory() as tmpdir:
        eisen_dir = os.path.join(tmpdir, ".eisen")
        os.makedirs(eisen_dir)
        config_path = os.path.join(eisen_dir, "config.json")
        with open(config_path, "w") as f:
            json.dump(
                {
                    "shared_zones": ["only-this/**"],
                    "use_default_shared_zones": False,
                },
                f,
            )

        config = SharedZoneConfig.from_workspace(tmpdir)
        assert config.use_defaults is False
        patterns = config.get_all_patterns()
        assert patterns == ["only-this/**"]


def test_from_workspace_malformed_json():
    """Should return defaults on malformed JSON."""
    with tempfile.TemporaryDirectory() as tmpdir:
        eisen_dir = os.path.join(tmpdir, ".eisen")
        os.makedirs(eisen_dir)
        config_path = os.path.join(eisen_dir, "config.json")
        with open(config_path, "w") as f:
            f.write("not json{")

        config = SharedZoneConfig.from_workspace(tmpdir)
        assert config.use_defaults is True
        assert config.custom_patterns == []
