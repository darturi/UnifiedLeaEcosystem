"""The prover seam — drives the vendored prover in-process and maps its typed
events onto the browser's SSE stream (architecture D1/D17).

This replaces the old ``runner.py``: there is no HTTP boundary and no loosely-typed
frame normalization. ``run_events()`` (imported as a library) yields *typed*
meaning-level events, so this is a flat ``isinstance`` dispatch:

  AssistantTextDelta -> assistant_delta      (narration, buffered)
  TurnStarted        -> flush narration into a `message`, mark the turn
  ToolCalled         -> flush narration, emit a status chip
  FileChanged        -> store the file's contents + insert a code_step
  CheckResult        -> back-fill that step's verdict
  UsageUpdated       -> accumulate per-turn token/cost rows
  Finished           -> terminal message + persist run + usage, then `done`

SQL owns proof content (C1/D7, inverted in v2.3): on every write the adapter reads
the file's after-state and stores it as a content-addressed blob, and the code_step
row points at that blob; the same bytes go out on the stream for the live canvas.
Content and pointer can't disagree because there is only one store. The verdict
lives on the row (D6) and is back-filled when ``lean_check`` returns.

Git is no longer the store — it stays only as *transport* for non-proof assets
(uploads, project files), which have their own path.

Scope (D1·bridge): single activation — ``messages = [{user: task}]``. Faithful
multi-turn transcript replay is D1·multiturn; the per-tool gate is D9/D10;
interrupt is D7; diff-on-divergence context is D6.
"""

from __future__ import annotations

import difflib
import logging
from dataclasses import dataclass, replace
from pathlib import Path
from queue import Queue
from threading import Event
from typing import Any

from uuid import uuid4

from lea.interface import (
    AssistantTextDelta,
    CheckResult,
    Error,
    FileChanged,
    Finished,
    SubagentFinished,
    ToolApprovalRequested,
    ToolCalled,
    ToolResulted,
    TurnStarted,
    UsageUpdated,
    check as _lean_check_file,
    run_events,
)

from .artifacts import classify_lean_artifact
from .config import LeaConfig
from .gitstore import GitStore, GitStoreError
from . import collation, projects, runbroker, runregistry, skills_catalog, store, uploads

logger = logging.getLogger("lea-interface.bridge")

