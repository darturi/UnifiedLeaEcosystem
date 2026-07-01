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

from .artifacts import classify_lean_artifact
from .config import LeaConfig
from .gitstore import GitStore, GitStoreError
from . import projects, skills_catalog, store, uploads

logger = logging.getLogger("lea-interface.bridge")

# Only one Lea activation may run at a time — they share the on-disk workspace
# and the warm LSP daemon. A new run doesn't queue or get rejected; it supersedes
# whatever holds the lock (most often a run parked on an unanswered approval whose
# event stream is gone), so the UI is never permanently blocked (M15).
active_run_lock = Lock()

# The run_id currently being driven (holding `active_run_lock`), or None. Lets the
# SSE endpoint tell "start + drive this run" apart from "a second viewer attaching
# to a run already in flight" (e.g. the lea-standalone UI opening an Overleaf run
# the companion is driving). Without this, every extra connection spawned another
# runner that lost the lock and emitted run_error+done(failed), which the UI's
# reconcile→reattach cycle turned into a request storm. Guarded by its own lock so
# reads from the async endpoint never tear against the run thread's write.
_active_run_guard = Lock()
_active_run_id: str | None = None  # the run currently holding active_run_lock


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
    # Autonomous (D19): no approval gate + the non-interactive `default` prompt
    # variant, so the run formalizes with zero human interaction (Overleaf path).
    autonomous: bool = False


def emit(events: Queue[dict[str, Any]], event_type: str, payload: dict[str, Any]) -> None:
    events.put({"type": event_type, "payload": payload})


# A run's final status. "proved" / "disproved" / "needs_review" are terminal
# checked-artifact outcomes. "answered" is a chat / QA / sketch-pause turn that
# finished cleanly but proved nothing, so the UI never marks a conversational turn
# as a completed proof.
_FINISH_STATUS = {
    "assistant": "answered",
    "max_turns": "max_turns",
    "interrupted": "cancelled",
}

_COMPLETED_RESULTS = {"proved", "disproved", "needs_review"}

def _finished_status(ev: Finished) -> str:
    if ev.reason == "completed":
        return ev.result_kind if ev.result_kind in _COMPLETED_RESULTS else "proved"
    return _FINISH_STATUS.get(ev.reason, "failed")


def _completed_artifact_result(ev: Finished, artifact_kind: str) -> tuple[str, str | None]:
    """Return persisted run status + result kind for a completed Lea artifact."""
    if ev.reason != "completed":
        return _finished_status(ev), None
    if ev.result_kind == "disproved":
        return "disproved", "disproved"
    if artifact_kind == "definition":
        return "proved", "defined"
    result_kind = ev.result_kind if ev.result_kind in _COMPLETED_RESULTS else "proved"
    return result_kind, result_kind


def _final_text_for_result(ev: Finished) -> str:
    text = ev.text or ""
    if ev.result_kind != "disproved":
        return text
    lower = text.lower()
    if "disprov" in lower or "counterexample" in lower or "not proven" in lower:
        return text
    prefix = (
        "Lea found a verified counterexample or disproof. "
        "The original theorem was not proven; the verified result shows the statement is false."
    )
    return f"{prefix}\n\n{text}".strip()


