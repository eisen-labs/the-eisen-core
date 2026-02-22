"""Shared zone configuration for multi-agent orchestration.

Shared zones are file patterns that ALL agents can access regardless of
their assigned region. Common examples: package.json, tsconfig.json,
Cargo.toml, type definitions, etc.

Zone enforcement is done by eisen-core (Rust proxy). This module provides
the Python-side configuration that gets passed as --zone flags when
spawning agents.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# Default shared zones -- accessible by all agents regardless of region.
# These cover the most common project-level config files and shared dirs.
DEFAULT_SHARED_ZONES: list[str] = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.*.json",
    "Cargo.toml",
    "Cargo.lock",
    "*.config.js",
    "*.config.ts",
    "*.config.mjs",
    "*.config.cjs",
    ".env.example",
    "types/**",
    "shared/**",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    ".gitignore",
]


@dataclass
class SharedZoneConfig:
    """Configuration for shared zones accessible by all agents.

    Combines default patterns with user-provided overrides from:
    - CLI flags (--shared-zone)
    - Config file (.eisen/config.json)
    """

    custom_patterns: list[str] = field(default_factory=list)
    use_defaults: bool = True

    def get_all_patterns(self) -> list[str]:
        """Return all shared zone patterns (defaults + custom)."""
        patterns: list[str] = []
        if self.use_defaults:
            patterns.extend(DEFAULT_SHARED_ZONES)
        patterns.extend(self.custom_patterns)
        return patterns

    @classmethod
    def from_workspace(cls, workspace: str) -> "SharedZoneConfig":
        """Load shared zone config from workspace .eisen/config.json if it exists.

        The config file can contain:
        {
            "shared_zones": ["custom/**", "lib/**"],
            "use_default_shared_zones": true
        }
        """
        config_path = os.path.join(workspace, ".eisen", "config.json")
        if not os.path.isfile(config_path):
            return cls()

        try:
            with open(config_path) as f:
                data = json.load(f)

            custom = data.get("shared_zones", [])
            use_defaults = data.get("use_default_shared_zones", True)

            if not isinstance(custom, list):
                logger.warning(f"shared_zones in {config_path} is not a list, ignoring")
                custom = []

            logger.info(
                f"Loaded shared zone config from {config_path}: "
                f"{len(custom)} custom patterns, defaults={'on' if use_defaults else 'off'}"
            )
            return cls(custom_patterns=custom, use_defaults=use_defaults)

        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"Failed to load {config_path}: {e}")
            return cls()
