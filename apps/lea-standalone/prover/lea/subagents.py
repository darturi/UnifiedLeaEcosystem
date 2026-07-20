"""Subagents — `spawn_subagent` + child activations (v2.3 item 18).

A parent (coordinator) tool call starts a **child activation**: a fresh, stateless
`run_events` with its own message list, its own working directory, and a fresh
context. The child explores in isolation and returns a *distilled result* — a
candidate file + its `lean_check` verdict + a short summary — which the parent
collates. The child never writes the canonical proof file (D76): its `working_dir`
IS an ignored per-run candidate dir, so F3's write sandbox physically confines it
there.

**Two independent recursion guards** (belt and suspenders — a bug in one is not a
fork bomb):

  1. *Depth walk.* Each activation runs at a `runctx` depth; a top-level run is 0, a
     child is parent+1. `spawn_subagent` refuses at ``depth >= max_depth`` (default
     **1**), so a child (depth 1) can never spawn.
  2. *Toolset exclusion.* `spawn_subagent` is registered ``opt_in=True``, so it is
     absent from any ``tools=None`` toolset — and a child is built with ``tools=None``.
     A child cannot even *see* the tool.

Either guard alone suffices. The full typed result envelope + transcript storage is
item 22; item 18 returns a compact human/LLM-readable block.
"""

from __future__ import annotations

import dataclasses
import uuid
from pathlib import Path

from .events import CheckResult, Finished
from .registry import tool
from .runctx import (
    current_config,
    current_depth,
    current_run_key,
    current_working_dir,
)

# Default nesting cap: one level of children. A depth-0 coordinator may spawn; a
# depth-1 subagent may not. Kept here (not a config knob yet) so item 18 pins the
# safe default; a future item can thread it through config with a design pass.
DEFAULT_MAX_DEPTH = 1

# A runaway guard on a child that never converges — NOT accounting. A child with no
# turn budget of its own (parent unlimited) still can't loop forever.
DEFAULT_CHILD_MAX_TURNS = 15

_SPAWN_SCHEMA = {
    "description": (
        "Delegate a self-contained subtask to a fresh subagent that works in an "
        "isolated scratch directory and returns a distilled result (a candidate "
        "file, its lean_check verdict, and a short summary). Use this to explore a "
        "proof strategy, search Mathlib, or try a candidate WITHOUT polluting your "
        "own context with the dead ends. The subagent cannot write your canonical "
        "proof file and cannot spawn further subagents — you collate its result and "
        "commit the final artifact yourself."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "description": {
                "type": "string",
                "description": "A short (3-5 word) description of the subtask.",
            },
            "prompt": {
                "type": "string",
                "description": (
                    "The full task for the subagent, self-contained: it starts with a "
                    "fresh context and sees only this prompt, not your conversation."
                ),
            },
            "subagent_type": {
                "type": "string",
                "description": (
                    "Optional role hint. Declarative role profiles arrive in a later "
                    "step; for now every subagent runs the same scoped generalist "
                    "toolset (read/search/write-in-scratch/lean_check)."
                ),
            },
        },
        "required": ["description", "prompt"],
    },
}


def _bounded_child_turns(parent_max_turns: int | None) -> int:
    """A child's turn cap: the parent's, but never unbounded and never above the
    runaway ceiling."""
    if parent_max_turns is None:
        return DEFAULT_CHILD_MAX_TURNS
    return max(1, min(parent_max_turns, DEFAULT_CHILD_MAX_TURNS))


def _candidate_dir_for(base_working_dir: str | None, run_key: str, agent_id: str) -> Path:
    """The isolated scratch tree the child writes to: ``<wd>/.lea/tmp/<run>/<agent>``.
    Rooted under the parent's working dir when there is one (so the parent can read
    the candidate back to collate); otherwise a process-temp fallback."""
    import tempfile

    base = Path(base_working_dir) if base_working_dir else Path(tempfile.gettempdir())
    return base / ".lea" / "tmp" / run_key / agent_id


def _relativize(path: str, base: str | None) -> str:
    """A candidate path shown relative to the parent's working dir when it sits
    inside it, else the absolute path (so the parent can still `read_file` it)."""
    if not base:
        return path
    try:
        return str(Path(path).resolve().relative_to(Path(base).resolve()))
    except ValueError:
        return path


