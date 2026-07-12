"""Run endpoints: create (enqueue) a run, observe its events (SSE), interrupt
it, and answer a per-tool approval.

Lifecycle (PLAN-system-hardening Phase 2): POST /api/runs enqueues; the
bridge's single FIFO worker drives runs one at a time. GET /events is a pure
observer — attach any time, any number of times: a queued run streams `queued`
frames, a live run replays what was already emitted then tails, a finished run
replays (or synthesizes) its history ending in `done`. There is no 409."""

from __future__ import annotations

import asyncio
import json
from queue import Empty

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..config import load_config, permission_tier
from .. import bridge
from ..bridge import request_stop
from .. import projects
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


def sse(event_type: str, payload: dict) -> str:
    return f"event: {event_type}\ndata: {json.dumps(payload)}\n\n"


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
    # Enqueue immediately (Phase 2): the run starts when the FIFO worker
    # reaches it, not when a client happens to attach its event stream.
    bridge.enqueue_run(run["id"])
    project = store.get_project(project_id) if project_id else None
    return {
        "session_id": session["id"],
        "run_id": run["id"],
        "message": user_message,
        "project_id": project_id,
        "project_slug": project["slug"] if project else None,
        "project_namespace": project["namespace"] if project else None,
        "queue_position": store.queue_position(run["id"]),
    }


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
    # A `pending` run is queued, not executing — there is no runner to read the
    # stop flag, so fail it directly (dequeue-by-status: the worker skips
    # non-pending runs) and seal its event stream so any attached observers get
    # their terminal frame instead of waiting forever. The flag was still set
    # above: if the worker picked it up in this same instant, it adopts the
    # pre-set flag (D18), stops cooperatively, and overwrites this status with
    # its own terminal one.
    if run["status"] == "pending" and bridge.current_active_run_id() != run_id:
        store.update_run(run_id, "failed", result_kind="failed",
                         result_detail="Interrupted before the run started.")
        bridge.publish_terminal_from_row(run_id)
        return {"status": "interrupted"}
    return {"status": "interrupting"}


@router.get("/api/runs/{run_id}/events")
async def run_events(run_id: str) -> StreamingResponse:
    """Pure observer (Phase 2): attaching never starts, restarts, or competes
    with a run. Replays what the hub already buffered, then tails live events;
    a queued run announces its position first; a terminal run that predates
    the hub (older process, trimmed buffer) gets a `done` synthesized from its
    persisted row. Multiple concurrent observers are fine."""
    run = store.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    replay, live = bridge.attach(run_id)
    queue_position = store.queue_position(run_id)

    async def stream_events():
        try:
            if queue_position is not None and not replay:
                yield sse("queued", {"run_id": run_id, "position": queue_position})
            for item in replay:
                yield sse(item["type"], item["payload"])
                if item["type"] == "done":
                    return
            if live is None:
                # Terminal run with no buffered history: synthesize the
                # terminal frame from the persisted row so every attach still
                # ends in `done` (the old contract 409'd here).
                current = store.get_run(run_id) or run
                payload = {"status": current["status"]}
                if current.get("result_kind"):
                    payload["result_kind"] = current["result_kind"]
                if current.get("result_detail"):
                    payload["result_detail"] = current["result_detail"]
                yield sse("done", payload)
                return
            while True:
                try:
                    item = live.get_nowait()
                except Empty:
                    await asyncio.sleep(0.1)
                    continue
                yield sse(item["type"], item["payload"])
                if item["type"] == "done":
                    return
        finally:
            if live is not None:
                bridge.detach(run_id, live)

    return StreamingResponse(stream_events(), media_type="text/event-stream")
