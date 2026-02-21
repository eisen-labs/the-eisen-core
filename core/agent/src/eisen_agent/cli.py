"""CLI entry point for the eisen orchestration agent."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import shutil
import subprocess
import sys

import dspy

from eisen_agent import __version__
from eisen_agent.config import EffortLevel, OrchestratorConfig

log = logging.getLogger(__name__)

_PROVIDER_LABELS: dict[str, tuple[str, str]] = {
    "ollama": ("local", "Ollama"),
    "ollama_chat": ("local", "Ollama"),
    "anthropic": ("remote API", "Anthropic"),
    "openai": ("remote API", "OpenAI"),
    "google": ("remote API", "Google"),
    "groq": ("remote API", "Groq"),
    "mistral": ("remote API", "Mistral"),
}


def _log_llm_backend(model: str) -> None:
    """Log which LLM provider the agent is targeting."""
    provider = model.split("/")[0] if "/" in model else model
    kind, label = _PROVIDER_LABELS.get(provider, ("remote API", provider.title()))
    log.info("LLM backend: %s (%s \u2014 %s)", model, kind, label)


# Maps provider names to required environment variable(s).
_PROVIDER_API_KEY_VARS: dict[str, list[str]] = {
    "anthropic": ["ANTHROPIC_API_KEY"],
    "openai": ["OPENAI_API_KEY"],
    "google": ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    "groq": ["GROQ_API_KEY"],
    "mistral": ["MISTRAL_API_KEY"],
}


def _validate_llm_backend(model: str) -> str | None:
    """Validate the LLM backend configuration before use.

    Returns None on success, or an error message string on failure.
    """
    if "/" not in model:
        return (
            f"Invalid model format '{model}'. Expected 'provider/model_name'.\n"
            "Examples:\n"
            "  anthropic/claude-sonnet-4-20250514\n"
            "  ollama_chat/llama3.1\n"
            "  openai/gpt-4o"
        )

    provider = model.split("/")[0]
    model_name = model.split("/", 1)[1]

    # --- Ollama (local) ---
    if provider in ("ollama", "ollama_chat"):
        # 1. Check if ollama binary is installed
        if not shutil.which("ollama"):
            return (
                f"Model '{model}' requires Ollama, but 'ollama' was not found on PATH.\n"
                "Install Ollama: https://ollama.com/download\n"
                "Or switch to a remote provider in your .env file."
            )

        # 2. Check if Ollama server is reachable
        try:
            result = subprocess.run(
                ["ollama", "list"],
                capture_output=True,
                text=True,
                timeout=5,
            )
        except subprocess.TimeoutExpired:
            return (
                "Ollama is installed but the server is not responding.\n"
                "Start it with: ollama serve"
            )
        except OSError as exc:
            return f"Failed to run 'ollama list': {exc}"

        if result.returncode != 0:
            stderr = result.stderr.strip()
            if (
                "could not connect" in stderr.lower()
                or "connection refused" in stderr.lower()
            ):
                return (
                    "Ollama is installed but the server is not running.\n"
                    "Start it with: ollama serve"
                )
            return f"'ollama list' failed (exit {result.returncode}): {stderr}"

        # 3. Check if the requested model is pulled
        installed = []
        for line in result.stdout.strip().splitlines()[1:]:  # skip header
            parts = line.split()
            if parts:
                # ollama list shows "model:tag" in first column
                installed.append(parts[0].split(":")[0])

        # Strip tag from requested model too (e.g. "codellama:7b" -> "codellama")
        model_name_base = model_name.split(":")[0]
        if model_name_base not in installed:
            available = ", ".join(installed[:10]) if installed else "(none)"
            return (
                f"Ollama model '{model_name}' is not installed.\n"
                f"Pull it with: ollama pull {model_name}\n"
                f"Installed models: {available}"
            )

        return None  # all good

    # --- Remote API providers ---
    key_vars = _PROVIDER_API_KEY_VARS.get(provider)
    if key_vars:
        has_key = any(os.environ.get(var) for var in key_vars)
        if not has_key:
            vars_str = " or ".join(key_vars)
            return (
                f"Model '{model}' requires an API key but {vars_str} is not set.\n"
                "Set it in your .env file or export it as an environment variable.\n"
                "See .env.example for configuration details."
            )

    return None  # no issues detected


def main() -> None:
    # Load .env file (if present) so devs don't need manual exports
    from dotenv import load_dotenv, find_dotenv

    load_dotenv(find_dotenv(usecwd=True))

    parser = argparse.ArgumentParser(description="Eisen orchestration agent")
    parser.add_argument("--workspace", default=".", help="Workspace root path")
    parser.add_argument(
        "--effort",
        choices=["low", "medium", "high"],
        default="medium",
    )
    parser.add_argument(
        "--auto-approve",
        action="store_true",
        help="Skip approval prompts",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("EISEN_AGENT_MODEL", ""),
        help="LLM model for DSPy (e.g. anthropic/claude-sonnet-4-20250514, ollama_chat/llama3.1)",
    )
    parser.add_argument(
        "--mode",
        choices=["interactive", "extension"],
        default="interactive",
        help="Communication mode: interactive (terminal) or extension (JSON stdin/stdout)",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true", help="Enable debug logging"
    )

    # Phase 4 flags
    parser.add_argument(
        "--compile",
        action="store_true",
        help="Run DSPy prompt compilation from collected traces",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Resume an interrupted orchestration run",
    )
    parser.add_argument(
        "--resume-id",
        default="",
        help="Resume a specific run by ID (skip interactive selection)",
    )
    parser.add_argument(
        "--stats",
        action="store_true",
        help="Show agent performance statistics",
    )
    parser.add_argument(
        "--sessions",
        action="store_true",
        help="List previous orchestration sessions",
    )

    args = parser.parse_args()

    # Configure logging -- always to stderr so stdout is clean for extension mode
    level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    # Handle Phase 4 info commands (no LLM needed)
    if args.stats:
        _show_stats()
        return

    if args.sessions:
        _show_sessions()
        return

    # Handle Phase 4 compilation (needs LLM)
    if args.compile:
        _configure_llm(args)
        _run_compile()
        return

    # Configure DSPy LLM backend for orchestration
    if not args.compile:
        if not args.model:
            msg = (
                "Error: No LLM model configured. "
                "Set --model or EISEN_AGENT_MODEL env var.\n"
                "Examples:\n"
                "  --model anthropic/claude-sonnet-4-20250514\n"
                "  --model ollama_chat/llama3.1\n"
                "  --model openai/gpt-4o"
            )
            _emit_error(msg, args.mode)
            sys.exit(1)

        _log_llm_backend(args.model)
        error = _validate_llm_backend(args.model)
        if error:
            _emit_error(error, args.mode)
            sys.exit(1)
        try:
            lm = dspy.LM(args.model)
            dspy.configure(lm=lm)
        except Exception as exc:
            _emit_error(
                f"Failed to initialize LLM backend '{args.model}': {exc}",
                args.mode,
            )
            sys.exit(1)

    config = OrchestratorConfig(
        workspace=args.workspace,
        effort=EffortLevel(args.effort),
        auto_approve=args.auto_approve,
    )

    # Handle resume mode (Phase 4D)
    if args.resume or args.resume_id:
        _run_resume(config, args)
        return

    if args.mode == "extension":
        _run_extension_mode(config)
    else:
        _run_interactive_mode(config, args)


def _emit_error(msg: str, mode: str = "interactive") -> None:
    """Emit an error message appropriate for the current mode."""
    if mode == "extension":
        import json

        sys.stdout.write(json.dumps({"type": "error", "message": msg}) + "\n")
        sys.stdout.flush()
    else:
        print(msg, file=sys.stderr)


def _configure_llm(args: argparse.Namespace) -> None:
    """Configure DSPy LLM if model is provided."""
    if args.model:
        _log_llm_backend(args.model)
        error = _validate_llm_backend(args.model)
        if error:
            _emit_error(error)
            sys.exit(1)
        try:
            lm = dspy.LM(args.model)
            dspy.configure(lm=lm)
        except Exception as exc:
            _emit_error(f"Failed to initialize LLM backend '{args.model}': {exc}")
            sys.exit(1)


def _run_extension_mode(config: OrchestratorConfig) -> None:
    """Run in extension mode: JSON over stdin/stdout."""
    from eisen_agent.ext_protocol import ExtensionProtocol

    protocol = ExtensionProtocol(config)
    asyncio.run(protocol.run())


def _run_interactive_mode(config: OrchestratorConfig, args: argparse.Namespace) -> None:
    """Run in interactive mode: terminal stdin/stdout."""
    from eisen_agent.orchestrator import Orchestrator

    print(f"eisen-agent v{__version__} (workspace: {args.workspace})")

    # Read user intent from stdin
    print("\nEnter your task (press Enter twice to submit):")
    lines: list[str] = []
    while True:
        try:
            line = input()
        except EOFError:
            break
        if line == "":
            break
        lines.append(line)

    user_intent = "\n".join(lines)
    if not user_intent.strip():
        print("No task provided. Exiting.")
        sys.exit(0)

    # Run orchestration
    orchestrator = Orchestrator(config)
    result = asyncio.run(orchestrator.run(user_intent))

    # Print summary
    orchestrator.print_summary(result)

    # Offer retry if some failed
    if result.status == "done" and orchestrator._lifecycle.can_retry:
        try:
            response = input("\nRetry failed subtask(s)? [y/n]: ").strip().lower()
            if response in ("y", "yes"):
                retry_result = asyncio.run(orchestrator.retry_failed())
                orchestrator.print_summary(retry_result)
                if retry_result.status != "completed":
                    sys.exit(1)
                sys.exit(0)
        except (EOFError, KeyboardInterrupt):
            pass

    # Exit with non-zero if any subtask failed
    if result.status != "completed":
        sys.exit(1)


def _run_compile() -> None:
    """Run DSPy prompt compilation from collected traces (Phase 4A)."""
    from eisen_agent.training.compile import run_compilation
    from eisen_agent.training.collector import TraceCollector

    collector = TraceCollector()
    trace_count = collector.count_traces()
    print(f"Found {trace_count} trace(s) in ~/.eisen/traces/")

    if trace_count == 0:
        print(
            "No traces available. Run some orchestration tasks first to collect traces."
        )
        sys.exit(0)

    print("Running DSPy compilation...")
    results = run_compilation(min_quality=0.5)

    print("\nCompilation results:")
    for module_name, success in results.items():
        status = "OK" if success else "SKIP (insufficient data)"
        print(f"  {module_name}: {status}")

    if any(results.values()):
        print("\nCompiled modules saved to ~/.eisen/compiled/")
        print("They will be loaded automatically on next orchestration run.")
    else:
        print("\nNo modules compiled. Collect more traces and try again.")


def _run_resume(config: OrchestratorConfig, args: argparse.Namespace) -> None:
    """Resume an interrupted orchestration run (Phase 4D)."""
    from eisen_agent.orchestrator import Orchestrator
    from eisen_agent.persistence import RunPersistence

    persistence = RunPersistence()

    if args.resume_id:
        run_state = persistence.load(args.resume_id)
        if not run_state:
            print(f"Run '{args.resume_id}' not found.", file=sys.stderr)
            sys.exit(1)
    else:
        resumable = persistence.list_resumable()
        if not resumable:
            print("No resumable runs found.")
            sys.exit(0)

        print("Resumable runs:")
        for i, run in enumerate(resumable):
            intent = run.user_intent[:60]
            if len(run.user_intent) > 60:
                intent += "..."
            print(f'  [{i + 1}] "{intent}" ({run.state}, {run.progress_summary})')

        try:
            choice = input("\nSelect run to resume (number): ").strip()
            idx = int(choice) - 1
            if idx < 0 or idx >= len(resumable):
                print("Invalid selection.")
                sys.exit(1)
            run_state = resumable[idx]
        except (ValueError, EOFError, KeyboardInterrupt):
            print("Cancelled.")
            sys.exit(0)

    print(f"Resuming run {run_state.run_id}: {run_state.user_intent[:60]}...")
    print(f"  State: {run_state.state}, {run_state.progress_summary}")

    # Update config from saved state
    config = OrchestratorConfig(
        workspace=run_state.workspace,
        effort=EffortLevel(run_state.effort),
        auto_approve=run_state.auto_approve,
        max_agents=run_state.max_agents,
    )

    orchestrator = Orchestrator(config)
    result = asyncio.run(orchestrator.resume_run(run_state))
    orchestrator.print_summary(result)

    if result.status != "completed":
        sys.exit(1)


def _show_stats() -> None:
    """Show agent performance statistics (Phase 4B)."""
    from eisen_agent.training.agent_stats import AgentStats

    stats = AgentStats()
    all_stats = stats.all_stats()

    if not all_stats:
        print("No agent performance data collected yet.")
        print("Run some orchestration tasks to build statistics.")
        return

    print("Agent Performance Statistics:")
    print(
        f"{'Agent':<16} {'Task Type':<12} {'Language':<10} {'Success':>8} {'Samples':>8} {'Avg Tokens':>11}"
    )
    print("-" * 70)

    for perf in sorted(all_stats, key=lambda p: (-p.success_rate, -p.sample_count)):
        print(
            f"{perf.agent_type:<16} {perf.task_type:<12} {perf.language:<10} "
            f"{perf.success_rate:>7.0%} {perf.sample_count:>8} {perf.avg_tokens:>11,}"
        )


def _show_sessions() -> None:
    """List previous orchestration sessions (Phase 4C)."""
    from eisen_agent.session_memory import SessionMemory
    import time as _time

    memory = SessionMemory()
    sessions = memory.list_sessions()

    if not sessions:
        print("No previous sessions found.")
        return

    print("Previous Orchestration Sessions:")
    print(f"{'ID':<10} {'Intent':<50} {'Status':<12} {'When'}")
    print("-" * 85)

    for sid, intent, status, ts in sessions:
        when = _time.strftime("%Y-%m-%d %H:%M", _time.localtime(ts))
        print(f"{sid:<10} {intent:<50} {status:<12} {when}")


if __name__ == "__main__":
    main()
