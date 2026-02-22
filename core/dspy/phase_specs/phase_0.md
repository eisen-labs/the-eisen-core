# Phase 0: Foundation (PyO3 Bridge + Project Scaffolding)

## Status: Complete

## Goal

Establish the cross-language infrastructure so Rust code (parser, types) is callable from Python, and the Python project builds cleanly with maturin. No orchestration logic yet -- just plumbing.

## Context

The eisen-core Rust binary (`core/`) contains a tree-sitter parser that builds `SymbolTree` structures from workspace source code, and a set of wire protocol types (`Snapshot`, `Delta`, `UsageMessage`, etc.). The orchestration agent (Python) needs direct access to the parser for zero-cost cross-region dependency resolution and workspace understanding.

PyO3 + maturin is the bridge: a separate Rust crate (`pybridge/`) wraps `core/`'s library API and compiles to a `.so`/`.dylib` Python extension module.

### Current State

- `core/` is a standalone Rust crate (no workspace `Cargo.toml` at repo root)
- `core/src/lib.rs` exposes all modules as `pub` (parser, types, flatten, etc.)
- No Python code exists anywhere in the repo
- No maturin, PyO3, or Python toolchain is set up

### Architecture After Phase 0

```
eisen-core/
|-- Cargo.toml           <-- NEW: workspace root
|-- core/                 <-- existing, unchanged
|   |-- Cargo.toml
|   |-- src/
|       |-- lib.rs        (pub mod parser, types, flatten, ...)
|       |-- parser/
|       |   |-- tree.rs   (SymbolTree::init_tree)
|       |   |-- types.rs  (NodeData, NodeKind)
|       |-- flatten.rs    (flatten -> UiSnapshot)
|       |-- types.rs      (FileNode, Snapshot, Delta, UsageMessage, UiSnapshot)
|
|-- pybridge/             <-- NEW: PyO3 crate
|   |-- Cargo.toml
|   |-- src/
|       |-- lib.rs        (#[pyfunction] wrappers)
|
|-- agent/                <-- NEW: Python package
|   |-- pyproject.toml    (maturin build, dspy + acp deps)
|   |-- src/
|   |   |-- eisen_agent/
|   |       |-- __init__.py
|   |       |-- cli.py    (entry point stub)
|   |       |-- config.py (effort levels, max agents, approval mode)
|   |-- tests/
|       |-- test_bridge.py
```

Build flow:
```
core/  -----> eisen-core binary (no Python dependency, existing, unchanged)
  |
  +-- lib --> pybridge/ --> eisen_bridge.so (Python extension module)
                                |
                            agent/ imports this
```

---

## Tasks

### 0A. Create Cargo Workspace

- [x] Create `/Cargo.toml` at repo root as a workspace manifest:
  ```toml
  [workspace]
  members = ["core", "pybridge"]
  resolver = "2"
  ```
- [x] Verify `cargo check --workspace` succeeds from repo root
- [x] Verify `cargo build -p eisen-core` still produces the existing binary
- [x] Update `.gitignore` if needed (added Python-specific ignores: `__pycache__/`, `*.pyc`, `*.so`, `.venv/`)

**Notes:**
- The existing `core/Cargo.toml` has `[package]` with `name = "eisen-core"` -- no changes needed there.
- `core/` already has both `lib.rs` and `main.rs`, so it builds as both library and binary. The `pybridge/` crate depends on the library target.
- The existing `core/Cargo.lock` should be moved to the workspace root (Cargo handles this automatically when you first build from the workspace).

### 0B. Create PyO3 Bridge Crate

- [x] Create `pybridge/Cargo.toml`:
  ```toml
  [package]
  name = "eisen-bridge"
  version = "0.1.0"
  edition = "2021"

  [lib]
  name = "eisen_bridge"
  crate-type = ["cdylib"]

  [dependencies]
  pyo3 = { version = "0.22", features = ["extension-module"] }
  eisen-core = { path = "../core" }
  serde_json = "1"
  ```