def _divergence_context(session_id: str, repo_key: str, gs: GitStore) -> str | None:
    """Diff-on-divergence (D12): if the human edited the proof since the agent last
    acted, return a context block (the `git diff` + any edit notes) to fold into the
    next run's task — so the agent sees and acknowledges the changes (D13). None
    when nothing diverged (cold start, or no edits since the agent's last write).

    The DB lookup keys on the real ``session_id``; the git diff keys on ``repo_key``
    (the resolved repo's dir name — D24), so a project session diffs its shared repo."""
    agent_step = store.latest_agent_code_step(session_id)
    if not agent_step:
        return None
    try:
        diff = gs.diff(repo_key, agent_step["commit_sha"], "HEAD")
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
        # A prior run still holds the lock — usually one parked on an approval
        # nobody answered (its event stream is gone). Supersede it: ask it to stop
        # (its approval wait + turn loop are stop-aware) and take over once it
        # releases, so starting a new run is never permanently blocked (M15).
        stuck = current_active_run_id()
        if stuck and stuck != run_id:
            request_stop(stuck)
        if not active_run_lock.acquire(timeout=15):
            emit(events, "run_error", {"message": "A previous run is still finishing — try again in a moment."})
            emit(events, "done", {"status": "failed"})
            return
    # We hold the slot — record which run is being driven so a second connection
    # for THIS run attaches passively instead of spawning a doomed competitor.
    _set_active_run_id(run_id)

    # Register (or adopt) this run's cooperative stop flag — the interrupt endpoint
    # may have created+set it already if Stop was hit before we got here (D18).
    stop_event = _stop_events.setdefault(run_id, Event())

    # Per-run temp dir holding materialized skill .md files (W3/D48); None until
    # resolved below. Declared before any setup that could throw so the `finally`
    # can always clean it up.
    skills_tempdir: str | None = None

    lea_root = cfg.lea_root or (Path(__file__).resolve().parents[2] / "prover")
    proofs_root = Path(lea_root) / "workspace" / "proofs"
    # Resolve the session's repo (D24): a project session writes the shared
    # proofs/Lea/<Project> repo; a loose session its own proofs/<session-id>. Root
    # the GitStore at the repo's parent and key by its dir name, so every
    # session-keyed primitive below operates on the right repo unchanged. The real
    # session_id still keys all DB rows.
    session = store.get_session(session_id)
    project = (
        store.get_project(session["project_id"])
        if session and session.get("project_id") else None
    )
    repo = projects.repo_for_session(session or {"id": session_id}, proofs_root, project)
    gs = GitStore(repo.parent)
    repo_key = repo.name
    gs.init_repo(repo)  # idempotent; a project repo already exists from provisioning
    # Guard the Overleaf .tex mirror so the agent compiling the document mid-run can't
    # get its build artifacts (.pdf/.synctex.gz/.aux/...) swept in by commit-on-write.
    if project:
        uploads.ensure_overleaf_gitignore(project, proofs_root)
    # Project namespace for the prompt (D32): None → the default Lea.Misc block.
    namespace = project["namespace"] if project else None
    # Skill resolution (W3/D48): a project run picks up the skills that resolve for
    # it (global ∪ assigned, D47), materialized to per-run temp .md files fed to the
    # prover via cfg.skills. Loose sessions resolve to none (project is None), so
    # cfg.skills stays empty — no behavior change on the loose path.
    if project:
        skill_paths, skills_tempdir = skills_catalog.materialize_project_skills(project["id"])
        if skill_paths:
            cfg = replace(cfg, skills=skill_paths)

    narration: list[str] = []
    current_turn = 0
    last_tool: str | None = None
    # The intent narration the model wrote just before its current tool call —
    # stamped onto the code step a write produces, so the UI can show "what this
    # write is trying to do" on the step card (M11).
    last_intent: str | None = None
    step_id_by_path: dict[str, str] = {}
    # The path of the most recent write_file/edit_file, captured at ToolCalled so the
    # ToolResulted handler can tell a project asset write (.lea/*.md) from a .lean
    # proof write (D33): the latter is a canvas snapshot via FileChanged; the former
    # is committed quietly and refreshes the project graph, never the canvas.
    last_write_path: str | None = None
    checked_artifact_kind = "unknown"
    usage = _UsageByTurn()
    last_persisted: str | None = None
    final_status = "failed"
    final_result_kind: str | None = None
    final_result_detail: str | None = None

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
        divergence = _divergence_context(session_id, repo_key, gs)
        if divergence:
            task_content = f"{divergence}\n\n{context.task}"
        # Project context (D25): prepend ONE composed message (instructions + memory +
        # blueprint + file inventory). Strip any stale copy from the replayed
        # transcript first, so exactly one — always current — leads the messages.
        # Loose runs: ctx is None and this is a no-op.
        ctx = projects.compose_context_message(project, repo) if project else None
        if ctx:
            prior = [m for m in prior if not projects.is_context_message(m)]
        messages = ([ctx] if ctx else []) + prior + [{"role": "user", "content": task_content}]

        # Drive the generator manually (not `for`): the per-tool gate (D19) is a
        # two-way exchange — the prover yields ToolApprovalRequested and we feed the
        # human's decision back via gen.send(). A plain for-loop can't send.
        # Autonomous (D19): gate=None → no tool ever pauses for human approval, so
        # the run is fully unattended. Interactive UI runs keep the per-tool gate.
        gen = run_events(cfg, messages, namespace=namespace, session_id=session_id,
                         working_dir=str(repo), should_stop=stop_event.is_set,
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
                last_write_path = ev.args.get("path") if ev.name in ("write_file", "edit_file") else None
                emit(events, "status", {"status": "tool_call", "message": f"Running {ev.name}", "turn": current_turn})

            elif isinstance(ev, FileChanged):
                rel = _relativize(ev.path, repo)
                sha = gs.commit_write(repo_key, turn=current_turn, author="agent", tool=last_tool or "write_file")
                step = store.add_code_step(
                    session_id, run_id, rel, commit_sha=sha, author="agent", turn=current_turn,
                    summary=last_intent,
                )
                step_id_by_path[rel] = step["id"]
                emit(events, "code_step", {**step, "code": gs.snapshot(repo_key, sha, rel)})

            elif isinstance(ev, CheckResult):
                rel = _relativize(ev.path, repo)
                step_id = step_id_by_path.get(rel)
                if step_id:
                    updated = store.set_code_step_check(step_id, ev.status, ev.detail)
                    if updated:
                        code = gs.snapshot(repo_key, updated["commit_sha"], rel)
                        if ev.status == "ok":
                            checked_artifact_kind = classify_lean_artifact(code)
                        emit(events, "code_step", {
                            **updated, "code": code,
                        })
                emit(events, "status", {
                    "status": "lean_check", "message": f"lean_check: {ev.status}",
                    "turn": current_turn, "check_status": ev.status, "check_detail": ev.detail,
                })

            elif isinstance(ev, UsageUpdated):
                usage.add(current_turn, ev.input_tokens, ev.output_tokens, ev.cost)

            elif isinstance(ev, ToolResulted):
                # A project asset write (D33): a non-.lean write_file/edit_file in a
                # project (e.g. .lea/blueprint.md). The prover emits FileChanged only
                # for .lean (A2), so this never became a canvas snapshot. Commit it
                # quietly (git add -A covers any file) and emit a light graph-refresh
                # signal — no code_step, no canvas pollution. .lean writes are handled
                # by FileChanged above, so they're excluded here.
                if (
                    project
                    and ev.name in ("write_file", "edit_file")
                    and last_write_path
                    and not str(last_write_path).endswith(".lean")
                ):
                    asset_rel = _relativize(last_write_path, repo)
                    sha = gs.commit_all(repo, f"agent {ev.name}: {asset_rel}")
                    emit(events, "project_updated", {
                        "project_id": project["id"], "path": asset_rel, "commit_sha": sha,
                    })
                last_write_path = None

            elif isinstance(ev, Error):
                emit(events, "run_error", {"message": ev.message})

            elif isinstance(ev, Finished):
                flush_narration()
                final_text = _final_text_for_result(ev)
                persist_assistant(final_text)
                final_status, result_kind = _completed_artifact_result(ev, checked_artifact_kind)
                final_result_kind = result_kind
                final_result_detail = None if result_kind == "defined" else ev.result_detail
                store.update_run(
                    run_id, final_status, final_text=final_text,
                    input_tokens=ev.usage.input_tokens, output_tokens=ev.usage.output_tokens,
                    cost_usd=ev.cost,
                    result_kind=result_kind, result_detail=final_result_detail,
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
        skills_catalog.cleanup(skills_tempdir)
        _stop_events.pop(run_id, None)
        _pending_approvals.pop(run_id, None)
        if current_active_run_id() == run_id:
            _set_active_run_id(None)
        active_run_lock.release()
        done_payload = {"status": final_status}
        if final_result_kind:
            done_payload["result_kind"] = final_result_kind
        if final_result_detail:
            done_payload["result_detail"] = final_result_detail
        emit(events, "done", done_payload)
