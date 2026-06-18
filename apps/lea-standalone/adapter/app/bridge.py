"""The prover seam — drives the vendored prover in-process and maps its typed
events onto the browser's SSE stream (architecture D1/D17).

This replaces the old ``runner.py``: there is no HTTP boundary and no loosely-typed
frame normalization. ``run_events()`` (imported as a library) yields *typed*
meaning-level events, so this is a flat ``isinstance`` dispatch:

  AssistantTextDelta -> assistant_delta      (narration, buffered)
  TurnStarted        -> flush narration into a `message`, mark the turn
  ToolCalled         -> flush narration, emit a status chip
  FileChanged        -> commit to the session's git repo + insert a code_step
  CheckResult        -> back-fill that step's verdict
  UsageUpdated       -> accumulate per-turn token/cost rows
  Finished           -> terminal message + persist run + usage, then `done`

Git owns proof content (D7/D8): on every write the adapter commits the session
repo and the code_step row stores only the SHA + path; the streamed payload
carries the snapshot for the live canvas. The verdict lives in the DB, not the
commit message (D6), and is back-filled when ``lean_check`` returns.

Scope (D1·bridge): single activation — ``messages = [{user: task}]``. Faithful
multi-turn transcript replay is D1·multiturn; the per-tool gate is D9/D10;
interrupt is D7; diff-on-divergence context is D6.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, replace
from pathlib import Path
from queue import Queue
from threading import Event, Lock
from typing import Any

from uuid import uuid4

from lea.interface import (
    AssistantTextDelta,
    CheckResult,
    Error,
    FileChanged,
    Finished,
    ToolApprovalRequested,
    ToolCalled,
    ToolResulted,
    TurnStarted,
    UsageUpdated,
    run_events,
)

from .config import LeaConfig
from .gitstore import GitStore, GitStoreError
from . import store

logger = logging.getLogger("lea-interface.bridge")

# Only one Lea activation may run at a time — they share the on-disk workspace
# and the warm LSP daemon. A second concurrent run is rejected, not queued.
active_run_lock = Lock()

# The run_id currently being driven (holding `active_run_lock`), or None. Lets the
# SSE endpoint tell "start + drive this run" apart from "a second viewer attaching
# to a run already in flight" (e.g. the lea-standalone UI opening an Overleaf run
# the companion is driving). Without this, every extra connection spawned another
# runner that lost the lock and emitted run_error+done(failed), which the UI's
# reconcile→reattach cycle turned into a request storm. Guarded by its own lock so
# reads from the async endpoint never tear against the run thread's write.
_active_run_guard = Lock()
_active_run_id: str | None = None


def current_active_run_id() -> str | None:
    """The run_id currently being driven, or None. Used by the SSE endpoint to
    route a second connection for the same run to a passive (read-only) view
    instead of spawning a competing runner."""
    with _active_run_guard:
        return _active_run_id


def _set_active_run_id(run_id: str | None) -> None:
    global _active_run_id
    with _active_run_guard:
        _active_run_id = run_id

# Per-run cooperative stop flags (D18). The run registers its Event when it starts
# and the interrupt endpoint sets it; the agent checks it at each turn boundary and
# stops cleanly. `setdefault` everywhere makes the order race-free — whoever touches
# a run_id first creates the shared Event.
_stop_events: dict[str, Event] = {}


def request_stop(run_id: str) -> None:
    """Flag a run for a clean cooperative stop (the interrupt endpoint calls this)."""
    _stop_events.setdefault(run_id, Event()).set()


# --- Per-tool approval gate (D19) ------------------------------------------
# Impactful tools prompt the human for allow/deny/always-session before running;
# read-only tools + lean_check are auto-allowed (never gated). "Always allow this
# session" adds the tool to a per-session in-memory allowlist (persists across
# runs in a session, resets on process restart). The prover owns the yield/.send
# hook (A8); the adapter owns the policy + the human relay.
GATED_TOOLS = {"bash", "write_file", "edit_file"}
_APPROVAL_DECISIONS = {"allow", "deny", "always_session"}

_session_allowlists: dict[str, set[str]] = {}
# One in-flight approval per active run (one run at a time): run_id -> the pending
# decision rendezvous between the run thread (waiting) and the endpoint (resolving).
_pending_approvals: dict[str, dict[str, Any]] = {}


def _make_gate(session_id: str):
    """The policy passed to run_events: True = this tool needs human approval."""
    def gate(tool_name: str, args: dict) -> bool:
        if tool_name not in GATED_TOOLS:
            return False
        return tool_name not in _session_allowlists.get(session_id, set())
    return gate


def resolve_approval(run_id: str, approval_id: str, decision: str) -> bool:
    """Deliver the human's decision to a waiting run (the approval endpoint calls
    this). Returns False if there is no matching pending approval (stale/unknown)."""
    pending = _pending_approvals.get(run_id)
    if not pending or pending["approval_id"] != approval_id:
        return False
    pending["decision"] = decision
    pending["event"].set()
    return True


def _await_decision(run_id, session_id, ev, events, stop_event) -> str:
    """Relay one gated tool call to the human and return the decision.

    Emits `approval_requested`, blocks the run thread until the endpoint resolves
    it (staying responsive to Stop — a stop bails to `deny`), records an
    `always_session` allowlist entry, emits `approval_resolved`, and returns
    `allow | deny | always_session`. Anything unexpected → `deny` (safe default)."""
    approval_id = uuid4().hex
    _pending_approvals[run_id] = {"approval_id": approval_id, "event": Event(), "decision": None}
    emit(events, "approval_requested", {
        "approval_id": approval_id, "run_id": run_id, "session_id": session_id,
        "tool_name": ev.tool_name, "args": ev.args,
    })
    pending = _pending_approvals[run_id]
    while not pending["event"].wait(timeout=0.5):
        if stop_event.is_set():
            break
    _pending_approvals.pop(run_id, None)

    decision = pending["decision"]
    if decision not in _APPROVAL_DECISIONS:
        decision = "deny"
    if decision == "always_session":
        _session_allowlists.setdefault(session_id, set()).add(ev.tool_name)
    emit(events, "approval_resolved", {"approval_id": approval_id, "decision": decision})
    return decision


@dataclass
class RunnerContext:
    """What a single run needs. Same shape main.py built for runner.py, minus the
    dead HTTP `client` field — the prover is now in-process."""

    session_id: str
    run_id: str
    task: str
    config: LeaConfig
    events: Queue[dict[str, Any]]
    project: dict[str, Any] | None = None
    # Autonomous (D19): no approval gate + the non-interactive `default` prompt
    # variant, so the run formalizes with zero human interaction (Overleaf path).
    autonomous: bool = False


def emit(events: Queue[dict[str, Any]], event_type: str, payload: dict[str, Any]) -> None:
    events.put({"type": event_type, "payload": payload})


# A run's final status. "success" means the agent passed the final verification
# gate — the theorem is actually proved (this is what drives the green "Proved"
# milestone in the UI). "answered" is a chat / QA / sketch-pause turn that
# finished cleanly but proved nothing — deliberately NOT "success", so the UI
# never marks a conversational turn as a completed proof.
_FINISH_STATUS = {
    "completed": "success",
    "assistant": "answered",
    "max_turns": "max_turns",
    "interrupted": "cancelled",
}


def _divergence_context(session_id: str, gs: GitStore) -> str | None:
    """Diff-on-divergence (D12): if the human edited the proof since the agent last
    acted, return a context block (the `git diff` + any edit notes) to fold into the
    next run's task — so the agent sees and acknowledges the changes (D13). None
    when nothing diverged (cold start, or no edits since the agent's last write)."""
    agent_step = store.latest_agent_code_step(session_id)
    if not agent_step:
        return None
    try:
        diff = gs.diff(session_id, agent_step["commit_sha"], "HEAD")
    except GitStoreError:
        return None
    if not diff.strip():
        return None

    parts = [
        "The human edited the proof files since your last turn. Here is the diff of their changes:",
        "```diff",
        diff.strip(),
        "```",
    ]
    notes = store.edit_notes_since(session_id, agent_step["seq"])
    if notes:
        parts.append("Their note(s) on the edit(s):")
        parts.extend(f"- {note}" for note in notes)
    parts.append("Acknowledge these changes before continuing.")
    return "\n".join(parts)


def _relativize(path: str, repo: Path) -> str:
    """A code_step's path is relative to the session repo (so `git show <sha>:<path>`
    resolves). The agent writes absolute paths under the per-session workspace
    (the prompt is pointed there), so this normally just strips the repo prefix;
    a path outside the repo (drift) falls back to its basename."""
    p = Path(path)
    try:
        return str(p.resolve().relative_to(repo.resolve()))
    except ValueError:
        return p.name


class _UsageByTurn:
    """Accumulate per-turn token/cost rows for run_usage_breakdown."""

    def __init__(self) -> None:
        self._rows: dict[int, dict[str, Any]] = {}

    def add(self, turn: int, input_tokens: int, output_tokens: int, cost: float) -> None:
        if not (input_tokens or output_tokens or cost):
            return
        row = self._rows.get(turn)
        if row is None:
            row = {
                "phase": "proof_turn" if turn else "preflight",
                "label": f"Turn {turn}" if turn else "Setup",
                "turn": turn or None,
                "input_tokens": 0,
                "output_tokens": 0,
                "cost_usd": 0.0,
                "event_count": 0,
            }
            self._rows[turn] = row
        row["input_tokens"] += input_tokens or 0
        row["output_tokens"] += output_tokens or 0
        row["cost_usd"] += cost or 0.0
        row["event_count"] += 1

    def rows(self) -> list[dict[str, Any]]:
        return [self._rows[k] for k in sorted(self._rows)]


def run_lea(context: RunnerContext) -> None:
    """Run one Lea activation, streaming normalized SSE events onto the queue.

    Always terminates the stream with a `done` event (the SSE endpoint breaks on
    it), even on failure — so the browser's EventSource never hangs.
    """
    events = context.events
    cfg = context.config
    if context.autonomous:
        # Autonomous (D19): swap the interactive collaborator prompt for the
        # `default` autoformalizer so the run never pauses to present a plan and
        # wait for confirmation. LeaConfig is frozen, so build a copy. The gate is
        # disabled separately below.
        cfg = replace(cfg, prompt_variant="default")
    session_id = context.session_id
    run_id = context.run_id

    if not active_run_lock.acquire(blocking=False):
        emit(events, "run_error", {"message": "Another Lea run is already active."})
        emit(events, "done", {"status": "failed"})
        return
    # We hold the slot — record which run is being driven so a second connection
    # for THIS run attaches passively instead of spawning a doomed competitor.
    _set_active_run_id(run_id)

    # Register (or adopt) this run's cooperative stop flag — the interrupt endpoint
    # may have created+set it already if Stop was hit before we got here (D18).
    stop_event = _stop_events.setdefault(run_id, Event())

    lea_root = cfg.lea_root or (Path(__file__).resolve().parents[2] / "prover")
    gs = GitStore(Path(lea_root) / "workspace" / "proofs")
    repo = gs.init_session(session_id)

    narration: list[str] = []
    current_turn = 0
    last_tool: str | None = None
    # The intent narration the model wrote just before its current tool call —
    # stamped onto the code step a write produces, so the UI can show "what this
    # write is trying to do" on the step card (M11).
    last_intent: str | None = None
    step_id_by_path: dict[str, str] = {}
    usage = _UsageByTurn()
    last_persisted: str | None = None
    final_status = "failed"

    def persist_assistant(text: str) -> None:
        nonlocal last_persisted
        text = text.strip()
        if not text or text == last_persisted:
            return
        last_persisted = text
        emit(events, "message", store.add_message(session_id, "assistant", text, run_id, kind="assistant"))

    def flush_narration() -> str:
        text = "".join(narration)
        narration.clear()
        persist_assistant(text)
        return text.strip()

    try:
        store.update_run(run_id, "running")
        # Multi-turn (D16): replay the session's prior conversation so a follow-up
        # continues with full context — the prover is stateless, so the adapter
        # feeds it the faithful transcript (tool_call/tool_result parts intact) of
        # the last Finished run, then the new user turn. A cold first run gets [].
        prior = store.latest_transcript_for_session(session_id, exclude_run_id=run_id) or []
        # Diff-on-divergence (D12): if the human edited the proof outside a run since
        # the agent last acted, prepend their diff (+ notes) to the task so the agent
        # works from the current canvas, not its stale memory.
        task_content = context.task
        divergence = _divergence_context(session_id, gs)
        if divergence:
            task_content = f"{divergence}\n\n{context.task}"
        messages = prior + [{"role": "user", "content": task_content}]

        # Drive the generator manually (not `for`): the per-tool gate (D19) is a
        # two-way exchange — the prover yields ToolApprovalRequested and we feed the
        # human's decision back via gen.send(). A plain for-loop can't send.
        # Autonomous (D19): gate=None → no tool ever pauses for human approval, so
        # the run is fully unattended. Interactive UI runs keep the per-tool gate.
        gen = run_events(cfg, messages, session_id=session_id, working_dir=str(repo),
                         should_stop=stop_event.is_set,
                         gate=(None if context.autonomous else _make_gate(session_id)))
        to_send = None
        while True:
            try:
                ev = gen.send(to_send)
            except StopIteration:
                break
            to_send = None

            if isinstance(ev, ToolApprovalRequested):
                to_send = _await_decision(run_id, session_id, ev, events, stop_event)
                continue

            if isinstance(ev, AssistantTextDelta):
                narration.append(ev.text)
                emit(events, "assistant_delta", {"text": ev.text})

            elif isinstance(ev, TurnStarted):
                flush_narration()
                current_turn = ev.turn

            elif isinstance(ev, ToolCalled):
                intent = flush_narration()
                # Only a *short* narration is a per-write "what I'm doing" label
                # (M11). A long one — e.g. the natural-language proof sketch the
                # collaborator leads with — must stay as prose in the thread and
                # never be folded into a step card, so we don't stamp it.
                if intent:
                    last_intent = intent if len(intent) <= 280 else None
                last_tool = ev.name
                emit(events, "status", {"status": "tool_call", "message": f"Running {ev.name}", "turn": current_turn})

            elif isinstance(ev, FileChanged):
                rel = _relativize(ev.path, repo)
                sha = gs.commit_write(session_id, turn=current_turn, author="agent", tool=last_tool or "write_file")
                step = store.add_code_step(
                    session_id, run_id, rel, commit_sha=sha, author="agent", turn=current_turn,
                    summary=last_intent,
                )
                step_id_by_path[rel] = step["id"]
                emit(events, "code_step", {**step, "code": gs.snapshot(session_id, sha, rel)})

            elif isinstance(ev, CheckResult):
                rel = _relativize(ev.path, repo)
                step_id = step_id_by_path.get(rel)
                if step_id:
                    updated = store.set_code_step_check(step_id, ev.status, ev.detail)
                    if updated:
                        emit(events, "code_step", {
                            **updated, "code": gs.snapshot(session_id, updated["commit_sha"], rel),
                        })
                emit(events, "status", {
                    "status": "lean_check", "message": f"lean_check: {ev.status}",
                    "turn": current_turn, "check_status": ev.status, "check_detail": ev.detail,
                })

            elif isinstance(ev, UsageUpdated):
                usage.add(current_turn, ev.input_tokens, ev.output_tokens, ev.cost)

            elif isinstance(ev, ToolResulted):
                pass  # display-only; the status chip + code steps already cover it

            elif isinstance(ev, Error):
                emit(events, "run_error", {"message": ev.message})

            elif isinstance(ev, Finished):
                flush_narration()
                persist_assistant(ev.text or "")
                final_status = _FINISH_STATUS.get(ev.reason, "success")
                store.update_run(
                    run_id, final_status, final_text=ev.text,
                    input_tokens=ev.usage.input_tokens, output_tokens=ev.usage.output_tokens,
                    cost_usd=ev.cost,
                )
                store.replace_run_usage_breakdown(run_id, usage.rows())
                # Persist the faithful conversation for the next activation to replay
                # (multi-turn, D16). Only here, on Finished — an errored run stores none.
                store.set_run_transcript(run_id, ev.transcript.get("messages", []))

    except Exception as exc:  # noqa: BLE001 — surface any failure as an error event, never hang the stream
        logger.exception("Lea run %s failed", run_id)
        flush_narration()
        emit(events, "run_error", {"message": f"{type(exc).__name__}: {exc}"})
        try:
            store.update_run(run_id, "failed")
        except Exception:
            logger.exception("Failed to mark run %s failed", run_id)
        final_status = "failed"
    finally:
        _stop_events.pop(run_id, None)
        _pending_approvals.pop(run_id, None)
        _set_active_run_id(None)
        active_run_lock.release()
        emit(events, "done", {"status": final_status})
