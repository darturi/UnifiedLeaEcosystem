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

import contextlib
import contextvars
import dataclasses
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from .errors import ToolError
from .events import CheckResult, Finished, SubagentFinished
from .profiles import AgentProfile, available_profiles, load_profile
from .registry import build_toolset, get_tool, tool
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
                    "fresh context and sees only this prompt, not your conversation. "
                    "State the GOAL — the exact lemma/statement to prove or the specific "
                    "thing to find — NOT a file path to write. The subagent writes its "
                    "candidate in its own isolated scratch directory; you collate the "
                    "result and commit the canonical file yourself. Do not tell it where "
                    "to write (any path you give is ignored / redirected into its scratch)."
                ),
            },
            "subagent_type": {
                "type": "string",
                "description": (
                    "Which role to run: one of the defined roles in lea/agents/ "
                    "(e.g. 'premise-search' — read-only Mathlib scout; 'proof-candidate' "
                    "— tries a candidate in a scratch file), or omit for a generalist "
                    "with the full scoped toolset. An unknown role is refused."
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


def _parent_tool_names(parent_config) -> set[str]:
    """The tools the parent activation can actually call — the ceiling a child can
    never exceed (item 21). Resolved through the same ``build_toolset`` the loop uses,
    so it is exactly the parent's real capability set, opt-in tools included when the
    parent explicitly selected them (a coordinator's ``spawn_subagent``)."""
    schemas, _ = build_toolset(parent_config.tools)
    return {s["name"] for s in schemas}


def compose_child_tools(parent_config, declared: list[str] | None) -> list[str]:
    """A child's effective toolset = its declared toolset INTERSECTED with the parent's
    (item 21, D79). Permissions compose by **tightening only**: a child can never call
    a tool the parent lacked, so spawning is not a privilege-escalation path.

    ``declared is None`` (the generalist) means the default toolset; either way every
    opt-in tool (``spawn_subagent``) is stripped, so a child can never spawn — the same
    guarantee as the depth walk, now also at the capability layer. Declared order is
    preserved (``build_toolset`` treats the list as filter+order). An unknown tool name
    is a profile typo and raises; a *known* tool the parent lacks is silently tightened
    away — that is the D79 contract, not an error.
    """
    parent_allowed = _parent_tool_names(parent_config)
    wanted = [s["name"] for s in build_toolset(None)[0]] if declared is None else list(declared)
    effective: list[str] = []
    for name in wanted:
        t = get_tool(name)
        if t is None:
            raise ToolError(f"agent profile names unknown tool {name!r}")
        if t.opt_in:
            continue  # opt-in (spawn_subagent) is never granted to a child
        if name in parent_allowed:  # else: parent lacked it → tightened away (D79)
            effective.append(name)
    return effective


def _child_config(parent_config, profile: AgentProfile | None):
    """Build the child's :class:`LeaConfig` from the parent + an optional role profile.
    A profile supplies model / scoped tools / turn cap / prompt head (item 19); each
    ``None`` field inherits the parent's. The toolset is always composed against the
    parent's (item 21) so a child ⊆ parent — no profile → the generalist default,
    tightened to the parent. MCP is dropped (children stay light) and turns bounded."""
    if profile is None:
        return dataclasses.replace(
            parent_config,
            tools=compose_child_tools(parent_config, None),
            mcp_servers={},
            max_turns=_bounded_child_turns(parent_config.max_turns),
            system_prompt_head=None,
        )
    # An explicit profile cap is honored as declared; only an inherited/unlimited cap
    # is clamped to the runaway ceiling.
    max_turns = profile.max_turns if profile.max_turns is not None \
        else _bounded_child_turns(parent_config.max_turns)
    return dataclasses.replace(
        parent_config,
        model=profile.model or parent_config.model,
        tools=compose_child_tools(parent_config, profile.tools),
        mcp_servers={},
        max_turns=max_turns,
        system_prompt_head=profile.system_prompt,
    )


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


@dataclass(frozen=True)
class SubagentResult:
    """The TYPED result of one child run (item 22). `render()` is the prose the parent
    model reads in its tool_result; `to_event()` is the structured `SubagentFinished`
    the adapter persists. The `transcript` is the child's full message list — kept here
    so it can be stored SEPARATELY (never as a code_step), and `result_id` is the audit
    handle that links a promoted candidate back to the run that produced it."""

    result_id: str
    subagent_type: str
    depth: int
    candidate_path: str | None      # relative to the parent's working dir when possible
    check_status: str | None        # 'ok' | 'error' | None (nothing checked)
    check_detail: str | None
    stop_reason: str                # child's Finished.reason, or 'error'
    summary: str                    # child's final text
    transcript: list = field(default_factory=list, repr=False)

    def render(self) -> str:
        """Compact, explicit prose for the parent — evidence, not a verdict of record;
        the parent re-checks any candidate it promotes."""
        lines = [f"[subagent:{self.subagent_type} depth={self.depth} id={self.result_id}] "
                 f"finished ({self.stop_reason})."]
        if self.check_status is not None:
            verdict = self.check_status
            if self.check_status == "error" and self.check_detail:
                verdict = f"error — {self.check_detail}"
            lines.append(f"candidate: {self.candidate_path}")
            lines.append(f"lean_check: {verdict}")
            lines.append("(read the candidate file to promote it; re-check after you write it.)")
        else:
            lines.append("candidate: (none written / checked)")
        if self.summary:
            lines.append(f"result: {self.summary}")
        return "\n".join(lines)

    def to_event(self) -> SubagentFinished:
        return SubagentFinished(
            result_id=self.result_id,
            subagent_type=self.subagent_type,
            candidate_path=self.candidate_path,
            check_status=self.check_status,
            check_detail=self.check_detail,
            stop_reason=self.stop_reason,
            summary=self.summary,
            transcript=self.transcript,
        )


def _build_result(
    result_id: str,
    subagent_type: str,
    depth: int,
    last_check: CheckResult | None,
    finished: Finished | None,
    base_working_dir: str | None,
) -> SubagentResult:
    """Distill a child run into the typed envelope."""
    return SubagentResult(
        result_id=result_id,
        subagent_type=subagent_type,
        depth=depth,
        candidate_path=_relativize(last_check.path, base_working_dir) if last_check else None,
        check_status=last_check.status if last_check else None,
        check_detail=last_check.detail if last_check else None,
        stop_reason=finished.reason if finished else "error",
        summary=finished.text if finished else "",
        transcript=list(finished.transcript.get("messages", [])) if finished else [],
    )


# --- per-activation result collector -------------------------------------------
# spawn_subagent records each child's typed result here; the agent loop drains it
# right after the tool call and yields a SubagentFinished event (mirroring how a
# lean_check call yields CheckResult). Scoped per activation so results can't leak
# across runs; a child activation opens its own (empty) scope, so recording after
# _run_child returns lands in the PARENT's collector, where the parent loop drains it.
_results: contextvars.ContextVar[list | None] = contextvars.ContextVar(
    "lea_subagent_results", default=None
)


def begin_results_scope():
    """Open a fresh collector for this activation; returns a reset token."""
    return _results.set([])


def end_results_scope(token) -> None:
    with contextlib.suppress(ValueError):
        _results.reset(token)


def _record_result(result: SubagentResult) -> None:
    collector = _results.get()
    if collector is not None:
        collector.append(result)


def drain_results() -> list[SubagentResult]:
    """Return and clear the results recorded since the last drain (the parent loop
    calls this right after a spawn_subagent tool call)."""
    collector = _results.get()
    if not collector:
        return []
    out = list(collector)
    collector.clear()
    return out


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

    # Resolve the role (item 19): 'generalist' (the default) keeps item 18's built-in
    # behavior; any other type must name a profile in lea/agents/ or is refused —
    # never silently downgraded to a full-toolset generalist.
    profile: AgentProfile | None = None
    if subagent_type != "generalist":
        try:
            profile = load_profile(subagent_type)
        except ToolError as exc:
            return f"Error: {exc}"

    parent_wd = current_working_dir()
    run_key = current_run_key() or uuid.uuid4().hex[:12]
    agent_id = f"{subagent_type}-{uuid.uuid4().hex[:8]}"
    candidate_dir = _candidate_dir_for(parent_wd, run_key, agent_id)
    candidate_dir.mkdir(parents=True, exist_ok=True)

    child_config = _child_config(parent_config, profile)
    task = f"{description}\n\n{prompt}" if description else prompt
    child_messages = [{"role": "user", "content": task}]

    try:
        last_check, finished = _run_child(
            child_config, child_messages,
            working_dir=str(candidate_dir), run_key=agent_id, depth=depth + 1,
        )
    except Exception as exc:  # noqa: BLE001 — a child failure is a tool result, never a parent crash
        return f"Error: subagent '{subagent_type}' failed: {type(exc).__name__}: {exc}"

    # `agent_id` is the result id: unique per spawn, and the audit handle a promoted
    # candidate links back to. Record the typed result (with the child transcript) for
    # the parent loop to drain into a SubagentFinished event; return the prose render
    # as the tool_result the model reads.
    result = _build_result(agent_id, subagent_type, depth + 1, last_check, finished, parent_wd)
    _record_result(result)
    return result.render()
