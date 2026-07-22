"""Run endpoints: start a run, stream its events (SSE), interrupt it, and answer
a per-tool approval. One run streams at a time (enforced in the bridge)."""

from __future__ import annotations

import asyncio
import json
from threading import Thread

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..config import load_config, permission_tier
from .. import bridge
from ..bridge import RunnerContext, run_lea, request_stop, request_subagent_stop
from .. import projects
from .. import runbroker
from .. import runregistry
from .. import settings as settings_service
from .. import store

router = APIRouter()


class RunRequest(BaseModel):
    message: str
    session_id: str | None = None
    # Autonomous run (D19): when true the run uses no per-tool approval gate and the
    # non-interactive `default` prompt variant, so it formalizes end-to-end with zero
    # human interaction (the Overleaf path). Defaults false → the interactive UI
    # behavior (gated tools + collaborator prompt) is unchanged.
    autonomous: bool = False
    # Project namespace (the Overleaf document slug). When present, a new session is
    # tagged with a project of this slug (created on first use) so per-document usage
    # can be aggregated for the Overleaf popover's "This project" total. Absent for
    # the interactive UI path, which stays project-less.
    project_slug: str | None = None
    project_title: str | None = None
    project_namespace: str | None = None
    # Session origin / providence. 'overleaf' (with `origin_url` = the canonical
    # Overleaf document URL) marks a formalization spawned from the Overleaf
    # extension, so the UI can show an origin indicator and open/focus the source
    # document. Omitted for the interactive UI path → the session defaults to 'ui'.
    # Independent of `project_slug` (usage namespacing) by design.
    origin: str | None = None
    origin_url: str | None = None


class ApprovalDecisionRequest(BaseModel):
    decision: str


def sse(event_type: str, payload: dict, seq: int | None = None) -> str:
    # A monotonic `id:` lets the browser's native EventSource reconnect resume via
    # `Last-Event-ID` (no re-replay). Manual reattach omits it and replays from 0.
    prefix = f"id: {seq}\n" if seq is not None else ""
    return f"{prefix}event: {event_type}\ndata: {json.dumps(payload)}\n\n"


def _request_cursor(request: Request) -> int:
    """Where to resume the broker stream from. The browser sends `Last-Event-ID` on a
    native reconnect (resume exactly); a manual (re)attach may pass `?since=N`;
    otherwise start at 0 and replay the whole buffer (client handlers dedupe)."""
    last = request.headers.get("last-event-id")
    if last and last.isdigit():
        return int(last)
    since = request.query_params.get("since")
    return int(since) if since and since.isdigit() else 0


async def _subscribe(broker: runbroker.RunBroker, cursor: int):
    """Tail a run's broker: replay everything after `cursor`, then follow live events
    until `done`. Any number of connections can do this at once, and a reconnect
    rejoins the LIVE stream — the whole point of the broker over the old per-connection
    queue. If the client disconnects, Starlette cancels this generator; the broker
    keeps buffering for everyone else."""
    while True:
        pending = broker.events_after(cursor)
        for event in pending:
            cursor = event["seq"]
            yield sse(event["type"], event["payload"], seq=event["seq"])
            if event["type"] == "done":
                return
        # Closed and fully drained → nothing more will ever arrive.
        if broker.closed and not broker.events_after(cursor):
            return
        await asyncio.sleep(0.08)


async def _passive_done(run_id: str):
    """Fallback for the rare race where a run reads active but its broker is already
    gone (driver hit its finally between our status check and here): emit one terminal
    `done` from the persisted status so the client settles instead of hanging."""
    for _ in range(36000):  # ~3h at 0.3s/iter; the browser re-tails if we time out
        current = store.get_run(run_id)
        if not current:
            yield sse("done", {"status": "failed"})
            return
        if current["status"] not in {"pending", "running"}:
            yield sse("done", {"status": current["status"]})
            return
        await asyncio.sleep(0.3)
    yield sse("done", {"status": "running"})