- [x] Create `pybridge/src/lib.rs` with these PyO3-exposed functions:

  **`parse_workspace(path: &str) -> PyResult<String>`**
  - Calls `SymbolTree::init_tree(Path::new(path))`
  - Serializes the tree to JSON via the existing `serialize` module or manual traversal
  - Returns JSON string (Python side deserializes)

  **`parse_file(path: &str) -> PyResult<String>`**
  - Parses a single file using the language-specific parser
  - Returns symbols (NodeData entries) as JSON array

  **`snapshot(path: &str) -> PyResult<String>`**
  - Calls `SymbolTree::init_tree()` then `flatten::flatten()`
  - Returns `UiSnapshot` as JSON (already implements `Serialize`)

  **`lookup_symbol(workspace_path: &str, symbol_name: &str) -> PyResult<String>`**
  - Builds symbol tree, searches for nodes matching the name
  - Returns matching `NodeData` entries as JSON array
  - This is the zero-cost A2A oracle: Python asks for a type signature, Rust answers from tree-sitter, no LLM tokens burned

- [x] Verify `cargo build -p eisen-bridge` compiles (produces `.so`/`.dylib`)

**Design decisions:**
- **JSON as FFI boundary**: The alternative is `#[pyclass]` on every Rust struct, which requires modifying `core/`. Since all types already implement `Serialize`, JSON strings across the boundary is simpler and keeps `core/` untouched. Performance is fine -- these are one-shot calls, not hot paths.
- **Separate crate, not added to core/**: Adding PyO3 to `core/` would make the binary depend on Python at link time, breaking the standalone `.vsix` distribution. A separate `pybridge/` crate keeps the binary clean.

### 0C. Create Python Package

- [x] Create `agent/pyproject.toml`:
  ```toml
  [build-system]
  requires = ["maturin>=1.0,<2.0"]
  build-backend = "maturin"

  [project]
  name = "eisen-agent"
  version = "0.1.0"
  requires-python = ">=3.11"
  dependencies = [
      "dspy>=2.5",
      "agent-client-protocol>=0.8",
  ]

  [project.optional-dependencies]
  dev = [
      "pytest>=8.0",
      "pytest-asyncio>=0.23",
  ]

  [tool.maturin]
  manifest-path = "../pybridge/Cargo.toml"
  python-source = "src"
  ```

- [x] Create `agent/src/eisen_agent/__init__.py`:
  ```python
  """Eisen orchestration agent -- DSPy-powered multi-agent coordinator."""
  __version__ = "0.1.0"
  ```

- [x] Create `agent/src/eisen_agent/cli.py` (entry point stub):
  ```python
  """CLI entry point for the eisen orchestration agent."""
  import argparse
  import sys


  def main() -> None:
      parser = argparse.ArgumentParser(description="Eisen orchestration agent")
      parser.add_argument("--workspace", default=".", help="Workspace root path")
      parser.add_argument("--effort", choices=["low", "medium", "high"], default="medium")
      parser.add_argument("--auto-approve", action="store_true", help="Skip approval prompts")
      args = parser.parse_args()
      print(f"eisen-agent v{__version__} (workspace: {args.workspace})")
      # Phase 1 will implement the orchestration loop here


  if __name__ == "__main__":
      main()
  ```

- [x] Create `agent/src/eisen_agent/config.py`:
  ```python
  """Configuration for the orchestration agent."""
  from dataclasses import dataclass
  from enum import Enum


  class EffortLevel(Enum):
      LOW = "low"
      MEDIUM = "medium"
      HIGH = "high"


  MAX_AGENTS = 5


  @dataclass
  class AgentConfig:
      id: str
      name: str
      command: str
      args: list[str]


  # Mirror of extension/src/acp/agents.ts
  AGENTS: list[AgentConfig] = [
      AgentConfig("opencode", "OpenCode", "opencode", ["acp"]),
      AgentConfig("claude-code", "Claude Code", "npx", ["@zed-industries/claude-code-acp"]),
      AgentConfig("codex", "Codex CLI", "npx", ["@zed-industries/codex-acp"]),
      AgentConfig("gemini", "Gemini CLI", "gemini", ["--experimental-acp"]),
      AgentConfig("goose", "Goose", "goose", ["acp"]),
      AgentConfig("amp", "Amp", "amp", ["acp"]),
      AgentConfig("aider", "Aider", "aider", ["--acp"]),
  ]


  @dataclass
  class OrchestratorConfig:
      workspace: str = "."
      effort: EffortLevel = EffortLevel.MEDIUM
      auto_approve: bool = False
      max_agents: int = MAX_AGENTS
  ```

- [x] Create `agent/tests/__init__.py` (empty)
- [x] Verify the directory structure matches the plan

### 0D. End-to-End Verification

- [x] Install maturin: `pip install maturin` (or `uv tool install maturin`)
- [x] Build: `cd agent && maturin develop` (compiles pybridge, installs into venv)
- [x] Create `agent/tests/test_bridge.py`:
  ```python
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
  ```
- [x] Run: `cd agent && python -m pytest tests/test_bridge.py -v`
- [x] All tests pass

### CI Integration

- [x] Update `.github/workflows/check.yml` to add a Python CI job:
  - Install Python 3.13, maturin, pytest
  - `cd agent && maturin develop && pytest`
- [x] Update existing Rust CI from `cargo check` (in core/) to `cargo check --workspace` (from repo root)
- [x] Biome already scoped to `ui/src/**` and `extension/src/**` via `includes` -- no changes needed

---

## Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| FFI boundary format | JSON strings | All Rust types already impl Serialize; avoids modifying core/ with #[pyclass]; one-shot calls not perf-sensitive |
| Separate crate vs modifying core/ | Separate `pybridge/` | Keeps binary free of Python link dep; .vsix distribution unchanged |
| Python version | >=3.11 | DSPy 2.5 requires 3.10+; 3.11 for modern typing features |
| Build tool | maturin | Standard PyO3 build tool; handles Rust compilation + Python packaging |
| Package name | `eisen-agent` (Python), `eisen-bridge` (Rust/PyO3) | Clear naming: agent is the orchestrator, bridge is the FFI layer |

---

## Summary

### What was built

- **Cargo workspace** (`/Cargo.toml`): Workspace root with members `core` and `pybridge`. `Cargo.lock` moved from `core/` to root.
- **PyO3 bridge crate** (`pybridge/`): `eisen-bridge` cdylib exposing 4 functions:
  - `parse_workspace(path)` -- nested JSON tree via `SymbolTree::to_nested_json()`
  - `parse_file(path)` -- JSON array of `NodeData` for a single file
  - `snapshot(path)` -- `UiSnapshot` JSON via `flatten()`
  - `lookup_symbol(workspace_path, symbol_name)` -- JSON array of matching `NodeData` entries
- **Python package** (`agent/`): `eisen-agent` mixed Rust/Python package:
  - `agent/src/eisen_agent/` -- Python orchestration package (`__init__.py`, `cli.py`, `config.py`)
  - `agent/src/eisen_bridge/` -- Python stub re-exporting the native `.so` module
  - `agent/tests/test_bridge.py` -- 3 integration tests for the bridge
  - `agent/pyproject.toml` -- maturin build config
- **CI updates** (`.github/workflows/check.yml`):
  - Rust job now uses `cargo fmt --all`, `cargo clippy --workspace`, `cargo test --workspace`
  - New `python` job: installs Python 3.13, maturin, pytest; runs `maturin develop` + `pytest`
- **Gitignore** updated with Python-specific entries (`__pycache__/`, `*.pyc`, `*.so`, `.venv/`)

### Build/test commands

```bash
# Rust workspace (from repo root)
cargo check --workspace
cargo clippy --workspace -- -D warnings
cargo test --workspace
cargo build -p eisen-core    # existing binary

# Python bridge (from repo root)
cd agent && uv venv .venv && source .venv/bin/activate
uv pip install maturin pytest
maturin develop
python -m pytest tests/ -v
```

### Deviations from plan

1. **`pybridge/Cargo.toml` adds `indextree = "4.6"`** as a direct dependency. The bridge's helper functions take `indextree::NodeId` as a parameter type when traversing the tree, requiring the crate to be in scope.
2. **`agent/pyproject.toml` uses `python-packages = ["eisen_agent"]`** instead of bare `python-source = "src"`. Maturin requires a `src/eisen_bridge/` stub directory matching the cdylib name when `python-source` is set. The stub at `agent/src/eisen_bridge/__init__.py` re-exports from the native module.
3. **`#![allow(clippy::useless_conversion)]`** added to `pybridge/src/lib.rs`. PyO3 0.22's proc-macros generate conversion code that triggers this clippy lint on the `#[pyfunction]` return types.

### Known issues / tech debt

- `dspy>=2.5` and `agent-client-protocol>=0.8` are declared as dependencies but not yet used (Phase 1 will consume them).
- `parse_file` builds the parent directory's full tree to extract a single file's symbols. This is correct but could be optimized with a targeted single-file parse path if needed later.
- The bridge re-parses the workspace on every call (stateless). If hot-path performance becomes an issue, a stateful `PyClass`-based approach could cache the `SymbolTree`.

### Key decisions

- All FFI boundary data flows as JSON strings (no `#[pyclass]` on `core/` types).
- `core/` was not modified at all -- the workspace and bridge are additive.
- Python 3.13 used in CI (3.11+ required by pyproject.toml).