def _run_child(child_config, child_messages, *, working_dir: str, run_key: str, depth: int):
    """Drive a child `run_events` to completion, absorbing its live events (item 18
    keeps the child's steps out of the parent's context — the whole point of a
    throwaway subagent). Returns ``(last_check, finished)``: the final `CheckResult`
    seen (or None) and the terminal `Finished` (or None if the child errored out)."""
    # Lazy import breaks the tools -> subagents -> agent import cycle: agent.py imports
    # tools (which imports this module), so this module cannot import agent at load.
    from .agent import run_events

    last_check: CheckResult | None = None
    finished: Finished | None = None
    for ev in run_events(
        child_config,
        child_messages,
        session_id=run_key,
        working_dir=working_dir,
        depth=depth,
        # A child is autonomous: no human approval gate, no external stop hook.
        should_stop=None,
        gate=None,
    ):
        if isinstance(ev, CheckResult):
            last_check = ev
        elif isinstance(ev, Finished):
            finished = ev
    return last_check, finished


def _render_result(
    subagent_type: str,
    depth: int,
    last_check: CheckResult | None,
    finished: Finished | None,
    base_working_dir: str | None,
) -> str:
    """The distilled result the parent reads back. Compact and explicit: the parent
    re-checks any candidate it promotes, so this is evidence, not a verdict of record."""
    reason = finished.reason if finished else "error"
    lines = [f"[subagent:{subagent_type} depth={depth}] finished ({reason})."]

    if last_check is not None:
        rel = _relativize(last_check.path, base_working_dir)
        verdict = last_check.status
        if last_check.status == "error" and last_check.detail:
            verdict = f"error — {last_check.detail}"
        lines.append(f"candidate: {rel}")
        lines.append(f"lean_check: {verdict}")
        lines.append("(read the candidate file to promote it; re-check after you write it.)")
    else:
        lines.append("candidate: (none written / checked)")

    if finished and finished.text:
        lines.append(f"result: {finished.text}")
    return "\n".join(lines)


@tool(name="spawn_subagent", description=_SPAWN_SCHEMA["description"],
      input_schema=_SPAWN_SCHEMA["input_schema"], opt_in=True)
def spawn_subagent(args: dict) -> str:
    description = (args.get("description") or "").strip()
    prompt = (args.get("prompt") or "").strip()
    subagent_type = (args.get("subagent_type") or "generalist").strip() or "generalist"
    if not prompt:
        return "Error: spawn_subagent requires a non-empty 'prompt'."

    depth = current_depth()
    if depth >= DEFAULT_MAX_DEPTH:
        return (
            f"Error: a subagent (depth {depth}) cannot spawn further subagents "
            f"(max depth {DEFAULT_MAX_DEPTH}). Do this subtask directly."
        )

    parent_config = current_config()
    if parent_config is None:
        # spawn_subagent only makes sense inside a live activation (which sets the
        # config in the run context). A bare/mis-wired call gets a clear refusal, not
        # a crash.
        return "Error: spawn_subagent can only run inside an activation."

    parent_wd = current_working_dir()
    run_key = current_run_key() or uuid.uuid4().hex[:12]
    agent_id = f"{subagent_type}-{uuid.uuid4().hex[:8]}"
    candidate_dir = _candidate_dir_for(parent_wd, run_key, agent_id)
    candidate_dir.mkdir(parents=True, exist_ok=True)

    # The child config: same model/provider (inherit), but a scoped generalist
    # toolset (tools=None → all non-opt-in tools, so NO spawn_subagent), no MCP
    # servers (children stay light), and a bounded turn budget. prompt_variant is
    # inherited so the child keeps the shared Lean core + hard rules — item 20
    # refines this into a composed per-role prompt.
    child_config = dataclasses.replace(
        parent_config,
        tools=None,
        mcp_servers={},
        max_turns=_bounded_child_turns(parent_config.max_turns),
    )
    task = f"{description}\n\n{prompt}" if description else prompt
    child_messages = [{"role": "user", "content": task}]

    try:
        last_check, finished = _run_child(
            child_config, child_messages,
            working_dir=str(candidate_dir), run_key=agent_id, depth=depth + 1,
        )
    except Exception as exc:  # noqa: BLE001 — a child failure is a tool result, never a parent crash
        return f"Error: subagent '{subagent_type}' failed: {type(exc).__name__}: {exc}"

    return _render_result(subagent_type, depth + 1, last_check, finished, parent_wd)