@router.post("/api/runs")
def create_run(request: RunRequest) -> dict:
    message = request.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message is required")

    config = load_config()
    if settings_service.spend_limit_reached(config.max_spend_usd):
        raise HTTPException(status_code=402, detail="Max spend limit has been reached.")

    # Resolve the project namespace (Overleaf path) so the session + run are tagged
    # and per-document usage can be summed. Invalid slugs are ignored rather than
    # failing the run (best-effort association).
    project_id: str | None = None
    if request.project_slug:
        # Provision identically to a UI project (D25): get-or-create the row AND seed the
        # on-disk repo's .lea/{instructions,memory,blueprint}.md if missing, so an
        # Overleaf-originated project isn't left doc-less. Best-effort + idempotent.
        proofs_root = (config.lea_root / "workspace" / "proofs") if config.lea_root else None
        try:
            project = projects.ensure_project(
                request.project_slug,
                proofs_root,
                title=request.project_title,
                namespace=request.project_namespace,
            )
            project_id = project["id"]
        except ValueError:
            project_id = None

    if request.session_id:
        session = store.get_session(request.session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        # Backfill the project on an existing session that has none yet (e.g. the
        # first tagged run for a session created project-less).
        if project_id and not session.get("project_id"):
            store.assign_session_project(session["id"], project_id)
        # A UI project session (D23) already carries its project_id; tag the run with
        # it so usage rolls up per project even without an Overleaf slug.
        if project_id is None and session.get("project_id"):
            project_id = session["project_id"]
    else:
        session = store.create_session(
            message,
            project_id=project_id,
            origin=(request.origin or "ui"),
            origin_url=request.origin_url,
        )

    # The run is autonomous (no gate + non-interactive prompt, D19) when the caller
    # forces it (the Overleaf path) OR the configured approval tier is "none". A UI
    # run with the default "stepwise" tier stays gated. Stored on the run, so the
    # events endpoint replays the same mode.
    autonomous = request.autonomous or (permission_tier() == "none")
    run = store.create_run(session["id"], config.model, None, config.max_turns,
                           project_id=project_id, autonomous=autonomous)
    user_message = store.add_message(session["id"], "user", message, run["id"])
    project = store.get_project(project_id) if project_id else None
    return {
        "session_id": session["id"],
        "run_id": run["id"],
        "message": user_message,
        "project_id": project_id,
        "project_slug": project["slug"] if project else None,
        "project_namespace": project["namespace"] if project else None,
    }


@router.get("/api/runs/{run_id}")
def get_run_row(run_id: str) -> dict:
    """The cheap run-row poll (v2.3 item 16). Returns just this run's outcome —
    id, lifecycle status, and terminal kind/detail — so a client waiting out a
    slot (the Overleaf companion, every ~3s) can decide retry-vs-resolve without
    paying a full session detail (messages + code_steps + status_events + usage)
    on every tick. 404 if the run id is unknown."""
    row = store.get_run_status(run_id)
    if not row:
        raise HTTPException(status_code=404, detail="Run not found")
    return row


@router.post("/api/runs/{run_id}/approvals/{approval_id}")
def resolve_approval(run_id: str, approval_id: str, request: ApprovalDecisionRequest) -> dict:
    """Answer a per-tool approval (D19): the human's allow / deny / always_session
    decision for a gated tool call (bash / write_file / edit_file). The bridge
    `.send()`s it into the paused run. 409 if the approval is stale/unknown (the
    run already moved on, e.g. a Stop bailed it)."""
    if request.decision not in {"allow", "deny", "always_session"}:
        raise HTTPException(status_code=422, detail="decision must be 'allow', 'deny', or 'always_session'")
    if not bridge.resolve_approval(run_id, approval_id, request.decision):
        raise HTTPException(status_code=409, detail="No pending approval matches this run/approval id")
    return {"status": "resolved", "decision": request.decision}


@router.post("/api/runs/{run_id}/interrupt")
def interrupt_run(run_id: str) -> dict:
    """Request a clean cooperative stop (D18). The agent checks the flag at the
    next turn boundary and ends with a committed file + accurate canvas — not a
    hard kill. Idempotent: setting an already-set flag is a no-op."""
    run = store.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run["status"] not in {"pending", "running"}:
        raise HTTPException(status_code=409, detail="Run is not active")
    request_stop(run_id)
    # A `pending` run that no runner is driving (created by POST /api/runs but its
    # events stream never attached — e.g. its client gave up waiting for a slot) has
    # nothing to read the stop flag; fail it directly so the session's derived status
    # doesn't show 'thinking' forever. This check is now *exact* (item 10): a run
    # absent from the registry provably has no driver, since admission happens at the
    # events endpoint before the runner thread is spawned. If a driver does exist, the
    # flag set above reaches it (D18) and it overwrites this status with a terminal one.
    if run["status"] == "pending" and not runregistry.registry.is_active(run_id):
        store.update_run(run_id, "failed", result_kind="failed",
                         result_detail="Interrupted before the run started.")
        return {"status": "interrupted"}
    return {"status": "interrupting"}


@router.post("/api/sub-agents/{session_id}/interrupt")
def interrupt_subagent(session_id: str) -> dict:
    """Stop a single running child sub-agent (D2), addressed by its child SESSION id —
    without cancelling the coordinator run that spawned it. The child returns its partial
    findings at its next turn boundary and the coordinator carries on. A no-op (404) if
    the child is not currently running in-process (nothing to signal)."""
    if request_subagent_stop(session_id):
        return {"status": "interrupting"}
    raise HTTPException(status_code=404, detail="No running sub-agent for that session")


async def _supersede_and_admit(run_id: str, session_id: str, incumbent_run_id: str):
    """Item 10 supersede: this is a NEW run for a session whose previous run still
    holds a slot. Ask that incumbent to stop (its approval wait + turn loop are
    stop-aware), then poll try_admit until the slot frees and this run is admitted.

    Per-session by construction — a different chat's run is never touched. Bounded
    (~15s, matching the old bridge supersede) so a wedged incumbent can't hang the
    request; the caller turns a timeout into a 409. Polls on asyncio.sleep so the
    event loop stays responsive while the incumbent winds down on its own thread."""
    request_stop(incumbent_run_id)
    admission = None
    for _ in range(50):  # ~15s at 0.3s/iter
        admission = runregistry.registry.try_admit(run_id, session_id)
        if admission.outcome != runregistry.SESSION_BUSY:
            return admission
        await asyncio.sleep(0.3)
    return admission


@router.get("/api/runs/{run_id}/events")
async def run_events(run_id: str, request: Request) -> StreamingResponse:
    run = store.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run["status"] not in {"pending", "running"}:
        raise HTTPException(status_code=409, detail="Run has already completed")

    session_id = run["session_id"]

    # A CHILD sub-agent run (E1 first-class) is driven INLINE by its coordinator, not
    # admitted as an independent run. So the events endpoint only TAILS it: subscribe to
    # its broker (fed by the coordinator forwarding the child's events) — never admit,
    # never spawn a driver, never require a task message. This is what lets a sub-agent's
    # own session view stream live, exactly like any run. If its broker is already gone
    # (finished between the status read and here), settle the client with a terminal done.
    child_session = store.get_session(session_id)
    if child_session and child_session.get("parent_id"):
        broker = runbroker.get(run_id)
        if broker is None:
            return StreamingResponse(_passive_done(run_id), media_type="text/event-stream")
        return StreamingResponse(
            _subscribe(broker, _request_cursor(request)), media_type="text/event-stream"
        )

    # Resolve the task BEFORE claiming a slot, so a 404 here can never leak an
    # admission (nothing between try_admit and the runner thread may raise).
    session = store.session_detail(session_id)
    if not session or not session["messages"]:
        raise HTTPException(status_code=404, detail="Run task not found")
    task = next(
        (m["content"] for m in reversed(session["messages"])
         if m["run_id"] == run_id and m["role"] == "user"),
        None,
    )
    if not task:
        raise HTTPException(status_code=404, detail="Run task not found")

    # Admission (v2.3 items 9/10): the check IS the claim, decided HERE — before any
    # runner thread is spawned — so there is no endpoint-peek-then-thread-claim TOCTOU.
    admission = runregistry.registry.try_admit(run_id, session_id)

    # A new turn for a session whose previous run still holds a slot: supersede that
    # incumbent (per-session; another chat's run is untouched), then admit this run.
    if admission.outcome == runregistry.SESSION_BUSY:
        admission = await _supersede_and_admit(run_id, session_id, admission.incumbent_run_id)

    # A second connection for a run already being driven — a reconnect after a
    # dropped stream, switching back to a running chat, or the lea-standalone UI
    # opening an Overleaf run the companion drives — rejoins the LIVE stream by
    # subscribing to the run's broker (replay from the cursor, then follow live). No
    # runner is spawned and no slot is held; the existing driver keeps publishing.
    # This is what makes a reattached view live instead of the old dead passive view.
    if admission.outcome == runregistry.ALREADY_ACTIVE:
        broker = runbroker.get(run_id)
        if broker is None:
            # Rare race: the driver hit its finally (dropped the broker) between our
            # status check and here. Settle the client with a terminal `done`.
            return StreamingResponse(_passive_done(run_id), media_type="text/event-stream")
        return StreamingResponse(
            _subscribe(broker, _request_cursor(request)), media_type="text/event-stream"
        )

    # The house is full and none of it is this run/session — an honest capacity 409
    # (not a doomed runner that emits done(failed) and drives a retry storm). Also the
    # path a supersede lands on if the incumbent never released within the timeout.
    if admission.outcome != runregistry.ADMITTED:
        detail = (
            f"Lea is at capacity ({admission.active}/{admission.capacity}). Try again shortly."
            if admission.outcome == runregistry.AT_CAPACITY
            else "A previous run is still finishing — try again in a moment."
        )
        raise HTTPException(status_code=409, detail=detail, headers={"Retry-After": "5"})

    # Admitted. The driver publishes to a broker (not this connection's queue), so its
    # lifecycle is decoupled from this request: if this client drops, the run keeps
    # going and a later connection rejoins the live stream. From here the slot MUST be
    # released — run_lea's finally releases it (and drops the broker) on every exit; if
    # the thread never starts, release + drop here so neither the claim nor the broker
    # can leak.
    broker = runbroker.create(run_id)
    context = RunnerContext(
        session_id=session_id,
        run_id=run_id,
        task=task,
        config=load_config(),
        events=broker,
        autonomous=bool(run.get("autonomous")),
    )
    try:
        thread = Thread(target=run_lea, args=(context,), daemon=True)
        thread.start()
    except BaseException:
        runregistry.registry.release(run_id)
        runbroker.drop(run_id)
        raise

    # This admitting connection is just the first subscriber (cursor 0 → from the top).
    return StreamingResponse(
        _subscribe(broker, _request_cursor(request)), media_type="text/event-stream"
    )