# Admission — which run may start and whether there's room — now lives in
# `runregistry` (v2.3 items 9/10): one lock, an atomic check-that-is-the-claim,
# decided at the SSE endpoint *before* this module's run thread is spawned. That
# replaces the old split where the endpoint peeked an `_active_run_id` scalar while
# the real claim happened later here (an `active_run_lock.acquire` inside the thread)
# — a TOCTOU where two attaches both peeked None and both spawned. run_lea no longer
# holds a single-slot lock or a scalar; it releases its admitted slot in the finally.

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
    # Persist the pending approval onto the run row so it survives a stream drop,
    # a reconnect, or a session switch: `session_detail` re-surfaces
    # `active_run.pending_approval` and the UI rebuilds the same card. Without this
    # the approval lives ONLY in the one-shot `approval_requested` SSE event — a
    # client that missed it (reattached after it fired, or switched away and back)
    # waits forever with no card. The persisted bytes mirror the live event so the
    # rebuilt card is identical (same principle as the streamed/stored code rows).
    store.set_run_pending_approval(run_id, {
        "approval_id": approval_id, "tool_name": ev.tool_name, "args": ev.args,
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
    # Gate resolved → clear the persisted card so a reconnect doesn't re-raise a
    # decision the run has already consumed.
    store.set_run_pending_approval(run_id, None)
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
    # A rejoinable RunBroker in the live endpoint; a plain Queue in unit tests. Both
    # expose `.put({"type","payload"})`, which is all `emit()` needs.
    events: "runbroker.RunBroker | Queue[dict[str, Any]]"
    # Autonomous (D19): no approval gate + the non-interactive `default` prompt
    # variant, so the run formalizes with zero human interaction (Overleaf path).
    autonomous: bool = False


def emit(events: "runbroker.RunBroker | Queue[dict[str, Any]]",
         event_type: str, payload: dict[str, Any]) -> None:
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


def _read_after(path: str) -> str:
    """The file's contents after a write. Unreadable (deleted, binary, races with a
    later write) yields "" rather than raising: a code step whose content we failed
    to capture is still a step that happened, and the schema records that honestly
    via `content_lost` rather than losing the row."""
    try:
        return Path(path).read_text()
    except (OSError, UnicodeDecodeError):
        logger.debug("Could not read after-state of %s", path, exc_info=True)
        return ""


def _classify(code: str) -> str | None:
    """`classify_lean_artifact`, but a parse failure is not a run failure."""
    try:
        return classify_lean_artifact(code)
    except Exception:  # noqa: BLE001 — classification is a presentation detail
        return None


def _divergence_context(session_id: str, repo_key: str, gs: GitStore) -> str | None:
    """Diff-on-divergence (D12): if the human edited the proof since the agent last
    acted, return a context block (a diff + any edit notes) to fold into the next
    run's task — so the agent sees and acknowledges the changes (D13). None when
    nothing diverged (cold start, or no edits since the agent's last write).

    Scoped to the file the agent last wrote. It used to be a repo-wide
    `git diff <sha> HEAD`, which is wrong for a *shared* project repo (D24): an edit
    to any file in the project — including one belonging to a different session —
    reported as this session's divergence and got pasted into its task.

    The 'before' is the agent's last stored content and the 'after' is the file on
    disk, so this compares the two things it actually claims to compare. The old
    version compared two git revisions, and its `before` was only as good as a
    pointer nobody verified (see 0004's backfill: one such pointer named a commit
    whose tree never contained the file)."""
    agent_step = store.latest_agent_code_step(session_id)
    if not agent_step or not agent_step.get("path"):
        return None
    path = agent_step["path"]
    repo = gs.init_session(repo_key)
    before = agent_step.get("code") or ""
    after = _read_after(str(repo / path))
    if before == after:
        return None
    diff = "".join(
        difflib.unified_diff(
            before.splitlines(keepends=True), after.splitlines(keepends=True),
            fromfile=f"a/{path}", tofile=f"b/{path}",
        )
    )
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


def _with_subagents(cfg: LeaConfig) -> LeaConfig:
    """Return `cfg` with `spawn_subagent` added to the coordinator's toolset (item 24).

    `spawn_subagent` is registered `opt_in=True` in the prover, so an unfiltered toolset
    (`tools=None`) never contains it. The coordinator gets its normal default toolset —
    whatever `build_toolset(None)` resolves — PLUS spawn_subagent, named explicitly, so
    the model can delegate. Resolving the default at call time (not hard-coding the six
    built-ins) keeps this correct if the default set ever changes."""
    from lea.registry import build_toolset

    default_tools = [schema["name"] for schema in build_toolset(None)[0]]
    return replace(cfg, tools=[*default_tools, "spawn_subagent"])


def _text_from_content(content: Any) -> str:
    """Flatten a transcript message's `content` (a string, or a list of provider blocks)
    into plain text — the assistant prose, dropping tool-call/tool-result plumbing — so a
    child's exploration replays as ordinary chat in its read-only view."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [b["text"] for b in content if isinstance(b, dict) and isinstance(b.get("text"), str)]
        return "\n".join(p for p in parts if p.strip())
    return ""


def _subagent_child_title(ev: SubagentFinished) -> str:
    """A short, human title for the child session row.

    Prefer the delegated TASK — the description line the coordinator passed, which is the
    first line of the child's first user message. It's stable and meaningful even when the
    child errors or hits max turns (whose `summary` is an error nudge, not a description).
    Fall back to a non-error summary, then the role."""
    for msg in ev.transcript or []:
        if msg.get("role") == "user":
            task = _text_from_content(msg.get("content")).strip()
            first = task.splitlines()[0].strip() if task else ""
            if first:
                return first[:80]
            break
    summary = (ev.summary or "").strip()
    if summary and not summary.lower().startswith("error"):
        first = summary.splitlines()[0].strip()
        if first:
            return first[:80]
    return ev.subagent_type or "sub-agent"


def _materialize_subagent(
    ev: SubagentFinished,
    *,
    parent_session_id: str,
    project_id: str | None,
    turn: int,
    repo: Path,
) -> dict:
    """Persist a finished sub-agent as a CHILD session (item 24), returning its row.

    A child is a real session parented to the coordinator: its transcript is replayed
    into its own `timeline` (so it renders read-only through the ordinary session view),
    and its candidate file — read back from the child's scratch dir under the run's
    working tree — is stored as a code_step, so the child's *derived* status IS its
    lean_check verdict. The child transcript is NOT written onto the parent's timeline
    (it is the child's, not a coordinator code_step)."""
    child = store.create_session(
        _subagent_child_title(ev),
        project_id=project_id,
        parent_id=parent_session_id,
        role=ev.subagent_type,
        spawned_at_turn=turn,
    )
    child_id = child["id"]
    for msg in ev.transcript or []:
        text = _text_from_content(msg.get("content"))
        if text.strip():
            role = "user" if msg.get("role") == "user" else "assistant"
            store.add_message(child_id, role, text)
    if ev.candidate_path:
        cand = Path(ev.candidate_path)
        if not cand.is_absolute():
            cand = repo / cand
        try:
            content = cand.read_text()
        except OSError:
            content = None
        if content is not None:
            store.add_code_step(
                child_id, None, cand.name, content=content, author="agent", turn=turn,
                summary=(ev.summary or None),
                check_status=ev.check_status, check_detail=ev.check_detail,
                artifact_kind=_classify(content) if ev.check_status == "ok" else None,
            )
    return child


def _promote_winner(
    subagent_results: list[SubagentFinished],
    *,
    session_id: str,
    run_id: str,
    repo: Path,
    namespace: str | None,
    turn: int,
    events,
) -> dict | None:
    """Deterministic collation (item 25): promote the best *compiling* sub-agent candidate
    as the coordinator's proof, and record it as a code_step — the compiler decides, not
    the model. Returns the promoted step, or None if nothing was promoted.

    The ranking is `collation`'s (lean_check clean > SafeVerify-rejected > error, ties by
    sorry-free / shorter). Only a clean candidate is promotable. Two safety rails make this
    safe to run automatically:

      * the caller only invokes this when the coordinator produced NO clean proof itself
        (so a promotion fills a gap, never clobbers the coordinator's own answer);
      * the winner is **re-verified at the canonical path** before it's recorded — the
        child's lean_check ran in its scratch dir, so we don't trust that verdict at a new
        location; if it doesn't re-verify clean, nothing is promoted (the coordinator's
        result stands) rather than recording an unchecked "ok".
    """
    if not subagent_results:
        return None
    candidates = [collation.candidate_from_event(ev, base_dir=repo) for ev in subagent_results]
    winner = collation.select_promotable(candidates)
    if winner is None or not winner.candidate_path:
        return None
    # The session's canonical proofs dir: its namespace path (loose → Lea/Misc).
    ns_path = (namespace or "Lea.Misc").replace(".", "/")
    canonical = repo / ns_path / Path(winner.candidate_path).name
    try:
        collation.promote(winner, canonical)
    except ValueError:
        return None
    # Re-verify at the NEW path — the child checked a different location.
    verdict = _lean_check_file(str(canonical))
    if verdict.status != "ok":
        logger.warning(
            "sub-agent candidate %s did not re-verify at %s (%s); not promoting",
            winner.result_id, canonical, verdict.detail,
        )
        return None
    rel = _relativize(str(canonical), repo)
    step = store.add_code_step(
        session_id, run_id, rel, content=winner.text or "", author="agent", turn=turn,
        summary=f"Promoted the winning sub-agent candidate ({winner.result_id}).",
        check_status="ok", check_detail=None,
        artifact_kind=_classify(winner.text or ""),
        provenance={"promoted_from": winner.result_id},
    )
    emit(events, "code_step", step)
    emit(events, "status", {
        "status": "promoted",
        "message": f"Promoted the winning sub-agent candidate ({winner.result_id}).",
        "turn": turn,
    })
    return step


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
    else:
        # Interactive coordinator (item 24): make `spawn_subagent` available so the
        # model can delegate parallel exploration to child sub-agents. The tool is
        # opt-in in the prover registry (off by default, so it never leaks into an
        # unfiltered toolset); the coordinator gets its normal default toolset PLUS
        # spawn_subagent, named explicitly. The model decides when to spawn; children
        # can't recurse (prover depth + toolset guards). Autonomous/Overleaf runs stay
        # single-agent for now.
        cfg = _with_subagents(cfg)
    session_id = context.session_id
    run_id = context.run_id

    # Admission (which run may start, and whether there's room) already happened at
    # the endpoint (runregistry.try_admit) before this thread was spawned. run_lea no
    # longer acquires a slot — it owns the one it was admitted into and releases it in
    # the finally. Crucially the whole body, INCLUDING the setup that used to sit
    # outside the try, now runs inside one guarded region: a throw in setup releases
    # the slot instead of leaking it forever (v2.3 items 4/9).

    # Register (or adopt) this run's cooperative stop flag — the interrupt endpoint
    # may have created+set it already if Stop was hit before we got here (D18).
    stop_event = _stop_events.setdefault(run_id, Event())

    # Per-run temp dir holding materialized skill .md files (W3/D48); None until
    # resolved inside the try. Declared before it so the `finally` can always clean up.
    skills_tempdir: str | None = None

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
    # Finished sub-agents (item 24), in the order they completed — surfaced as child
    # sessions and kept for the collation pass (item 25) on the coordinator's Finished.
    subagent_results: list[SubagentFinished] = []
    # Whether the coordinator ITSELF produced a clean (non-scratch) proof this run. If it
    # did, the collation pass leaves it alone; if it didn't, the best compiling child
    # candidate is promoted to fill the gap (item 25).
    produced_clean = False
    last_persisted: str | None = None
    # Declared before the try so the finally's `done` event always has them, even if
    # setup throws before the run reaches its Finished handler.
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
                # The file on disk *is* the after-state — the prover has already
                # written it. Reading it here is what makes the stored content and
                # the streamed snapshot the same bytes by construction, rather than
                # two derivations of it that can disagree (the old path committed to
                # git, then asked git what it had committed).
                step = store.add_code_step(
                    session_id, run_id, rel, content=_read_after(ev.path),
                    author="agent", turn=current_turn, summary=last_intent,
                )
                step_id_by_path[rel] = step["id"]
                emit(events, "code_step", step)  # already carries `code`

            elif isinstance(ev, CheckResult):
                rel = _relativize(ev.path, repo)
                step_id = step_id_by_path.get(rel)
                if step_id is None:
                    # A file this run never wrote through write_file/edit_file — a
                    # bash-written file, or one checked before its first write. It
                    # has no step from this run to back-fill, so the verdict had
                    # nowhere to go and was dropped. Record the check against the
                    # file's current content instead: a verdict with no step is a
                    # result the user never sees.
                    step = store.add_code_step(
                        session_id, run_id, rel, content=_read_after(ev.path),
                        author="agent", turn=current_turn, summary=last_intent,
                        check_status=ev.status, check_detail=ev.detail,
                        artifact_kind=_classify(_read_after(ev.path)) if ev.status == "ok" else None,
                    )
                    step_id_by_path[rel] = step["id"]
                    if ev.status == "ok":
                        checked_artifact_kind = step.get("artifact_kind")
                        if "scratch" not in rel.lower():
                            produced_clean = True
                    emit(events, "code_step", step)
                else:
                    artifact_kind = None
                    if ev.status == "ok":
                        current_step = store.latest_code_step_for_path(session_id, rel)
                        if current_step and current_step["id"] == step_id:
                            artifact_kind = _classify(current_step["code"])
                    updated = store.set_code_step_check(step_id, ev.status, ev.detail, artifact_kind=artifact_kind)
                    if updated:
                        if ev.status == "ok":
                            checked_artifact_kind = updated.get("artifact_kind") or _classify(updated["code"])
                            if "scratch" not in rel.lower():
                                produced_clean = True
                        emit(events, "code_step", updated)
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

            elif isinstance(ev, SubagentFinished):
                # A child sub-agent finished (item 24). Materialize it as a CHILD session
                # parented to this coordinator — its exploration replayed into its own
                # read-only timeline, its candidate stored as a code_step so the child's
                # derived status IS its lean_check verdict — then tell the browser so the
                # contextual Sub-agents block + the spawn node appear live. Keep the typed
                # result for the collation pass on Finished.
                subagent_results.append(ev)
                child = _materialize_subagent(
                    ev,
                    parent_session_id=session_id,
                    project_id=(project["id"] if project else None),
                    turn=current_turn,
                    repo=repo,
                )
                emit(events, "subagent_finished", {
                    "child_id": child["id"],
                    "parent_id": session_id,
                    "run_id": run_id,
                    "result_id": ev.result_id,
                    "subagent_type": ev.subagent_type,
                    "role": ev.subagent_type,
                    "turn": current_turn,
                    "title": child["title"],
                    "check_status": ev.check_status,
                    "check_detail": ev.check_detail,
                    "stop_reason": ev.stop_reason,
                    "summary": ev.summary,
                    "candidate_path": ev.candidate_path,
                })

            elif isinstance(ev, Error):
                emit(events, "run_error", {"message": ev.message})

            elif isinstance(ev, Finished):
                flush_narration()
                # Deterministic collation (item 25): if the coordinator delegated but
                # produced no clean proof of its own, promote the best compiling child
                # candidate as the session's proof (re-verified at the canonical path).
                # Runs BEFORE the artifact-result classification so the promoted verdict
                # settles the session's outcome. Never clobbers a clean coordinator proof.
                if not produced_clean and subagent_results:
                    promoted = _promote_winner(
                        subagent_results, session_id=session_id, run_id=run_id,
                        repo=repo, namespace=namespace, turn=current_turn, events=events,
                    )
                    if promoted:
                        checked_artifact_kind = promoted.get("artifact_kind") or checked_artifact_kind
                        produced_clean = True
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
        # Release the admission slot (paired with the endpoint's try_admit). Idempotent,
        # so a run that reaches here unadmitted — e.g. a direct unit-test call to
        # run_lea, which never goes through the endpoint — is a harmless no-op.
        runregistry.registry.release(run_id)
        done_payload = {"status": final_status}
        if final_result_kind:
            done_payload["result_kind"] = final_result_kind
        if final_result_detail:
            done_payload["result_detail"] = final_result_detail
        emit(events, "done", done_payload)
        # The run has ended: retire its broker so no new connection attaches to a
        # finished stream (a late reconnect is caught by the endpoint's terminal-status
        # 409). Subscribers still draining hold their own reference and exit on `done`.
        # Idempotent, so a direct unit-test call to run_lea (no broker) is a no-op.
        runbroker.drop(run_id)
